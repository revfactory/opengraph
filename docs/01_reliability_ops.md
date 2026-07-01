# 01 · Reliability & Ops Engineer 설계 — 크롤 실패 추적 & 실패율 감소 체계

> **다루는 요구사항:** 고려사항 ② 운영/모니터링 — "크롤링 실패 시 실패된 링크를 어떻게 추적하고, 어떻게 실패율을 줄여 나가는가."
> **신조:** 분류 없는 실패는 못 고친다. 감소의 레버는 **per-domain 규칙 테이블**, 연료는 **집계 가능한 실패 데이터**.
> **경계면 요약:** (a) 에러 코드 taxonomy는 crawl-engine과 **단일 진실**. (b) `failed_crawls`를 `domain × error_code`로 SQL 집계할 수 있어야 함 → platform-architect의 DB 제약. (c) per-domain 규칙 필드는 crawl-engine이 소비하는 필드와 1:1 일치. 상세는 문서 말미 `## 경계면 계약`.

---

## 0. 설계 목표 & SLO (측정의 기준선)

실패율 "감소"를 논하려면 먼저 실패의 정의와 목표선이 있어야 한다. 그린필드 기준선을 아래로 잡고, 기존 스택이 있으면 조직 SLO로 대체한다.

| SLI (측정 지표) | 정의 | SLO 목표 | 에러 예산(30일) |
|---|---|---|---|
| **Crawl Success Ratio** | `status ∈ {ok, partial}` / 전체 시도 | ≥ 97% (핵심) | 3% |
| **Fresh Success Ratio** | `status = ok` (완성도 ≥ 0.5) / 전체 | ≥ 92% | 8% |
| **p95 End-to-End Latency** | 동기 경로 응답까지 | ≤ 800ms (핫 캐시 ≤ 50ms) | — |
| **Headless Fallback Ratio** | `fetch_strategy=headless` / 전체 | ≤ 10% (비용 신호, 상한) | — |
| **DLQ Drain Time** | DLQ 진입 → 재처리 성공까지 | p90 ≤ 24h | — |

- **`partial`을 성공으로 계산하는 이유:** OG 일부라도 추출되면 사용자에게 미리보기를 줄 수 있다. `partial`은 실패가 아니라 *완성도 저하*이며, 별도 지표(`Fresh Success Ratio`)로 품질을 추적한다.
- **에러 예산 소진율(burn rate)** 이 알림의 1차 트리거다(§4). 절대 임계보다 예산 소진 속도가 운영 신호로 우월하다.

---

## 1. 에러 Taxonomy (단일 진실 — crawl-engine과 공유)

모든 실패는 crawl-engine이 부여하는 **하나의 에러 코드**로 도착한다. 아래 표가 그 전체 집합이며, reliability-ops와 crawl-engine이 **동일 문자열**을 사용한다(§경계면 계약 a).

