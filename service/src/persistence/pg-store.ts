/**
 * persistence/pg-store.ts — 실제 Postgres 어댑터 (`pg`) + 선택 팩토리
 *
 * 기존 CrawlStore 포트(postgres.ts)의 실 구현체. 통합 §3-bis 저장 모델을 SQL 로 옮긴다:
 *   - crawl_attempts : 모든 시도(ok/partial/failed) append-only(정본). writeAttempt() 단일 경로.
 *   - failed_crawls  : (domain,error_code,final_url) UPSERT 롤업(occurrences++). §5-1 top-N 파생.
 *   - crawls         : 최신 성공 payload JSONB 내구 사본(캐시 재구축/프리워밍). 파생.
 *   - dlq            : 재처리 실패 격리.
 *   - domain_rules   : per-domain 규칙 조회(DomainRuleProvider). §1-2 확정 스키마 1:1.
 *   + deltaByRuleVersion(): reliability-ops §5-5 규칙 전후 성공률 델타 집계 쿼리(단일 소스).
 *
 * DDL 은 migrations/001_init.sql 이 소유(이 파일은 소비만). 어댑터 메서드는 트랜스포트 예외를
 *   삼킨다 — orchestrator.fail() 이 writeAttempt/upsertFailedCrawl 을 unwrapped await 하므로,
 *   여기서 던지면 크롤 경로 전체가 500 이 된다. 관측 쓰기 실패가 추출 가용성을 깨선 안 된다.
 *
 * `pg` 는 typecheck 시점에 미설치일 수 있어(옵션 배선) 동적 import(`import('pg' as string)`)로 로드.
 *   → 실 의존성 없이도 tsc/smoke 가 통과한다는 불변식 유지.
 */

import { ERROR_META } from '../errors/taxonomy.js';
import {
  DEFAULT_DOMAIN_RULE,
  StaticSeedRuleProvider,
  type DomainRule,
  type DomainRuleProvider,
} from '../rules/domain-rules.js';
import {
  InMemoryCrawlStore,
  type CrawlAttemptRecord,
  type CrawlRecord,
  type CrawlStore,
  type FailedCrawlRecord,
} from './postgres.js';
import type { ErrorCode } from '../errors/taxonomy.js';

// ── `pg` 최소 구조 타입(설치 여부 무관 typecheck) ──
interface QueryResultLike<R = Record<string, unknown>> {
  rows: R[];
  rowCount: number | null;
}
export interface PoolLike {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResultLike<R>>;
  end(): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): void;
}
type PoolCtor = new (config: Record<string, unknown>) => PoolLike;

/** pg Pool 생성 + SELECT 1 probe. 실패 시 throw(팩토리가 인메모리로 강등). */
export async function createPool(url: string, opts: { max?: number } = {}): Promise<PoolLike> {
  const mod = (await import('pg' as string)) as { default?: { Pool: PoolCtor }; Pool?: PoolCtor };
  const Pool: PoolCtor = (mod.Pool ?? mod.default?.Pool) as PoolCtor;
  if (!Pool) throw new Error('pg 모듈에서 Pool 을 찾지 못함');
  const pool = new Pool({
    connectionString: url,
    max: opts.max ?? 10,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 30_000,
    // ASSUMPTION: 로컬/컴포즈 기본은 sslmode 없음. 관리형 DB 는 DATABASE_URL 에 ?sslmode=require.
  });
  pool.on('error', () => {
    /* 유휴 커넥션 에러 흡수 — 다음 query 가 새 커넥션 획득 */
  });
  await pool.query('SELECT 1');
  return pool;
}

/** CrawlStore 의 Postgres 구현체. */
export class PgCrawlStore implements CrawlStore {
  constructor(private pool: PoolLike) {}

