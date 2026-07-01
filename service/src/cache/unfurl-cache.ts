/**
 * cache/unfurl-cache.ts — Redis 2단계 조회 + SWR + single-flight (platform §(c) / §3-2·§3-3)
 *
 * 조회 오케스트레이션(platform §(c) 의사코드를 실제 구현):
 *   L1 LRU → og:map:{norm} → payload_key → og:pl:{payload_key}
 *     ├ fresh → hit  ├ stale → 즉시 반환 + 백그라운드 갱신(SWR)  ├ neg → 실패 반환
 *   MISS → single-flight lock(og:lock:{norm}) → crawl → payload/map/역방향map write + Postgres
 *          락 실패 → 짧게 대기 후 캐시 재조회(coalescing)
 *
 * 이 레이어가 요청 단위 og_crawl_total{status,error_code,strategy,cache} counter 를 소유한다
 *   (cache 상태를 아는 유일 지점, §8/§3 카디널리티 규율 준수 — domain 라벨 없음).
 */

import { CONFIG } from '../config.js';
import type { CacheState, FetchResult, FetchStrategy } from '../types.js';
import type { Metrics } from '../metrics/instrumentation.js';
import { NoopMetrics } from '../metrics/instrumentation.js';
import { randomUUID } from 'node:crypto';
import type { CrawlStore } from '../persistence/postgres.js';
import { InMemoryCrawlStore, attemptFromResult } from '../persistence/postgres.js';
import { fetchOg, type OrchestratorDeps } from '../orchestrator.js';
import { domainOf } from '../url/domain.js';
import { normalizeUrl } from '../url/normalize.js';
import {
  lock_key,
  map_key,
  neg_key,
  payload_key,
  payload_key_of,
  short_map_key,
} from './keys.js';

/** 캐시 클라이언트 포트 — ioredis 어댑터 또는 인메모리 스텁으로 주입. */
export interface CacheClient {
  get(key: string): Promise<string | null>;
  setEx(key: string, value: string, ttlSec: number): Promise<void>;
  /** SET NX EX — 새로 설정되면 true. single-flight 락용. */
  setNx(key: string, value: string, ttlSec: number): Promise<boolean>;
  del(key: string): Promise<void>;
}

/** 저장 엔벨로프 — 논리 TTL 기반 신선도 판정을 위해 fetched_at/ttl 동봉. */
interface CachedPayload {
  result: FetchResult;
  fetched_at_ms: number;
  ttl_sec: number;
}
interface NegPayload {
  error_code: string;
  message: string;
  cached_at_ms: number;
}

export interface UnfurlCacheDeps extends OrchestratorDeps {
  redis: CacheClient;
  metrics?: Metrics;
  store?: CrawlStore;
}

// ── L1 인메모리 LRU (platform §1-2, Redis 홉조차 생략) ──
class LruTtl<V> {
  private map = new Map<string, { v: V; exp: number }>();
  constructor(private max: number, private ttlMs: number) {}
  get(k: string): V | undefined {
    const e = this.map.get(k);
    if (!e) return undefined;
    if (Date.now() > e.exp) {
      this.map.delete(k);
      return undefined;
    }
    // LRU 갱신
    this.map.delete(k);
    this.map.set(k, e);
    return e.v;
  }
  set(k: string, v: V): void {
    if (this.map.size >= this.max) {
      const first = this.map.keys().next().value;
      if (first !== undefined) this.map.delete(first);
    }
    this.map.set(k, { v, exp: Date.now() + this.ttlMs });
  }
}

export class UnfurlCache {
  private l1 = new LruTtl<CachedPayload>(CONFIG.L1_MAX_ENTRIES, CONFIG.L1_TTL_MS);
  private redis: CacheClient;
  private metrics: Metrics;
  private store: CrawlStore;
  private orchDeps: OrchestratorDeps;