| 범주 | 에러 코드 | 성격 | HTTP/신호 | 1차 대응 레버 | 재시도 |
|---|---|---|---|---|---|
| **네트워크** | `DNS_FAIL` | 대개 permanent | 해석 실패 | 도메인 오타/소멸 → 규칙 없음, 로그 | ✗ (1회 확인만) |
| | `CONN_TIMEOUT` | **transient** | 연결 지연 | 타임아웃/rate-limit 규칙 | ✓ |
| | `CONN_REFUSED` | transient | 포트 거부 | 백오프 후 재시도 | ✓ (제한적) |
| | `TLS_ERROR` | 대개 permanent | 인증서 문제 | 규칙: `insecure_tls`(승인 시) | ✗ |
| **HTTP** | `HTTP_403` | permanent* | 403 (봇 차단) | **UA 오버라이드 / force-headless** | ✗ → 규칙 후 백필 |
| | `HTTP_404` | permanent | 404 | 없음(정상). negative-cache | ✗ |
| | `HTTP_410` | permanent | 410 | 없음(정상). negative-cache 장기 | ✗ |
| | `HTTP_429` | **transient** | 429 (rate-limit) | **`rate_limit_rps` 규칙**, `Retry-After` 존중 | ✓ (Retry-After 우선) |
| | `HTTP_5XX` | **transient** | 500–599 | 백오프 재시도 | ✓ |
| **콘텐츠** | `NO_OG_TAGS` | permanent** | OG 없음+HTML | **force-headless / oembed_endpoint** | ✗ → 승격/규칙 |
| | `PARSE_ERROR` | permanent | 파싱 실패 | 파서 버그 리포트 | ✗ |
| | `NON_HTML` | permanent | PDF/이미지 등 | 없음(정상 스킵) | ✗ |
| | `EMPTY_BODY` | transient | 200+빈 본문 | 재시도 1회 → force-headless | ✓ (1회) |
| | `TOO_LARGE` | permanent | 본문 상한 초과 | `range` 축소 규칙 | ✗ |
| **렌더링** | `JS_TIMEOUT` | **transient** | 헤드리스 대기 초과 | `wait_selector`/타임아웃 규칙 | ✓ |
| | `RENDER_CRASH` | **transient** | 브라우저 크래시 | 재시도(다른 워커) | ✓ |
| **정책/안전** | `SSRF_BLOCKED` | permanent | 내부 IP 차단 | 없음(정상 방어) | ✗ |
| | `ROBOTS_DISALLOWED` | permanent | robots 금지 | 없음(정책). negative-cache | ✗ |
| | `REDIRECT_LOOP` | permanent | 순환 감지 | 없음(정상 방어) | ✗ |
| | `TOO_MANY_REDIRECTS` | permanent | 홉 상한 초과 | `max_redirects` 규칙(드묾) | ✗ |

\* `HTTP_403`은 "permanent"로 시작하지만 **규칙 적용(UA/헤드리스)으로 permanent→성공 전환**되는 대표 케이스다. 플라이휠의 핵심 타깃.
\** `NO_OG_TAGS`는 SPA 신호가 있으면 crawl-engine이 헤드리스로 자동 승격한다. 승격 후에도 없으면 진짜 permanent(폴백 점수로 처리).

**transient vs permanent — 재시도 정책의 근간**
- **transient(재시도 가치 O):** `CONN_TIMEOUT`, `CONN_REFUSED`, `HTTP_429`, `HTTP_5XX`, `EMPTY_BODY`, `JS_TIMEOUT`, `RENDER_CRASH`. → §7 지수 백오프.
- **permanent(재시도 무의미):** 그 외 전부. 즉시 negative-cache에 넣고 DLQ가 아닌 **규칙 대상 큐**로 분류(규칙으로 고칠 수 있으면 고침, 아니면 종결).

> **crawl-engine 초안과의 코드 정합(중요):** crawl-engine 에이전트 정의는 요약형으로 `HTTP_4XX/HTTP_5XX`를 열거하지만, 운영은 **403(UA 레버) / 404·410(종결) / 429(rate-limit 레버)** 를 서로 다르게 처리해야 하므로 4xx를 **`HTTP_403/HTTP_404/HTTP_410/HTTP_429`로 세분**한다. 그 외 4xx는 `HTTP_4XX_OTHER`로 폴백 수용한다. 이 세분 규칙이 단일 진실의 확정본이며 crawl-engine이 이 granular 코드를 emit하도록 합의한다.

---

## 2. 크롤 레코드 스키마 (추적의 원자)

crawl-engine의 표준 반환 스키마(§경계면 계약 c)를 그대로 **소비**하여 모든 *시도*를 append-only 이벤트로 남긴다. 실패는 추가로 `failed_crawls`(집계용)와 필요 시 DLQ로 분기한다.

### 2.1 시도 이벤트 (append-only, 전량 기록)

