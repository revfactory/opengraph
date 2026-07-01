/**
 * persistence/postgres.ts — 내구/집계 저장소 (platform §4-2 / reliability-ops §2.1·§2.2 / 통합 §3-bis)
 *
 * 통합 §3-bis [GAP 3b 해소 확정]: 크롤 저장 모델 정본 = **`crawl_attempts`(append-only)**.
 *   - crawl_attempts: 모든 시도(ok/partial/failed) 1행. §5-5 델타·SLO 드릴다운·감사의 단일 소스.
 *   - failed_crawls: (domain,error_code,final_url) 롤업 뷰 — 플라이휠 §5-1 top-N 전용(파생).
 *   - crawls: 최신 성공 payload 내구 사본(캐시 재구축/프리워밍용, 파생·선택).
 * 모든 시도는 단일 writeAttempt() 경로로 crawl_attempts에 append(성공·실패 공통).
 *
 * 주변부 모듈: 인터페이스 + 인메모리 스텁 + DDL(주석). 실제 배포는 `pg`/`postgres.js` 로 교체.
 * writeAttempt append·failed_crawls UPSERT(occurrences++) 로직은 실제 구현(집계 정합의 핵심).
 */

import { ERROR_META, type ErrorClass, type ErrorCode, type ErrorStage } from '../errors/taxonomy.js';
import type { CacheState, CrawlStatus, FetchResult, FetchStrategy } from '../types.js';
import { domainOf } from '../url/domain.js';

/*
DDL (참조 — reliability-ops §2.1/§2.2 / platform §4-2 / 통합 §1-1 파생 컬럼·§3-bis):

-- ★ 정본: 모든 시도(성공·실패) append-only. §5-5 델타 측정의 FROM 대상.
CREATE TABLE crawl_attempts (
  id BIGSERIAL PRIMARY KEY,
  trace_id UUID NOT NULL,
  input_url TEXT, normalized_url TEXT, final_url TEXT,
  domain TEXT NOT NULL,                    -- final_url eTLD+1 (집계 축)
  status TEXT NOT NULL,                    -- ok|partial|failed (공유 enum)
  error_code TEXT,                         -- §1-1 taxonomy(성공 시 NULL)
  error_class TEXT,                        -- 파생 컬럼(transient|permanent|anti-bot)
  stage TEXT,                              -- 파생 컬럼
  fetch_strategy TEXT NOT NULL,            -- static|oembed|headless
  http_status INT, redirect_hops INT,
  completeness NUMERIC, cache TEXT,        -- hit|miss|stale|negative
  latency_ms INT, attempt_no INT NOT NULL, rule_version INT, worker_id TEXT,
  ts TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ca_domain_error ON crawl_attempts (domain, error_code);  -- SLO 드릴다운
CREATE INDEX idx_ca_rule_version ON crawl_attempts (rule_version);        -- ★ §5-5 델타

CREATE TABLE crawls (
  id BIGSERIAL PRIMARY KEY,
  trace_id UUID, norm_url TEXT, payload_key TEXT, final_url TEXT, canonical_url TEXT,
  domain TEXT, fetch_strategy TEXT, status TEXT, http_status INT,
  completeness NUMERIC, rule_version INT, payload JSONB,
  redirect_chain JSONB, fetched_at TIMESTAMPTZ, ttl_seconds INT
);
CREATE INDEX idx_crawls_payload_key ON crawls (payload_key);
CREATE INDEX idx_crawls_norm ON crawls (norm_url);
CREATE INDEX idx_crawls_gin ON crawls USING GIN (payload);

CREATE TABLE failed_crawls (
  id BIGSERIAL PRIMARY KEY, trace_id UUID NOT NULL,
  domain TEXT NOT NULL, input_domain TEXT NOT NULL,
  error_code TEXT NOT NULL,               -- §1-1 taxonomy(문자열 그대로)
  error_class TEXT NOT NULL,              -- 파생 컬럼(transient|permanent|anti-bot) — 문자열 파싱 금지
  stage TEXT NOT NULL,                    -- 파생 컬럼
  http_status INT, fetch_strategy TEXT NOT NULL, final_url TEXT,
  attempt_no INT NOT NULL, rule_version INT, worker_id TEXT,
  first_seen TIMESTAMPTZ DEFAULT now(), last_seen TIMESTAMPTZ DEFAULT now(),
  occurrences INT DEFAULT 1, resolved BOOLEAN DEFAULT false, resolved_by_rule INT,
  UNIQUE (domain, error_code, final_url)  -- UPSERT 롤업 키
);
CREATE INDEX idx_fc_domain_error ON failed_crawls (domain, error_code);  -- ★ 플라이휠 집계
CREATE INDEX idx_fc_open ON failed_crawls (resolved, error_class, last_seen);

CREATE TABLE dlq (
  id BIGSERIAL PRIMARY KEY, trace_id UUID, final_url TEXT, domain TEXT,
  error_code TEXT, error_class TEXT, last_attempt_no INT, payload JSONB,
  enqueued_at TIMESTAMPTZ DEFAULT now(), reprocess_after TIMESTAMPTZ, reprocessed BOOLEAN DEFAULT false
);
*/