  constructor(deps: UnfurlCacheDeps) {
    this.redis = deps.redis;
    this.metrics = deps.metrics ?? new NoopMetrics();
    this.store = deps.store ?? new InMemoryCrawlStore();
    this.orchDeps = {
      ...deps,
      metrics: this.metrics,
      store: this.store,
      // short-link 캐시 단락을 캐시 레이어가 제공(crawl §2.2)
      shortMapGet: (norm) => this.redis.get(short_map_key(norm)),
    };
  }

  /** completeness/에러 기반 TTL (crawl §3.2 소비 규약 / platform §3-3). */
  private ttlFor(result: FetchResult): number {
    // 규칙 오버라이드 우선(ttl_override_sec는 규칙 해석 시점에 result엔 없으므로 EXTENSION로 표기)
    if (result.status === 'failed') {
      const code = result.error_code ?? 'UNKNOWN';
      return code === 'HTTP_5XX' || code.includes('TIMEOUT')
        ? CONFIG.NEG_TTL_5XX_SEC
        : CONFIG.NEG_TTL_4XX_SEC;
    }
    if (result.completeness >= CONFIG.COMPLETE_THRESHOLD) return CONFIG.DEFAULT_TTL_SEC;
    return CONFIG.MIN_TTL_SEC; // 부분 결과 짧게(재시도 여지)
  }

  private freshness(cp: CachedPayload): 'fresh' | 'stale' | 'expired' {
    const age = (Date.now() - cp.fetched_at_ms) / 1000;
    if (age < cp.ttl_sec) return 'fresh';
    if (age < cp.ttl_sec * (1 + CONFIG.SWR_WINDOW_RATIO)) return 'stale';
    return 'expired';
  }

  private record(result: FetchResult, cache: CacheState): void {
    this.metrics.crawlTotal({
      status: result.status,
      error_code: result.error_code ?? 'none',
      strategy: result.fetch_strategy,
      cache,
    });
    this.metrics.crawlLatency(result.latency_ms / 1000, {
      strategy: result.fetch_strategy,
      cache,
    });
  }

  /**
   * get_unfurl(raw) — platform §(c) 조회 오케스트레이션.
   * @param refresh true면 캐시 무시하고 재크롤(platform §2-1 refresh=true).
   */
  async getUnfurl(
    raw: string,
    opts: { refresh?: boolean } = {},
  ): Promise<{ result: FetchResult; cache: CacheState; ttl_sec: number }> {
    let norm: string;
    try {
      norm = normalizeUrl(raw);
    } catch {
      const failed = await this.crawlAndStore(raw); // INVALID_URL 경로도 통일 처리
      return { result: failed.result, cache: 'miss', ttl_sec: failed.ttl };
    }

    if (!opts.refresh) {
      // L1
      const l1 = this.l1.get(map_key(norm));
      if (l1 && this.freshness(l1) === 'fresh') {
        this.record(l1.result, 'hit');
        return { result: { ...l1.result, cache: { short_link_cached: false } }, cache: 'hit', ttl_sec: l1.ttl_sec };
      }

      // L2 매핑 → payload
      const pk = await this.redis.get(map_key(norm));
      if (pk) {
        const rawPayload = await this.redis.get(payload_key(pk));
        if (rawPayload) {
          const cp = JSON.parse(rawPayload) as CachedPayload;
          const fresh = this.freshness(cp);
          if (fresh === 'fresh') {
            this.l1.set(map_key(norm), cp);
            this.record(cp.result, 'hit');
            return { result: cp.result, cache: 'hit', ttl_sec: cp.ttl_sec };
          }
          if (fresh === 'stale') {
            // SWR: 즉시 반환 + 백그라운드 갱신
            this.triggerBgRefresh(raw, norm);
            this.record(cp.result, 'stale');
            return { result: cp.result, cache: 'stale', ttl_sec: cp.ttl_sec };
          }
        }
      }

      // negative cache
      const neg = await this.redis.get(neg_key(norm));
      if (neg) {
        const np = JSON.parse(neg) as NegPayload;
        const result = this.negToResult(raw, norm, np);
        this.record(result, 'negative');
        return { result, cache: 'negative', ttl_sec: CONFIG.NEG_TTL_4XX_SEC };
      }
    }

    // ── MISS: single-flight lock ──
    const acquired = await this.redis.setNx(lock_key(norm), '1', CONFIG.LOCK_TTL_SEC);
    if (acquired) {
      try {
        const { result, ttl } = await this.crawlAndStore(raw);
        this.record(result, 'miss');
        return { result, cache: 'miss', ttl_sec: ttl };
      } finally {
        await this.redis.del(lock_key(norm)).catch(() => {});
      }
    }

    // 락 실패(다른 요청이 크롤 중) → 짧게 대기 후 캐시 재조회(coalescing)
    for (let i = 0; i < 20; i++) {
      await sleep(100);
      const pk = await this.redis.get(map_key(norm));
      if (pk) {
        const rawPayload = await this.redis.get(payload_key(pk));
        if (rawPayload) {
          const cp = JSON.parse(rawPayload) as CachedPayload;
          this.record(cp.result, 'hit');
          return { result: cp.result, cache: 'hit', ttl_sec: cp.ttl_sec };
        }
      }
      const neg = await this.redis.get(neg_key(norm));
      if (neg) {
        const np = JSON.parse(neg) as NegPayload;
        const result = this.negToResult(raw, norm, np);
        this.record(result, 'negative');
        return { result, cache: 'negative', ttl_sec: CONFIG.NEG_TTL_4XX_SEC };
      }
    }
    // 끝내 못 받으면 직접 크롤(락 홀더 죽음 대비)
    const { result, ttl } = await this.crawlAndStore(raw);
    this.record(result, 'miss');
    return { result, cache: 'miss', ttl_sec: ttl };
  }