```jsonc
{
  "trace_id": "0f8c…-uuid",           // 요청 단위 상관관계 ID (span과 연결)
  "attempt_no": 1,                     // 재시도 회차
  "input_url": "https://bit.ly/xxxx",
  "normalized_url": "https://bit.ly/xxxx",   // ← crawl-engine 산출(캐시 key 근거)
  "final_url": "https://example.com/article/123",
  "canonical_url": "https://example.com/article/123",
  "domain": "example.com",             // ★ 집계 축 — final_url의 eTLD+1, 반드시 별도 컬럼/인덱스
  "input_domain": "bit.ly",            // 진단 보조(단축 도메인 패턴 식별용)
  "status": "ok | partial | failed",
  "error_code": "HTTP_429 | null",     // ← §1 taxonomy 단일 진실
  "fetch_strategy": "static | oembed | headless",  // ← crawl-engine 산출
  "http_status": 429,
  "redirect_hops": 2,
  "completeness": 0.83,                // ← crawl-engine 산출(품질 SLI 근거)
  "cache": "hit | miss | stale",
  "latency_ms": 812,
  "worker_id": "w-03",
  "rule_version": 42,                  // 이 시도에 적용된 per-domain 규칙 버전(§6, 델타 측정용)
  "ts": "2026-07-01T09:12:03Z"
}
```

- **`domain`을 별도 인덱스 컬럼으로 두는 것이 이 설계의 심장**이다. 플라이휠 전체가 `GROUP BY domain, error_code`에 의존한다.
- **`rule_version`** 을 레코드에 박아 규칙 적용 전후 성공률 델타를 정확히 측정한다(§5-5, §6 lifecycle).

### 2.2 `failed_crawls` 테이블 (SQL 집계 대상 — DB 제약의 근원)

```sql
CREATE TABLE failed_crawls (
  id            BIGSERIAL PRIMARY KEY,
  trace_id      UUID        NOT NULL,
  domain        TEXT        NOT NULL,        -- 집계 축 (final_url eTLD+1)
  input_domain  TEXT        NOT NULL,
  error_code    TEXT        NOT NULL,        -- §1 taxonomy
  error_class   TEXT        NOT NULL,        -- 'transient' | 'permanent' (파생, 인덱스)
  http_status   INT,
  fetch_strategy TEXT       NOT NULL,
  final_url     TEXT,
  attempt_no    INT         NOT NULL,
  rule_version  INT,
  worker_id     TEXT,
  first_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen     TIMESTAMPTZ NOT NULL DEFAULT now(),
  occurrences   INT         NOT NULL DEFAULT 1,   -- 동일 (domain,error_code,final_url) 롤업
  resolved      BOOLEAN     NOT NULL DEFAULT false,
  resolved_by_rule INT                            -- 어떤 규칙 버전으로 해소됐는지
);
CREATE INDEX idx_fc_domain_error ON failed_crawls (domain, error_code);      -- ★ 플라이휠 집계
CREATE INDEX idx_fc_open        ON failed_crawls (resolved, error_class, last_seen);
```

> **platform-architect에게 부과하는 제약:** 위 스키마를 `GROUP BY domain, error_code`로 집계할 수 있어야 한다 → **관계형/SQL 저장소(Postgres 권장)**. Redis-only로는 이 요구를 충족 못 한다. 시계열 지표는 Prometheus, 핫 캐시는 Redis로 역할 분리(§경계면 계약 b).

---

## 3. 메트릭 카탈로그 (행동으로 이어지는 것만)

OpenTelemetry → Prometheus 기준(벤더 중립). Datadog/Grafana Cloud로 갈 때는 metric name을 네임스페이스만 매핑.