  /** ★ 정본 append — 모든 시도 1행. UPDATE 없음(감사/델타의 단일 소스). */
  async writeAttempt(rec: CrawlAttemptRecord): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO crawl_attempts
           (trace_id, input_url, normalized_url, final_url, domain, status,
            error_code, error_class, stage, fetch_strategy, http_status, redirect_hops,
            completeness, cache, latency_ms, attempt_no, rule_version, worker_id, ts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [
          rec.trace_id, rec.input_url, rec.normalized_url, rec.final_url, rec.domain, rec.status,
          rec.error_code, rec.error_class, rec.stage, rec.fetch_strategy, rec.http_status, rec.redirect_hops,
          rec.completeness, rec.cache, rec.latency_ms, rec.attempt_no, rec.rule_version, rec.worker_id, rec.ts,
        ],
      );
    } catch (e) {
      this.warn('writeAttempt', e);
    }
  }

  /** 파생 — 최신 성공 payload 내구 사본(JSONB). */
  async writeCrawl(rec: CrawlRecord): Promise<void> {
    try {
      const r = rec.result;
      await this.pool.query(
        `INSERT INTO crawls
           (trace_id, norm_url, payload_key, final_url, canonical_url, domain,
            fetch_strategy, status, http_status, completeness, rule_version,
            payload, redirect_chain, fetched_at, ttl_seconds)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15)`,
        [
          rec.trace_id, rec.norm_url, rec.payload_key, r.final_url, r.canonical_url, rec.domain,
          r.fetch_strategy, r.status, r.http_status, r.completeness, rec.rule_version,
          JSON.stringify(r), JSON.stringify(r.redirect_chain), r.fetched_at, rec.ttl_seconds,
        ],
      );
    } catch (e) {
      this.warn('writeCrawl', e);
    }
  }

  /**
   * 파생 — failed_crawls UPSERT. (domain,error_code,final_url) 충돌 시 occurrences++ · last_seen 갱신.
   * final_url NULL 은 ''로 정규화(NULL 은 UNIQUE 에서 서로 distinct → 롤업이 깨짐).
   */
  async upsertFailedCrawl(rec: FailedCrawlRecord): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO failed_crawls
           (trace_id, domain, input_domain, error_code, error_class, stage,
            http_status, fetch_strategy, final_url, attempt_no, rule_version, worker_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,''),$10,$11,$12)
         ON CONFLICT (domain, error_code, final_url) DO UPDATE SET
           occurrences = failed_crawls.occurrences + 1,
           last_seen   = now(),
           attempt_no  = GREATEST(failed_crawls.attempt_no, EXCLUDED.attempt_no),
           http_status = EXCLUDED.http_status,
           error_class = EXCLUDED.error_class,
           stage       = EXCLUDED.stage,
           rule_version= EXCLUDED.rule_version,
           worker_id   = EXCLUDED.worker_id,
           resolved    = false`,
        [
          rec.trace_id, rec.domain, rec.input_domain, rec.error_code, rec.error_class, rec.stage,
          rec.http_status, rec.fetch_strategy, rec.final_url, rec.attempt_no, rec.rule_version, rec.worker_id,
        ],
      );
    } catch (e) {
      this.warn('upsertFailedCrawl', e);
    }
  }

  async enqueueDlq(rec: {
    trace_id: string;
    final_url: string;
    domain: string;
    error_code: ErrorCode;
    error_class: string;
    last_attempt_no: number;
  }): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO dlq (trace_id, final_url, domain, error_code, error_class, last_attempt_no)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [rec.trace_id, rec.final_url, rec.domain, rec.error_code, rec.error_class, rec.last_attempt_no],
      );
    } catch (e) {
      this.warn('enqueueDlq', e);
    }
  }

  /** 참조 집계(reliability-ops §5-1 top-N) — SQL GROUP BY domain,error_code. */
  async topFailures(limit = 30): Promise<Array<{ domain: string; error_code: string; fails: number }>> {
    try {
      const { rows } = await this.pool.query<{ domain: string; error_code: string; fails: string }>(
        `SELECT domain, error_code, SUM(occurrences)::bigint AS fails
           FROM failed_crawls
          WHERE resolved = false
          GROUP BY domain, error_code
          ORDER BY fails DESC
          LIMIT $1`,
        [limit],
      );
      return rows.map((r) => ({ domain: r.domain, error_code: r.error_code, fails: Number(r.fails) }));
    } catch (e) {
      this.warn('topFailures', e);
      return [];
    }
  }

  /**
   * 규칙 적용 전후 성공률 델타 (reliability-ops §5-5) — crawl_attempts 단일 소스에서 계산.
   * before = rule_version < threshold, after = rule_version >= threshold.
   */
  async deltaByRuleVersion(
    domain: string,
    threshold: number,
  ): Promise<{ before: { n: number; success_ratio: number }; after: { n: number; success_ratio: number } }> {
    const empty = { before: { n: 0, success_ratio: 0 }, after: { n: 0, success_ratio: 0 } };
    try {
      const { rows } = await this.pool.query<{ after: boolean; n: string; success_ratio: string | null }>(
        `SELECT (rule_version >= $2) AS after,
                COUNT(*)::bigint          AS n,
                AVG((status <> 'failed')::int)::float8 AS success_ratio
           FROM crawl_attempts
          WHERE domain = $1
          GROUP BY (rule_version >= $2)`,
        [domain, threshold],
      );
      const out = { before: { n: 0, success_ratio: 0 }, after: { n: 0, success_ratio: 0 } };
      for (const r of rows) {
        const bucket = r.after ? out.after : out.before;
        bucket.n = Number(r.n);
        bucket.success_ratio = r.success_ratio == null ? 0 : Number(r.success_ratio);
      }
      return out;
    } catch (e) {
      this.warn('deltaByRuleVersion', e);
      return empty;
    }
  }

  private warn(op: string, e: unknown): void {
    process.stderr.write(`[pg-store] ${op} 실패(무시, 가용성 우선): ${(e as Error).message}\n`);
  }
}

/** domain_rules 테이블을 읽는 DomainRuleProvider. hot-reload 는 DomainRuleStore(TTL 45s)가 담당. */
export class PgDomainRuleProvider implements DomainRuleProvider {
  constructor(private pool: PoolLike) {}

  async loadAll(): Promise<DomainRule[]> {
    try {
      const { rows } = await this.pool.query<Record<string, unknown>>(
        `SELECT domain, force_headless, is_short_link, ua_override, extra_headers, extra_cookies,
                wait_selector, click_selector, render_timeout_ms, rate_limit_rps, max_redirects,
                body_byte_cap, robots_mode, allow_headless_on_challenge, oembed_endpoint,
                ttl_override_sec, enabled, version
           FROM domain_rules
          WHERE enabled = true`,
      );
      return rows.map((row) => this.rowToRule(row));
    } catch (e) {
      // 조회 실패 → 빈 스냅샷. DomainRuleStore 는 직전 스냅샷 유지 or DEFAULT_DOMAIN_RULE 로 낙하.
      process.stderr.write(`[pg-store] domain_rules loadAll 실패(무시): ${(e as Error).message}\n`);
      return [];
    }
  }

  private rowToRule(row: Record<string, unknown>): DomainRule {
    const num = (v: unknown): number | null => (v == null ? null : Number(v)); // NUMERIC/INT 는 문자열로 올 수 있음
    const jsonObj = (v: unknown): Record<string, string> | null => {
      if (v == null) return null;
      if (typeof v === 'object') return v as Record<string, string>; // jsonb → 파싱된 객체
      try {
        return JSON.parse(String(v)) as Record<string, string>;
      } catch {
        return null;
      }
    };
    return {
      ...DEFAULT_DOMAIN_RULE,
      domain: String(row.domain),
      force_headless: Boolean(row.force_headless),
      is_short_link: Boolean(row.is_short_link),
      ua_override: (row.ua_override as string | null) ?? null,
      extra_headers: jsonObj(row.extra_headers),
      extra_cookies: jsonObj(row.extra_cookies),
      wait_selector: (row.wait_selector as string | null) ?? null,
      click_selector: (row.click_selector as string | null) ?? null,
      render_timeout_ms: num(row.render_timeout_ms),
      rate_limit_rps: num(row.rate_limit_rps),
      max_redirects: num(row.max_redirects),
      body_byte_cap: num(row.body_byte_cap),
      robots_mode: (row.robots_mode === 'ignore' ? 'ignore' : 'respect'),
      allow_headless_on_challenge: Boolean(row.allow_headless_on_challenge),
      oembed_endpoint: (row.oembed_endpoint as string | null) ?? null,
      ttl_override_sec: num(row.ttl_override_sec),
      enabled: row.enabled == null ? true : Boolean(row.enabled),
      version: Number(row.version ?? 0),
    };
  }
}

/** 영속 계층 핸들 — 저장소 + 규칙 provider + 정리 훅. store/ruleProvider 는 동일 Pool 공유. */
export interface PersistenceHandle {
  store: CrawlStore;
  ruleProvider: DomainRuleProvider;
  kind: 'postgres' | 'memory';
  close(): Promise<void>;
}

const memoryPersistence = (): PersistenceHandle => ({
  store: new InMemoryCrawlStore(),
  ruleProvider: new StaticSeedRuleProvider(),
  kind: 'memory',
  close: async () => {},
});

/**
 * 영속 계층 선택 팩토리.
 * @param opts.url  명시 URL(미지정 시 DATABASE_URL env). 없으면 인메모리(외부 의존 0 dev 유지).
 * DATABASE_URL 있음 + 접속 성공 → Pg 어댑터, 아니면 인메모리 강등.
 */
export async function createPersistence(opts: { url?: string } = {}): Promise<PersistenceHandle> {
  const url = opts.url ?? process.env.DATABASE_URL;
  if (!url) return memoryPersistence();
  try {
    const pool = await createPool(url);
    return {
      store: new PgCrawlStore(pool),
      ruleProvider: new PgDomainRuleProvider(pool),
      kind: 'postgres',
      close: () => pool.end(),
    };
  } catch (err) {
    process.stderr.write(
      `[pg-store] DATABASE_URL 설정됨이나 접속 실패 → 인메모리 저장소로 강등: ${(err as Error).message}\n`,
    );
    return memoryPersistence();
  }
}

/** error_code → error_class 문자열(dlq enqueue 등 편의). */
export function errorClassOf(code: ErrorCode): string {
  return ERROR_META[code].errorClass;
}
