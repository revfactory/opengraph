---
name: crawl-reliability-ops
description: "크롤링 실패를 추적하고 실패율을 지속적으로 낮추는 운영/관측 체계를 설계하는 스킬. 실패 분류 체계(error taxonomy), 크롤 레코드 스키마, 메트릭 카탈로그, SLO 기반 알림, dead-letter queue, per-domain 규칙 테이블 기반 실패율 감소 플라이휠을 산출한다. 실패 링크 추적·모니터링·실패율 감소·관측성·대시보드·재시도 정책 논의 시 반드시 이 스킬을 사용할 것."
---

# Crawl Reliability & Ops — 실패 추적과 실패율 감소 체계

크롤링은 외부 의존이라 본질적으로 불안정하다. 이 스킬은 **모든 실패를 조회 가능하게 추적하고, 데이터로 실패율을 꾸준히 낮추는 플라이휠**을 설계한다. 핵심 원리: **분류 없는 실패는 못 고친다**, **감소 레버는 per-domain 규칙 테이블**.

## 언제 이 스킬을 쓰는가
실패 링크 추적, 크롤 모니터링, 실패율 감소, 관측성(로그/메트릭/트레이스), 알림/SLO, 재시도·DLQ·백필 설계.

---

## 1. 실패 분류 체계 (Error Taxonomy)

모든 실패에 **조회 가능한 에러 코드**를 부여한다. 이 코드 집합은 crawl-engine과 **단일 진실**로 공유한다.

| 범주 | 에러 코드 | 성격 | 대응 |
|---|---|---|---|
| 네트워크 | `DNS_FAIL`, `CONN_TIMEOUT`, `CONN_REFUSED`, `TLS_ERROR` | transient/permanent 혼재 | 재시도(백오프) |
| HTTP | `HTTP_403`(봇차단), `HTTP_404`, `HTTP_410`, `HTTP_429`(rate-limit), `HTTP_5XX` | 403/404/410 permanent, 429/5xx transient | 규칙(UA)·재시도·`Retry-After` |
| 콘텐츠 | `NO_OG_TAGS`, `PARSE_ERROR`, `NON_HTML`, `EMPTY_BODY`, `TOO_LARGE` | permanent | 폴백/헤드리스 승격 |
| 렌더링 | `JS_TIMEOUT`, `RENDER_CRASH` | transient | 재시도·타임아웃 조정 |
| 정책 | `SSRF_BLOCKED`, `ROBOTS_DISALLOWED`, `REDIRECT_LOOP`, `TOO_MANY_REDIRECTS` | permanent | 차단 유지(정상 동작) |

**transient(재시도 가치 있음)**: timeout, 5xx, 429, RENDER_CRASH. **permanent(재시도 무의미)**: 404, 410, SSRF_BLOCKED, ROBOTS_DISALLOWED, NON_HTML. 이 구분이 재시도 정책의 근간이다.

---

## 2. 크롤 레코드 스키마 (추적의 원자)

모든 크롤 **시도**를 구조적 레코드로 남긴다. 실패는 여기에 더해 dead-letter queue / `failed_crawls` 테이블로.

```json
{
  "trace_id": "uuid",
  "input_url": "...", "normalized_url": "...", "final_url": "...",
  "domain": "example.com",           // 집계의 축 — 반드시 별도 컬럼
  "status": "ok | partial | failed",
  "error_code": "HTTP_429 | null",
  "fetch_strategy": "static | oembed | headless",
  "http_status": 429,
  "redirect_hops": 2,
  "latency_ms": 812,
  "attempt_no": 1,
  "worker_id": "w-03",
  "cache": "hit | miss | stale",
  "ts": "ISO-8601"
}
```

`domain`을 별도 컬럼으로 두는 것이 중요하다 — 실패율 감소 플라이휠 전체가 **도메인 × 에러코드 집계**에 의존하기 때문.

---

## 3. 메트릭 카탈로그 (행동으로 이어지는 것만)

OpenTelemetry/Prometheus 기준. 대시보드는 "가장 많이 실패하는 도메인 top-N"을 항상 노출한다.