| 메트릭 | 타입 | 라벨 | 용도 |
|---|---|---|---|
| `og_crawl_total` | counter | `status, error_code, strategy, cache` | 성공률·에러 분포의 원천 |
| `og_crawl_latency_seconds` | histogram | `strategy, cache` | p50/p95/p99 지연 |
| `og_crawl_completeness` | histogram | `strategy` | 품질(폴백 승격 효과) |
| `og_headless_fallback_ratio` | gauge(파생) | — | 비용 신호(헤드리스 승격률) |
| `og_cache_hit_ratio` | gauge(파생) | — | 캐시 효율 |
| `og_dlq_depth` | gauge | `error_class` | 미처리 실패 적체 |
| `og_retry_total` | counter | `error_code, outcome` | 재시도 효율(성공 전환율) |
| `og_rule_apply_total` | counter | `domain_bucket, field` | 규칙 적용 빈도(레버 사용) |
| `og_domain_success_ratio` | gauge(recording rule) | `domain` **(top-N only)** | 도메인별 성공률 |

**카디널리티 규율(운영 필수):** `domain`을 raw 라벨로 붙이면 카디널리티가 폭발한다. 따라서
- 원시 `og_crawl_total`에는 `domain`을 **붙이지 않는다**.
- 도메인별 성공률은 **`failed_crawls`(SQL)** 에서 계산하거나, Prometheus **recording rule로 top-N 도메인만** `og_domain_success_ratio`로 승격한다.
- 대시보드 "가장 많이 실패하는 도메인 top-N"의 진실 원천은 **SQL 집계**(§5-1), 메트릭은 실시간 추세만.

### 파생 SLI (PromQL 예)
```promql
# 전체 성공률 (partial 포함)
sum(rate(og_crawl_total{status=~"ok|partial"}[5m]))
  / sum(rate(og_crawl_total[5m]))

# 헤드리스 승격률 (비용 상한 감시)
sum(rate(og_crawl_total{strategy="headless"}[15m]))
  / sum(rate(og_crawl_total[15m]))

# 재시도 성공 전환율 (transient 재시도가 실제로 값을 하는가)
sum(rate(og_retry_total{outcome="recovered"}[1h]))
  / sum(rate(og_retry_total[1h]))
```

---

## 4. 알림 규칙 (SLO 기반 — burn-rate 우선)

절대 임계보다 **에러 예산 소진율(multi-window burn rate)** 을 1차 신호로 쓴다. 오탐이 적고 진짜 SLO 위협만 page한다.

| # | 조건 | 심각도 | 의미 / 자동 대응 |
|---|---|---|---|
| A1 | **성공률 SLO burn rate**: 1h & 5m 창 동시 > 14.4× | **page** | 2일 내 30일 예산 소진 → 광범위 장애 |
| A2 | 성공률 burn rate: 6h & 30m 창 > 6× | ticket | 완만한 SLO 침식 |
| A3 | `og_headless_fallback_ratio` > 10% (30m) | warn | 비용 급증/신규 SPA 도메인 유입 → 규칙 후보 |
| A4 | p95 지연 > 800ms (10m) | warn | 헤드리스 승격 급증 또는 origin 지연 |
| A5 | 특정 도메인 `HTTP_429` 급증(자동 쿼리 §5-1) | warn | 크롤 예산 초과 → **`rate_limit_rps` 규칙 자동 제안**(PR/티켓 초안 생성) |
| A6 | 신규 `error_code`·`domain` 조합 급증(주간 대비 z-score) | warn | 신규 실패 패턴 등장 → 규칙 검토 |
| A7 | `og_dlq_depth{error_class="transient"}` 지속 증가(1h) | warn | 재처리 잡 지연/막힘 |
| A8 | `og_retry_total{outcome="recovered"}` 비율 급락 | warn | 재시도가 무의미해짐 → 정책/규칙 재검토 |

**A1 burn-rate 규칙(PromQL 예):**
```promql
(
  (1 - (sum(rate(og_crawl_total{status=~"ok|partial"}[1h])) / sum(rate(og_crawl_total[1h])))) > (14.4 * 0.03)
) and (
  (1 - (sum(rate(og_crawl_total{status=~"ok|partial"}[5m]))  / sum(rate(og_crawl_total[5m]))))  > (14.4 * 0.03)
)
```
*(0.03 = 3% 에러 예산. 두 창 동시 위반 시에만 page → 순간 스파이크 오탐 억제.)*