  /** 크롤 실행 + 캐시/DB 기록. */
  private async crawlAndStore(raw: string): Promise<{ result: FetchResult; ttl: number }> {
    const result = await fetchOg(raw, this.orchDeps);
    const ttl = this.ttlFor(result);
    const norm = result.normalized_url;
    const traceId = randomUUID();

    if (result.status === 'failed') {
      // 실패 시도의 crawl_attempts append + failed_crawls UPSERT는 orchestrator.fail 내부에서
      // 이미 수행됨(단일 writeAttempt 경로) → 여기선 negative cache 파생만.
      const np: NegPayload = {
        error_code: result.error_code ?? 'UNKNOWN',
        message: '',
        cached_at_ms: Date.now(),
      };
      await this.redis.setEx(neg_key(norm), JSON.stringify(np), ttl).catch(() => {});
    } else {
      // ★ 정본 append: 성공(ok/partial) 시도도 crawl_attempts에 1행(통합 §3-bis).
      await this.store
        .writeAttempt(
          attemptFromResult(result, {
            trace_id: traceId,
            cache: 'miss', // 방금 크롤한 시도
            worker_id: this.orchDeps.workerId ?? 'w-cache',
            rule_version: 0,
          }),
        )
        .catch(() => {});
      // payload_key = normalize(canonical ?? og:url ?? final) — QA #4
      const pk = payload_key_of(result.canonical_url, result.og.url, result.final_url);
      const cp: CachedPayload = { result, fetched_at_ms: Date.now(), ttl_sec: ttl };
      const physicalTtl = Math.ceil(ttl * (1 + CONFIG.SWR_WINDOW_RATIO)); // SWR 창까지 물리 보관
      const payloadJson = JSON.stringify(cp);
      await Promise.all([
        this.redis.setEx(payload_key(pk), payloadJson, physicalTtl),
        this.redis.setEx(map_key(norm), pk, CONFIG.MAP_TTL_SEC),
        // 역방향 수렴: final_url 로 직접 들어와도 같은 payload
        this.redis.setEx(map_key(normalizeSafe(result.final_url)), pk, CONFIG.MAP_TTL_SEC),
      ]).catch(() => {});
      this.l1.set(map_key(norm), cp);

      // 단축링크 short→final 매핑 저장(긴 TTL)
      if (result.cache.short_link_cached === false && result.final_url !== norm && result.redirect_chain.length) {
        await this.redis.setEx(short_map_key(norm), result.final_url, CONFIG.SHORT_MAP_TTL_SEC).catch(() => {});
      }

      // 파생: Postgres 최신 성공 payload 사본(crawls) — crawl_attempts와 trace_id로 상관.
      await this.store
        .writeCrawl({
          trace_id: traceId,
          norm_url: norm,
          payload_key: pk,
          result,
          domain: domainOf(result.final_url),
          rule_version: 0,
          ttl_seconds: ttl,
        })
        .catch(() => {});
    }
    return { result, ttl };
  }