| 메트릭 | 타입 | 라벨 | 용도 |
|---|---|---|---|
| `og_crawl_total` | counter | `status, error_code, strategy` | 성공률·에러 분포 |
| `og_crawl_latency_seconds` | histogram | `strategy, cache` | p50/p95/p99 지연 |
| `og_crawl_success_ratio` | gauge(파생) | `domain(top-N)` | 도메인별 성공률 |
| `og_cache_hit_ratio` | gauge | — | 캐시 효율 |
| `og_headless_fallback_ratio` | gauge | — | 비용 신호(헤드리스 승격률) |
| `og_dlq_depth` | gauge | — | 미처리 실패 적체 |

---

## 4. 알림 규칙 (SLO 기반)

| 조건 | 심각도 | 의미/대응 |
|---|---|---|
| 전체 성공률 < 95% (5분) | page | SLO 위반 — 광범위 장애 |
| p95 지연 > 임계 | warn | 헤드리스 승격 급증 또는 origin 지연 |
| `og_dlq_depth` 지속 증가 | warn | 재시도 처리 지연 |
| 특정 도메인 `HTTP_429` 급증 | warn | 크롤 예산 초과 → rate-limit 규칙 자동 제안 |
| 특정 에러코드 급증 | warn | 신규 실패 패턴 등장 → 규칙 추가 검토 |

---

## 5. 실패율 감소 플라이휠 (핵심)

실패율 감소는 일회성이 아니라 **반복 루프**다.

```
1. 집계   : failed_crawls를 domain × error_code로 집계 (SQL) → top 실패 도메인
2. 진단   : 패턴 식별
             · HTTP_403만 발생 → 기본 UA 차단 → 브라우저 UA/헤드리스 필요
             · NO_OG_TAGS + SPA 신호 → JS 렌더링 페이지 → force-headless
             · 단축/트래킹 변형 다수 → 최종 URL 캐싱 미흡
3. 규칙   : per-domain 규칙 테이블에 오버라이드 추가 (아래 6절)
4. 재시도 : transient 실패는 지수 백오프+지터로 재시도, DLQ 재처리 잡
5. 측정   : 규칙 적용 전후 도메인 성공률 델타 확인
6. 리뷰   : 주간으로 1~5 반복 → 실패율이 우상향이 아니라 우하향하게 만든다
```

**이 플라이휠이 "실패율을 어떻게 낮춰 나가는가"의 답이다.** 레버는 규칙 테이블, 연료는 집계 가능한 실패 데이터.

---

## 6. Per-Domain 규칙 테이블 (감소 레버)

운영자가 **코드 배포 없이** 갱신하는 데이터 테이블. 크롤 엔진이 매 요청 시 조회한다.

```json
{
  "domain": "twitter.com",
  "force_headless": false,
  "ua_override": "Mozilla/5.0 ... (facebookexternalhit 유사)",
  "extra_headers": {"Accept-Language": "en"},
  "wait_selector": "meta[property='og:title']",
  "rate_limit_rps": 2,
  "oembed_endpoint": "https://publish.twitter.com/oembed",
  "ttl_override_sec": 86400,
  "notes": "기본 UA에 403 → facebookexternalhit 계열 UA로 우회"
}
```

필드는 crawl-engine이 소비한다(단일 진실). 규칙 변경은 감사 로그로 남긴다.

---

## 7. 재시도 / DLQ / 백필

- **재시도**: transient만. 지수 백오프 + 지터(예: 1s, 4s, 15s), 최대 3회. `HTTP_429`는 `Retry-After` 우선.
- **DLQ**: 최대 재시도 초과 실패는 dead-letter queue로. 주기적 재처리 잡이 규칙 갱신 후 재시도.
- **백필**: 신규 규칙 배포 후, 해당 도메인의 과거 실패를 재크롤하여 캐시 채움 → 성공률 즉시 회복.

## 출력 형식
(1) 에러 taxonomy 표 → (2) 크롤 레코드 스키마 → (3) 메트릭 카탈로그 → (4) 알림 규칙 → (5) 감소 플라이휠 단계 → (6) per-domain 규칙 스키마 → (7) 재시도/DLQ/백필 정책.

## 원칙
- **분류 없는 실패는 못 고친다.** 에러 코드 taxonomy를 crawl-engine과 단일 진실로 공유한다.
- **메트릭은 행동으로 이어지는 것만.** 도메인별 성공률·에러 분포·DLQ 깊이가 핵심.
- **감소는 루프다.** 규칙 테이블(레버) + 집계 가능한 실패 데이터(연료)로 주간 반복.
- failed_crawls의 SQL 집계 요구는 platform-architect의 **DB 선택 제약**이 된다 — 반드시 전달.