---

## 5. 실패율 감소 플라이휠 (★ 이 설계의 핵심 답)

"어떻게 실패율을 줄여 나가는가"의 답. **일회성 수정이 아니라 매주 도는 루프**다. 각 단계에 실행 가능한 쿼리/산출물을 붙였다.

```
 ┌───────────────────────────────────────────────────────────────┐
 │  1.집계 → 2.진단 → 3.규칙 → 4.재시도/백필 → 5.측정 → 6.주간리뷰  │
 └──────────────────────────────▲────────────────────────────┘
                                 └──────── 반복(우하향) ───────┘
```

### 5-1. 집계 (Aggregate) — 연료 확보
`failed_crawls`를 `domain × error_code`로 집계해 **가장 아픈 곳부터** 본다. 이게 대시보드 top-N의 원천.
```sql
-- 최근 7일, 미해소 실패 top 도메인×에러
SELECT domain, error_code, error_class,
       SUM(occurrences) AS fails,
       COUNT(DISTINCT final_url) AS distinct_urls,
       MAX(last_seen) AS latest
FROM failed_crawls
WHERE resolved = false AND last_seen > now() - INTERVAL '7 days'
GROUP BY domain, error_code, error_class
ORDER BY fails DESC
LIMIT 30;
```
**우선순위 = 실패량 × 고칠 수 있음(레버 존재).** permanent 중 레버 없는 것(404/SSRF)은 목록에서 내려 노이즈를 줄인다.

### 5-2. 진단 (Diagnose) — 패턴 → 원인
집계 결과를 아래 패턴 사전으로 원인 추정한다.

| 관측 패턴 | 추정 원인 | 처방(규칙 필드) |
|---|---|---|
| 한 도메인 `HTTP_403`만 다량 | 기본 UA 봇 차단 | `ua_override`(facebookexternalhit 계열) → 안되면 `force_headless` |
| `NO_OG_TAGS` + `strategy=static` + JS번들 큼 | SPA 셸(클라이언트 렌더) | `force_headless=true` + `wait_selector` |
| known provider 도메인 `NO_OG_TAGS` | 스크래핑 부적합 | `oembed_endpoint` 지정 |
| `HTTP_429` 주기적 스파이크 | 크롤 예산 초과 | `rate_limit_rps` 하향 |
| `JS_TIMEOUT` 특정 도메인 집중 | 렌더 대기 부족 | `wait_selector` + `render_timeout_ms` 상향 |
| `input_domain`이 단축서비스인데 실패 | short→final 해석/캐시 미흡 | short-link 목록 등록(crawl-engine 데이터) |
| `EMPTY_BODY`/`HTTP_403` 지역편중 | 지오/언어 차단 | `extra_headers`(Accept-Language), 프록시 리전 |

### 5-3. 규칙 (Rule) — 레버 당기기
진단 처방을 **per-domain 규칙 테이블(§6)** 에 추가한다. **코드 배포 없이** 즉시 반영(hot-reload). 이것이 실패율을 낮추는 실제 손잡이.

### 5-4. 재시도/백필 (Retry & Backfill)
- transient 실패는 이미 §7 재시도로 상당수 자동 회복.
- **규칙 신설 직후 백필:** 그 도메인의 미해소 `failed_crawls`를 재크롤 큐에 넣어 과거 실패를 즉시 회복시키고 캐시를 채운다(§7). → 성공률이 다음 배포를 기다리지 않고 **당일 반등**.

