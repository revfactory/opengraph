-- migrations/001_init.sql — OG unfurl 서비스 전체 스키마 (초기)
--
-- 단일 진실: _workspace/02_integrated_architecture.md
--   §3-bis  크롤 저장 모델 정본 = crawl_attempts(append-only). failed_crawls/crawls 는 파생.
--   §1-1    error_code taxonomy — error_class/stage 는 **별도 컬럼**(문자열 파싱 금지, SQL 집계용).
--   §1-2    domain_rules 확정 스키마(필드 1:1).
--   §5-5    규칙 전후 델타 측정을 위해 (rule_version) 인덱스.
--
-- 멱등: 전부 IF NOT EXISTS. scripts/migrate.ts 가 트랜잭션으로 1회 적용하고 schema_migrations 에 기록한다.

-- ─────────────────────────────────────────────────────────────────────────────
-- ★ 정본: 모든 시도(ok/partial/failed) 1행 append-only. §5-5 델타·SLO 드릴다운·감사의 단일 소스.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crawl_attempts (
  id             BIGSERIAL PRIMARY KEY,
  trace_id       UUID NOT NULL,
  input_url      TEXT,
  normalized_url TEXT,
  final_url      TEXT,
  domain         TEXT NOT NULL,               -- final_url eTLD+1 (집계 축)
  status         TEXT NOT NULL,               -- ok|partial|failed (공유 enum)
  error_code     TEXT,                        -- §1-1 taxonomy(성공 시 NULL)
  error_class    TEXT,                        -- 파생 컬럼(transient|permanent|anti-bot)
  stage          TEXT,                        -- 파생 컬럼(normalize|precheck|...|render|any)
  fetch_strategy TEXT NOT NULL,               -- static|oembed|headless
  http_status    INT,
  redirect_hops  INT,
  completeness   NUMERIC,
  cache          TEXT,                        -- hit|miss|stale|negative
  latency_ms     INT,
  attempt_no     INT NOT NULL DEFAULT 1,
  rule_version   INT DEFAULT 0,
  worker_id      TEXT,
  ts             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ca_domain_error ON crawl_attempts (domain, error_code); -- SLO 드릴다운
CREATE INDEX IF NOT EXISTS idx_ca_rule_version ON crawl_attempts (rule_version);        -- ★ §5-5 델타
CREATE INDEX IF NOT EXISTS idx_ca_ts           ON crawl_attempts (ts);                  -- 시계열 스캔

-- ─────────────────────────────────────────────────────────────────────────────
-- 파생: 최신 성공 payload 내구 사본(캐시 재구축/프리워밍). payload 는 JSONB.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crawls (
  id             BIGSERIAL PRIMARY KEY,
  trace_id       UUID,
  norm_url       TEXT,
  payload_key    TEXT,
  final_url      TEXT,
  canonical_url  TEXT,
  domain         TEXT,
  fetch_strategy TEXT,
  status         TEXT,
  http_status    INT,
  completeness   NUMERIC,
  rule_version   INT,
  payload        JSONB,
  redirect_chain JSONB,
  fetched_at     TIMESTAMPTZ,
  ttl_seconds    INT
);
CREATE INDEX IF NOT EXISTS idx_crawls_payload_key ON crawls (payload_key);
CREATE INDEX IF NOT EXISTS idx_crawls_norm        ON crawls (norm_url);
CREATE INDEX IF NOT EXISTS idx_crawls_gin         ON crawls USING GIN (payload);

-- ─────────────────────────────────────────────────────────────────────────────
-- 파생 롤업: (domain,error_code,final_url) 미해소 실패 집계. 플라이휠 §5-1 top-N 전용.
-- final_url 은 NOT NULL DEFAULT '' — NULL 은 UNIQUE 에서 distinct 라 롤업이 깨진다(어댑터가 COALESCE).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS failed_crawls (
  id             BIGSERIAL PRIMARY KEY,
  trace_id       UUID NOT NULL,
  domain         TEXT NOT NULL,
  input_domain   TEXT NOT NULL,
  error_code     TEXT NOT NULL,               -- §1-1 taxonomy(문자열 그대로)
  error_class    TEXT NOT NULL,               -- 파생 컬럼(문자열 파싱 금지)
  stage          TEXT NOT NULL,               -- 파생 컬럼
  http_status    INT,
  fetch_strategy TEXT NOT NULL,
  final_url      TEXT NOT NULL DEFAULT '',
  attempt_no     INT NOT NULL DEFAULT 1,
  rule_version   INT DEFAULT 0,
  worker_id      TEXT,
  first_seen     TIMESTAMPTZ DEFAULT now(),
  last_seen      TIMESTAMPTZ DEFAULT now(),
  occurrences    INT DEFAULT 1,
  resolved       BOOLEAN DEFAULT false,
  resolved_by_rule INT,
  UNIQUE (domain, error_code, final_url)       -- UPSERT 롤업 키
);
CREATE INDEX IF NOT EXISTS idx_fc_domain_error ON failed_crawls (domain, error_code);        -- ★ 플라이휠 집계
CREATE INDEX IF NOT EXISTS idx_fc_open         ON failed_crawls (resolved, error_class, last_seen);

-- ─────────────────────────────────────────────────────────────────────────────
-- Dead-letter queue: 재시도 소진 실패 격리(reliability-ops §7).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dlq (
  id              BIGSERIAL PRIMARY KEY,
  trace_id        UUID,
  final_url       TEXT,
  domain          TEXT,
  error_code      TEXT,
  error_class     TEXT,
  last_attempt_no INT,
  payload         JSONB,
  enqueued_at     TIMESTAMPTZ DEFAULT now(),
  reprocess_after TIMESTAMPTZ,
  reprocessed     BOOLEAN DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_dlq_open ON dlq (reprocessed, reprocess_after);

-- ─────────────────────────────────────────────────────────────────────────────
-- per-domain 규칙 (통합 §1-2 확정 스키마). reliability-ops 생산 · crawl-engine/platform 소비.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS domain_rules (
  domain                      TEXT PRIMARY KEY,          -- final_url 기준 eTLD+1
  force_headless              BOOLEAN DEFAULT false,     -- 엔진 소비(platform force_strategy 흡수)
  is_short_link               BOOLEAN DEFAULT false,     -- 단축링크 완전해석 + short_map 캐시
  ua_override                 TEXT,
  extra_headers               JSONB,                     -- 구 headers_override 통합(burst 등)
  extra_cookies               JSONB,
  wait_selector               TEXT,
  click_selector              TEXT,
  render_timeout_ms           INT,
  rate_limit_rps              NUMERIC,                   -- 구 rate_limit{rps}
  max_redirects               INT,
  body_byte_cap               INT,
  robots_mode                 TEXT DEFAULT 'respect',    -- respect|ignore
  allow_headless_on_challenge BOOLEAN DEFAULT false,
  oembed_endpoint             TEXT,
  ttl_override_sec            INT,                        -- platform 캐시 TTL 소비
  enabled                     BOOLEAN DEFAULT true,
  version                     INT DEFAULT 1,             -- 변경 시 ++, crawl_attempts.rule_version 스탬프
  updated_by                  TEXT,
  updated_at                  TIMESTAMPTZ DEFAULT now()
);

-- 참조 시드(개발/데모) — StaticSeedRuleProvider 와 동일. 이미 있으면 건드리지 않음.
INSERT INTO domain_rules (domain, ua_override, extra_headers, wait_selector, rate_limit_rps, oembed_endpoint, ttl_override_sec, version)
VALUES ('twitter.com', 'Mozilla/5.0 (compatible; facebookexternalhit/1.1)',
        '{"Accept-Language":"en"}'::jsonb, 'meta[property=''og:title'']', 2,
        'https://publish.twitter.com/oembed', 86400, 7)
ON CONFLICT (domain) DO NOTHING;
INSERT INTO domain_rules (domain, is_short_link, version)
VALUES ('bit.ly', true, 1) ON CONFLICT (domain) DO NOTHING;
INSERT INTO domain_rules (domain, is_short_link, allow_headless_on_challenge, version)
VALUES ('t.co', true, true, 1) ON CONFLICT (domain) DO NOTHING;
INSERT INTO domain_rules (domain, is_short_link, click_selector, version)
VALUES ('lnkd.in', true, 'a.external-link', 1) ON CONFLICT (domain) DO NOTHING;