/** ★ 정본 시도 레코드 (통합 §3-bis / reliability-ops §2.1). 모든 시도 1행. */
export interface CrawlAttemptRecord {
  trace_id: string;
  input_url: string;
  normalized_url: string;
  final_url: string;
  domain: string; // final_url eTLD+1 (집계 축)
  status: CrawlStatus;
  error_code: ErrorCode | null; // 성공 시 null
  error_class: ErrorClass | null; // 파생(성공 시 null)
  stage: ErrorStage | null; // 파생(성공 시 null)
  fetch_strategy: FetchStrategy;
  http_status: number | null;
  redirect_hops: number;
  completeness: number;
  cache: CacheState;
  latency_ms: number;
  attempt_no: number;
  rule_version: number;
  worker_id: string;
  ts: string; // ISO-8601
}

/**
 * FetchResult → CrawlAttemptRecord 빌더. 성공·실패 경로가 동일 형태로 append하도록 공유.
 * error_class/stage 는 error_code로부터 파생(ERROR_META), 성공(null)이면 null.
 */
export function attemptFromResult(
  r: FetchResult,
  ctx: {
    trace_id: string;
    cache: CacheState;
    worker_id: string;
    attempt_no?: number;
    rule_version?: number;
  },
): CrawlAttemptRecord {
  const meta = r.error_code ? ERROR_META[r.error_code] : null;
  return {
    trace_id: ctx.trace_id,
    input_url: r.input_url,
    normalized_url: r.normalized_url,
    final_url: r.final_url,
    domain: domainOf(r.final_url) || domainOf(r.normalized_url),
    status: r.status,
    error_code: r.error_code,
    error_class: meta?.errorClass ?? null,
    stage: meta?.stage ?? null,
    fetch_strategy: r.fetch_strategy,
    http_status: r.http_status,
    redirect_hops: r.redirect_chain.length,
    completeness: r.completeness,
    cache: ctx.cache,
    latency_ms: r.latency_ms,
    attempt_no: ctx.attempt_no ?? 1,
    rule_version: ctx.rule_version ?? 0,
    worker_id: ctx.worker_id,
    ts: r.fetched_at,
  };
}

export interface CrawlRecord {
  trace_id: string;
  norm_url: string;
  payload_key: string;
  result: FetchResult;
  domain: string;
  rule_version: number;
  ttl_seconds: number;
}

export interface FailedCrawlRecord {
  trace_id: string;
  domain: string;
  input_domain: string;
  error_code: ErrorCode;
  error_class: ErrorClass;
  stage: ErrorStage;
  http_status: number | null;
  fetch_strategy: FetchStrategy;
  final_url: string | null;
  attempt_no: number;
  rule_version: number;
  worker_id: string;
}