### 5-5. 측정 (Measure) — 델타 확인
규칙에 `rule_version`이 있으므로 적용 전후 성공률을 **정확히** 비교한다.
```sql
-- 규칙 v42 적용 전후, 대상 도메인 성공률 델타
SELECT (rule_version >= 42) AS after_rule,
       AVG((status <> 'failed')::int)::numeric(4,3) AS success_ratio,
       COUNT(*) AS n
FROM crawl_attempts
WHERE domain = 'example.com'
  AND ts > now() - INTERVAL '14 days'
GROUP BY (rule_version >= 42);
```
**델타가 음수/무의미면 규칙을 롤백**(§6 lifecycle). 효과 없는 레버를 방치하지 않는다.

### 5-6. 주간 리뷰 (Weekly Review) — 루프를 제도화
매주 30분 의식(ritual)으로 고정. 산출물:
1. **Top-10 실패 도메인 표**(5-1) + 전주 대비 증감.
2. 신설/롤백 규칙 목록과 **각 규칙의 성공률 델타**(5-5).
3. **전체 실패율 추세선** — 우상향이면 원인 회고, 우하향이면 다음 타깃 선정.
4. 신규 error_code/domain 패턴(A6) 후속 조치.
5. DLQ 잔량과 drain 시간(SLO 위반 여부).

> **플라이휠 요지:** 레버(규칙 테이블) + 연료(집계 가능한 실패 데이터) + 측정(rule_version 델타) + 리듬(주간). 이 네 개가 맞물리면 실패율은 우연이 아니라 **의도적으로 우하향**한다.

---

## 6. Per-Domain 규칙 테이블 (감소 레버 — 코드 배포 없이 갱신)

운영자가 데이터로 갱신하고, **crawl-engine이 매 요청 시 조회**하는 오버라이드. 필드는 crawl-engine이 소비하는 것과 **1:1 일치**(§경계면 계약 c).

### 6.1 스키마
```sql
CREATE TABLE domain_rules (
  domain          TEXT PRIMARY KEY,       -- eTLD+1 (final_url 기준)
  force_headless  BOOLEAN NOT NULL DEFAULT false,
  ua_override     TEXT,                   -- 예: facebookexternalhit 계열
  extra_headers   JSONB,                  -- {"Accept-Language":"en"}
  extra_cookies   JSONB,
  wait_selector   TEXT,                   -- 헤드리스 렌더 대기 selector
  render_timeout_ms INT,
  rate_limit_rps  NUMERIC,                -- 도메인별 크롤 예산
  max_redirects   INT,
  oembed_endpoint TEXT,                   -- provider oEmbed URL
  ttl_override_sec INT,                   -- 캐시 TTL 오버라이드(platform-architect 소비)
  enabled         BOOLEAN NOT NULL DEFAULT true,
  version         INT NOT NULL DEFAULT 1, -- 변경 시 증가 → crawl_attempts.rule_version에 스탬프
  notes           TEXT,
  updated_by      TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 감사 로그 (규칙 변경은 반드시 흔적을 남긴다)
CREATE TABLE domain_rules_audit (
  id BIGSERIAL PRIMARY KEY,
  domain TEXT NOT NULL,
  version INT NOT NULL,
  diff JSONB NOT NULL,          -- 무엇을 바꿨는가
  actor TEXT NOT NULL,
  reason TEXT,                  -- 어떤 실패 패턴 때문에(5-2 링크)
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

예시 레코드(JSON):
```jsonc
{
  "domain": "twitter.com",
  "force_headless": false,
  "ua_override": "Mozilla/5.0 (compatible; facebookexternalhit/1.1)",
  "extra_headers": {"Accept-Language": "en"},
  "wait_selector": "meta[property='og:title']",
  "rate_limit_rps": 2,
  "oembed_endpoint": "https://publish.twitter.com/oembed",
  "ttl_override_sec": 86400,
  "version": 7,
  "notes": "기본 UA에 403 → facebookexternalhit 계열 UA로 우회"
}
```

### 6.2 Hot-reload (코드 배포 없이 반영)
- crawl-engine 워커는 `domain_rules`를 **인메모리 캐시(TTL 30–60s)** 로 들고, 변경은 최대 1분 내 자연 반영. 즉시성이 필요하면 pub/sub(Redis) 무효화 신호.
- 규칙 편집 UI/CLI → `domain_rules` UPSERT + `version++` + `domain_rules_audit` 삽입(원자 트랜잭션).

### 6.3 규칙 생애주기 (효과 없는 레버 방치 금지)
```
proposed(진단 5-2) → canary(대상 도메인 트래픽 일부에 적용, rule_version 스탬프)
   → measure(§5-5 델타) → keep(전량) | rollback(version 되돌림, audit 기록)