  /** SWR 백그라운드 갱신(fire-and-forget). */
  private triggerBgRefresh(raw: string, norm: string): void {
    // 갱신도 single-flight — 중복 백그라운드 크롤 방지
    void (async () => {
      const acquired = await this.redis
        .setNx(lock_key(norm), '1', CONFIG.LOCK_TTL_SEC)
        .catch(() => false);
      if (!acquired) return;
      try {
        await this.crawlAndStore(raw);
      } catch {
        /* 백그라운드 실패는 다음 요청에서 재시도 */
      } finally {
        await this.redis.del(lock_key(norm)).catch(() => {});
      }
    })();
  }

  private negToResult(raw: string, norm: string, np: NegPayload): FetchResult {
    return {
      input_url: raw,
      normalized_url: norm,
      final_url: norm,
      canonical_url: norm,
      redirect_chain: [],
      fetch_strategy: 'static',
      status: 'failed',
      error_code: (np.error_code as FetchResult['error_code']) ?? 'UNKNOWN',
      http_status: null,
      content_type: null,
      completeness: 0,
      richness: 0,
      og: {
        title: null, description: null, image: null, images: [], image_width: null,
        image_height: null, site_name: null, type: null, url: null, locale: null,
      },
      source_map: {},
      fetched_at: new Date(np.cached_at_ms).toISOString(),
      latency_ms: 0,
      cache: { short_link_cached: false },
    };
  }
}

function normalizeSafe(u: string): string {
  try {
    return normalizeUrl(u);
  } catch {
    return u;
  }
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 개발/스모크용 인메모리 CacheClient. 실제 배포는 ioredis 어댑터로 교체(EXTENSION). */
export class InMemoryCacheClient implements CacheClient {
  private map = new Map<string, { v: string; exp: number }>();
  async get(key: string): Promise<string | null> {
    const e = this.map.get(key);
    if (!e) return null;
    if (Date.now() > e.exp) {
      this.map.delete(key);
      return null;
    }
    return e.v;
  }
  async setEx(key: string, value: string, ttlSec: number): Promise<void> {
    this.map.set(key, { v: value, exp: Date.now() + ttlSec * 1000 });
  }
  async setNx(key: string, value: string, ttlSec: number): Promise<boolean> {
    const e = this.map.get(key);
    if (e && Date.now() <= e.exp) return false;
    this.map.set(key, { v: value, exp: Date.now() + ttlSec * 1000 });
    return true;
  }
  async del(key: string): Promise<void> {
    this.map.delete(key);
  }
}

/*
 * ioredis 어댑터 예시(EXTENSION):
 *
 * import Redis from 'ioredis';
 * export class IoredisCacheClient implements CacheClient {
 *   constructor(private r = new Redis(CONFIG.REDIS_URL)) {}
 *   get = (k) => this.r.get(k);
 *   setEx = async (k, v, ttl) => { await this.r.set(k, v, 'EX', ttl); };
 *   setNx = async (k, v, ttl) => (await this.r.set(k, v, 'EX', ttl, 'NX')) === 'OK';
 *   del = async (k) => { await this.r.del(k); };
 * }
 */