/** 저장소 포트 — 구현 교체 지점. */
export interface CrawlStore {
  /** ★ 정본: 모든 시도(성공·실패) 1행 append (통합 §3-bis). §5-5 델타의 단일 소스. */
  writeAttempt(rec: CrawlAttemptRecord): Promise<void>;
  /** 파생: 최신 성공 payload 내구 사본(캐시 재구축용). */
  writeCrawl(rec: CrawlRecord): Promise<void>;
  /** 파생: failed_crawls UPSERT — (domain,error_code,final_url) 충돌 시 occurrences++·last_seen 갱신. */
  upsertFailedCrawl(rec: FailedCrawlRecord): Promise<void>;
  enqueueDlq(rec: {
    trace_id: string;
    final_url: string;
    domain: string;
    error_code: ErrorCode;
    error_class: ErrorClass;
    last_attempt_no: number;
  }): Promise<void>;
}

/**
 * 인메모리 스텁 — 개발/스모크. Postgres 장애 시 저하 모드(platform §6)의 버퍼링도 흉내낸다.
 * UPSERT 롤업 로직은 실제 구현(집계 정합 검증 가능).
 */
export class InMemoryCrawlStore implements CrawlStore {
  /** ★ 정본 append-only 로그 — 모든 시도. */
  attempts: CrawlAttemptRecord[] = [];
  crawls: CrawlRecord[] = [];
  failed = new Map<string, FailedCrawlRecord & { occurrences: number; last_seen: number }>();
  dlq: unknown[] = [];

  async writeAttempt(rec: CrawlAttemptRecord): Promise<void> {
    // TODO(EXTENSION): INSERT INTO crawl_attempts (...) VALUES (...) — append-only, UPDATE 없음.
    this.attempts.push(rec);
  }

  async writeCrawl(rec: CrawlRecord): Promise<void> {
    // TODO(EXTENSION): INSERT INTO crawls (...) VALUES (...) — payload는 JSONB.
    this.crawls.push(rec);
  }

  async upsertFailedCrawl(rec: FailedCrawlRecord): Promise<void> {
    const key = `${rec.domain}|${rec.error_code}|${rec.final_url ?? ''}`;
    const existing = this.failed.get(key);
    if (existing) {
      existing.occurrences += 1;
      existing.last_seen = Date.now();
      existing.attempt_no = Math.max(existing.attempt_no, rec.attempt_no);
    } else {
      this.failed.set(key, { ...rec, occurrences: 1, last_seen: Date.now() });
    }
    // TODO(EXTENSION): INSERT ... ON CONFLICT (domain,error_code,final_url)
    //   DO UPDATE SET occurrences = failed_crawls.occurrences+1, last_seen = now();
  }

  async enqueueDlq(rec: unknown): Promise<void> {
    this.dlq.push(rec);
  }

  /** 참조 집계(reliability-ops §5-1 top-N) — SQL GROUP BY domain,error_code 등가. */
  topFailures(limit = 30): Array<{ domain: string; error_code: string; fails: number }> {
    const agg = new Map<string, number>();
    for (const f of this.failed.values()) {
      const k = `${f.domain}|${f.error_code}`;
      agg.set(k, (agg.get(k) ?? 0) + f.occurrences);
    }
    return [...agg.entries()]
      .map(([k, fails]) => {
        const [domain, error_code] = k.split('|');
        return { domain: domain!, error_code: error_code!, fails };
      })
      .sort((a, b) => b.fails - a.fails)
      .slice(0, limit);
  }

  /**
   * 규칙 적용 전후 성공률 델타 (reliability-ops §5-5) — 이제 crawl_attempts 단일 소스에서 계산.
   * SQL 등가: SELECT (rule_version>=X) AS after, AVG((status<>'failed')) FROM crawl_attempts
   *           WHERE domain=:d GROUP BY (rule_version>=X);
   */
  deltaByRuleVersion(
    domain: string,
    threshold: number,
  ): { before: { n: number; success_ratio: number }; after: { n: number; success_ratio: number } } {
    const bucket = (after: boolean) => {
      const rows = this.attempts.filter((a) => a.domain === domain && a.rule_version >= threshold === after);
      const ok = rows.filter((a) => a.status !== 'failed').length;
      return { n: rows.length, success_ratio: rows.length ? ok / rows.length : 0 };
    };
    return { before: bucket(false), after: bucket(true) };
  }
}