```

---

## 7. 재시도 / DLQ / 백필 정책

### 7.1 재시도 (transient만)
| error_code | 최대 재시도 | 백오프 | 특이 |
|---|---|---|---|
| `HTTP_429` | 3 | **`Retry-After` 우선**, 없으면 지수 | 초과 시 `rate_limit_rps` 규칙 제안(A5) |
| `HTTP_5XX` | 3 | 지수 1s→4s→15s (±지터) | — |
| `CONN_TIMEOUT`/`CONN_REFUSED` | 2 | 지수 + 지터 | 반복 시 origin 다운 의심 |
| `JS_TIMEOUT`/`RENDER_CRASH` | 2 | 즉시(다른 워커/컨텍스트) | 규칙: `wait_selector`/timeout |
| `EMPTY_BODY` | 1 | 즉시 → 실패 시 force-headless 승격 | — |
| permanent 전부 | 0 | — | negative-cache + 규칙 대상 큐 |

**백오프 공식:** `delay = min(cap, base * 2^(attempt-1)) * (1 ± jitter)`, `base=1s, cap=30s, jitter=0.3`. 재시도 예산은 요청 전체 데드라인(예: 동기 3s) 내로 제한 — 넘으면 즉시 `partial`/캐시 폴백 반환하고 재시도는 비동기 큐로 이관.

### 7.2 Dead-Letter Queue
```sql
CREATE TABLE dlq (
  id BIGSERIAL PRIMARY KEY,
  trace_id UUID, final_url TEXT, domain TEXT,
  error_code TEXT, error_class TEXT,
  last_attempt_no INT, payload JSONB,
  enqueued_at TIMESTAMPTZ DEFAULT now(),
  reprocess_after TIMESTAMPTZ,          -- 규칙 갱신/쿨다운 후
  reprocessed BOOLEAN DEFAULT false
);
```
- **transient 재시도 소진** → DLQ(주기 재처리 잡이 지수적으로 간격 늘려 재시도, 예: 1h/6h/24h).
- **permanent(규칙 가능)** → DLQ가 아닌 **규칙 대상 큐**로. 규칙 신설 시 백필 트리거.
- **permanent(레버 없음: 404/410/SSRF)** → DLQ 미진입. negative-cache에서 자연 만료로 회복 허용.
- `og_dlq_depth`(A7)로 적체 감시. drain time이 SLO(§0) 위반이면 재처리 잡 스케일업.

### 7.3 백필 (Backfill) — 감소를 즉시 체감
새 규칙 배포/DLQ 재처리 후:
```sql
-- 규칙 신설 도메인의 미해소 실패를 재크롤 큐로
SELECT trace_id, final_url FROM failed_crawls
WHERE domain = :domain AND resolved = false
  AND error_class = 'permanent' AND error_code IN ('HTTP_403','NO_OG_TAGS');
```
재크롤 성공 시 `failed_crawls.resolved=true, resolved_by_rule=:version` 마킹 → 성공률 델타(§5-5)에 즉시 반영, 캐시 프리워밍으로 사용자 체감 회복.

---

## 8. 계측 지점 (Instrumentation — implementation-engineer에게)

구현자가 어디에 무엇을 심을지 명세:
- **경계 1개 span/요청:** API 진입에서 `trace_id` 생성 → 모든 시도 레코드/로그/메트릭에 전파.
- **crawl-engine 반환 직후:** §2.1 시도 이벤트 1건 emit(성공 포함 전량) + `og_crawl_total{status,error_code,strategy,cache}` inc + `og_crawl_latency_seconds` observe.
- **실패 시 추가:** `failed_crawls` UPSERT(동일 키 `occurrences++`, `last_seen` 갱신).
- **재시도 시:** `og_retry_total{error_code,outcome}` inc(`outcome ∈ recovered|exhausted`).
- **규칙 적용 시:** 적용 `version`을 시도 레코드 `rule_version`에 스탬프 + `og_rule_apply_total` inc.
- **로그:** 구조적 JSON(한 줄=한 이벤트), `trace_id/domain/error_code` 필수 필드. permanent 실패는 INFO, transient 소진/page성은 ERROR.

---

## 경계면 계약

이 문서가 팀 산출물과 정합하기 위한 **명시적 계약**. 위반 시 집계·감소 루프가 깨진다.

### (a) 에러 코드 taxonomy — crawl-engine과 단일 진실
- §1 표의 에러 코드 문자열이 **유일한 정본**이다. crawl-engine이 실패를 이 코드로 emit하고, reliability-ops가 이 코드로 집계·재시도 분기한다.
- crawl-engine 초안의 요약형 `HTTP_4XX`는 운영 요구에 따라 **`HTTP_403/HTTP_404/HTTP_410/HTTP_429`(+`HTTP_4XX_OTHER`)로 세분**한 것을 확정본으로 한다. crawl-engine 측이 이 granular emit에 합의해야 한다.
- `status ∈ {ok, partial, failed}`, `fetch_strategy ∈ {static, oembed, headless}` 도 공유 enum.

### (b) platform-architect의 DB 선택 제약
- `failed_crawls`를 **`GROUP BY domain, error_code`로 SQL 집계**할 수 있어야 한다(§2.2, §5-1). 이는 플라이휠의 전제이며 **관계형 저장소(Postgres 권장)를 강제**한다 — Redis-only 불가.
- `domain`은 인덱스된 별도 컬럼(`idx_fc_domain_error`). `domain_rules`/`dlq`/`crawl_attempts`도 동일 저장소에서 조인 가능해야 함.
- 역할 분리 권고: 핫 캐시=Redis, 내구/집계=Postgres, 시계열 지표=Prometheus, 이미지=오브젝트 스토리지.

### (c) per-domain 규칙 필드 ↔ crawl-engine 소비 일치
- §6.1 `domain_rules` 필드(`force_headless, ua_override, extra_headers, extra_cookies, wait_selector, render_timeout_ms, rate_limit_rps, max_redirects, oembed_endpoint, ttl_override_sec`)는 **crawl-engine이 페치 시 읽는 필드와 이름·의미가 1:1 일치**해야 한다.
  - `ttl_override_sec`는 platform-architect(캐시 TTL)도 소비.
  - short-link 도메인 목록은 crawl-engine이 데이터로 관리(본 규칙 테이블과 별개 데이터셋) — reliability는 `input_domain` 패턴으로 등록 후보만 제안.
- 규칙 변경은 `version++` + `domain_rules_audit` 필수. crawl-engine은 `version`을 시도 레코드에 스탬프하여 델타 측정을 가능케 한다.

### 소비/생산 관계 요약
- **소비(입력):** crawl-engine 반환 스키마(`normalized_url/final_url/canonical_url/redirect_chain/fetch_strategy/error_code/completeness/latency_ms`).
- **생산(출력):** 에러 taxonomy 확정본(→crawl-engine), `failed_crawls` SQL 집계 요구(→platform-architect), `domain_rules` 필드 계약(→crawl-engine·platform-architect), 계측 명세(→implementation-engineer).
