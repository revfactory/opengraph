# 04 · 통합 경계면 정합성 리뷰 (design-integration-reviewer)

> 검증자: design-integration-reviewer (경계면 정합성 QA)
> 방법: 두 산출물을 동시에 열어 필드/계약을 나란히 대조 + 참조 구현 코드 대조 + 실제 명령 실행.
> 단일 진실 기준: `_workspace/02_integrated_architecture.md` (통합 아키텍처 확정본).
> 대상: `01_*` 4개 설계 · `02_integrated_architecture.md` · `03_reference_implementation/` · `03_implementation_notes.md`

---

## A. 실행한 검증 명령 결과 (재현 가능)

| 명령 | 결과 | 근거 |
|---|---|---|
| `node --version` | **v22.22.3** (통합 §0① Node 22 전제 충족) | 런타임 정합 |
| `npm run typecheck` (`tsc --noEmit`) | **PASS · 에러 0** (exit 0) | 전 모듈 타입 정합 |
| `npm run smoke` (`tsx scripts/smoke.ts`) | **PASS · 15/15 checks** (exit 0) | 아래 15개 순수 로직 검증 통과 |
| `grep` 레거시 에러코드 (`HTTP_4XX\b`/`HTTP_401_403`/`RENDER_FAILED`/`UNSUPPORTED_CONTENT`) | **코드 본체 0건** (주석의 "구 → 확정" 매핑 설명만 존재) | drift 없음 |
| `grep` 레거시 규칙 필드명 (`headers_override`/`force_strategy`/`default_ttl_seconds`/`needs_cookies`) | **코드 본체 0건** (주석 매핑 설명만) | drift 없음 |
| `grep` `normalizeUrl` import 사이트 | **단일 구현** `url/normalize.ts` 1개, 소비처 5곳(keys/orchestrator/unfurl-cache/safe-fetch/extract) | 공유 함수 강제 확인 |
| `grep` `payload_key_of` 호출 | `cache/unfurl-cache.ts:246` = `payload_key_of(result.canonical_url, result.og.url, result.final_url)` | 캐시key 정합 |
| 의존성 확인 | deps: `undici`/`cheerio`/`fastify`/`iconv-lite`/`ioredis`/`content-type`, optionalDeps: `playwright` | 런타임 스택 정합 |

smoke 세부(통과): normalize 5(소문자·트래킹제거·`#!`보존·중복슬래시·IDN) · ssrf 3(사설/메타데이터 차단·공인 허용·IPv4매핑 언매핑) · extract 2 · cache keys 2(payload_key 우선순위·map_key 버전) · taxonomy 3(4xx 세분·REDIRECT_LOOP 분리·429 retryable/403 permanent).

---

## B. 경계면 검증 결과 (스킬 6개 경계면)

| # 경계면 | 산출물 A 필드 | 산출물 B 필드 | 판정 | 근거 | 수정 지시 |
|---|---|---|---|---|---|
| **1** 페치 스키마 ↔ 캐시 key | crawl-engine §5/§경계면b: `normalized_url`·`final_url`·`canonical_url`(=rel=canonical→og:url→final) · `og.url` | platform §3-2/§(c): `payload_key = normalize(canonical ?? og:url ?? final)`, 1차 key=`normalized_url`, 역방향 map=`normalize(final_url)` | **PASS** | `types.ts:53-58` FetchResult가 세 URL 전부 보유. `cache/keys.ts:36-48` `payload_key_of=normalize(canonical\|\|og\|\|final)`. `unfurl-cache.ts:246` 실제 3-인자 호출, `:254` 역방향 map=`normalizeSafe(final_url)`. smoke "payload_key_of prefers canonical then og:url then final" 통과 | — |
| **2** 에러 taxonomy (단일 진실) | crawl-engine 초안 요약형(`HTTP_4XX`/`HTTP_401_403`/`RENDER_FAILED`/`UNSUPPORTED_CONTENT`, loop=TOO_MANY에 포함) | reliability-ops granular(`HTTP_403/404/410/429/4XX_OTHER`, `REDIRECT_LOOP` 분리, `RENDER_CRASH`/`NON_HTML`, `EMPTY_BODY`/`PARSE_ERROR` 신규) = 통합 §1-1 확정본 | **PASS** | `errors/taxonomy.ts` `ERROR_CODES` **28개**가 §1-1 표와 문자열 1:1 일치. `httpStatusToErrorCode()` 403/404/410/429 개별 + 401→`HTTP_4XX_OTHER`. `REDIRECT_LOOP`(visited) ↔ `TOO_MANY_REDIRECTS`(hop 상한) 별도. `errorClass/stage/category`를 `ERROR_META` 파생상수로 동봉 → `FailedCrawlRecord`+DDL에서 별도 컬럼. 27개 코드의 errorClass/stage 전수 대조 일치(DNS_FAIL=permanent/no 확정값 반영) | — |
| **3** 저장소 요구 ↔ DB 선택 | reliability-ops §2.2/§b: `failed_crawls`를 `GROUP BY domain,error_code` SQL 집계 + `error_class`/`stage` 별도 컬럼 강제 | platform §4/§(b): **Redis+Postgres**, `failed_crawls`(domain/error_code 인덱스), Redis-only 불가 명시 | **PASS** (핵심) | `persistence/postgres.ts` DDL: `failed_crawls`에 `error_code`+`error_class`+`stage` 별도 컬럼 + `idx_fc_domain_error(domain,error_code)` + `UNIQUE(domain,error_code,final_url)` 롤업. `orchestrator.fail()`이 `error_class:meta.errorClass, stage:meta.stage` 채움. Postgres 선택이 SQL 집계 요구 충족 | — |
| **3b** (하위 GAP) 성공률 델타 측정 테이블 | reliability-ops §2.1/§5-5: 단일 append-only **`crawl_attempts`**(전 시도, ok/partial/failed 모두) — `AVG((status<>'failed')) FROM crawl_attempts GROUP BY (rule_version>=N)` | platform §4-2 + 구현: **`crawls`**(성공만, `writeCrawl`은 status≠failed 분기에서만 호출) + `failed_crawls`(실패만) | **GAP** | reliability-ops §5-5 델타 쿼리는 성공+실패가 **한 테이블**에 있어야 계산 가능. 구현은 성공→`crawls`(unfurl-cache.ts:265, non-failed 분기), 실패→`failed_crawls`(orchestrator.ts:106)로 **분리** 저장하고 `crawl_attempts`라는 통합 시도 로그가 없음. 통합 §2는 `crawls`, 통합 §1-2/reliability §5-5·§6.1·§b는 `crawl_attempts`로 **명칭도 불일치** | 리더 확정 필요: (택1) ① reliability-ops §5-5 델타 쿼리를 `crawls`⊕`failed_crawls` 조인/UNION 기준으로 개정하고 통합 §1-2 주석의 `crawl_attempts`→`crawls`로 통일, 또는 ② 구현이 전 시도를 `crawl_attempts`(status 포함) append-only로 남기도록 `writeCrawl`을 성공/실패 공통 경로로 이동. 명칭을 한쪽으로 확정할 것 |
| **4** 런타임 전제 ↔ 엔진 요구 | crawl-engine §경계면(d): static은 **커스텀 resolver/connect-to-IP(핀)** + **자동 리다이렉트 off(수동)** 필수, 파싱 cheerio, 헤드리스 Playwright | runtime §(a)(b): Node 22 + `undici`/`cheerio`/`playwright` 확정 | **PASS** | `safe-fetch.ts`: undici `Agent({connect:{lookup:pinnedLookup(...)}})`로 검증 IP 핀 + `maxRedirections:0`(수동). `extract-og.ts` cheerio. `strategy/headless.ts` playwright 동적 import(optionalDep) + 미설치 시 `RENDER_CRASH` graceful fallback. 엔진의 IP핀·수동리다이렉트 요건을 런타임 스택이 지원 | — |
| **5** per-domain 규칙 계약 | reliability-ops §6.1 생산 필드 + crawl-engine §경계면(c) 소비 필드 | 통합 §1-2 확정 `domain_rules` 스키마(union) | **PASS** | `rules/domain-rules.ts` `DomainRule`이 §1-2 필드와 1:1(force_headless/is_short_link/ua_override/extra_headers/extra_cookies/wait_selector/click_selector/render_timeout_ms/rate_limit_rps/max_redirects/body_byte_cap/robots_mode/allow_headless_on_challenge/oembed_endpoint/ttl_override_sec/enabled/version). safe-fetch/strategy/cache가 이 타입 소비. `updated_by/updated_at`는 DB 감사 컬럼(엔진 미소비, 정상) | 없음 (advisory: reliability §6.1 DDL은 `is_short_link/click_selector/body_byte_cap/robots_mode/allow_headless_on_challenge` 누락 서브셋, platform §4-2는 `force_strategy/default_ttl_seconds/needs_cookies` 구명칭 — **둘 다 통합 §1-2가 이미 대체**, 구현은 §1-2 준수. 원 설계 문서 각주 정리 권고) |
| **6** 구현 ↔ 설계 | 통합 §4/§1-1/§1-3/§1-4: SSRF(DNS후+홉마다+IP핀), normalize 단일 공유, completeness 0.4/0.3/0.3 & ok⟺≥0.66 | 참조 구현 코드 | **PASS** | (SSRF) `ssrf-guard.ts` DNS `lookup(all)` 후 **모든** IP `isBlockedIp` + IPv4매핑 언매핑 재적용 + pinnedIp; `safe-fetch.ts` 3xx/meta-refresh **홉마다** `precheck` 재호출 + `pinnedLookup`. (normalize) 물리적 함수 1개, 소비처 5곳 모두 import. (completeness) `extract-og.ts:231` `0.4·title+0.3·desc+0.3·image`, `config COMPLETE_THRESHOLD=0.66`, `orchestrator.statusOf`·`fetch-strategy.decideEscalation` 동일 상수 참조 | — |

---

## C. 통합 §4 QA 검증 포인트 6개 (확정본이 넘긴 항목)

| # | 검증 포인트 | 판정 | 근거 |
|---|---|---|---|
| 1 | 에러 taxonomy 동일 문자열(§1-1) | **PASS** | `taxonomy.ts` 28코드 == §1-1. 전 모듈이 `ErrorCode` 유니온만 사용, `isKnownErrorCode` 가드. 레거시 문자열 grep 0건 |
| 2 | domain_rules 동일 필드명(§1-2) | **PASS** | `DomainRule` == §1-2 union 1:1. 레거시 필드명 grep 0건 |
| 3 | normalize_url 단일 공유 함수(§1-3) | **PASS** | `url/normalize.ts` 1개 구현, `#!` 보존. API(캐시경유)·워커(orchestrator)·엔진(safe-fetch/extract)·key(keys) 전부 동일 import |
| 4 | payload_key = normalize(canonical ?? og:url ?? final) | **PASS** | `keys.ts payload_key_of` + `unfurl-cache.ts:246` 실호출. smoke 검증 통과 |
| 5 | SSRF: DNS 해석 후 + 홉마다 + IP 핀 | **PASS** | `ssrf-guard.ts`(DNS all + 전체 IP 검사 + 핀) + `safe-fetch.ts`(홉마다 precheck + pinnedLookup). smoke ssrf 3종 통과 |
| 6 | completeness 임계 정합(§1-4: ok⟺≥0.66) | **PASS** | config 0.66 단일 상수 참조. advisory: reliability-ops §0 SLO표 "Fresh Success Ratio(완성도≥0.5)" 괄호값이 §1-4에서 status=ok(≥0.66) 기준으로 확정됨 — reliability §0의 `0.5` 괄호는 stale 참고값, 지표 정의 문구 정리 권고 |

---

## D. 종합

- **PASS: 11 / MISMATCH: 0 / GAP: 1** (경계면 6개 중 5 PASS · 하위 GAP 1건 [3b] + §4 검증 6/6 PASS)
- **확정 계약(통합 §1-1/§1-2/§1-3/§1-4/§3) ↔ 코드 사이 MISMATCH 없음.** 에러 taxonomy 28코드·domain_rules 필드·normalize 단일함수·payload_key 우선순위·SSRF 3중방어·completeness 임계가 모두 일치.
- **잔여 이슈 1건(GAP, non-blocking) — 재작업 대상: reliability-ops-engineer + 리더(통합 §1-2 명칭 확정):**
  - 성공률 델타 측정 테이블 명칭/모델 불일치. reliability-ops §5-5의 `FROM crawl_attempts ... AVG(status<>'failed')` 단일 시도 로그 가정 ↔ 구현/platform의 `crawls`(성공)+`failed_crawls`(실패) 분리 저장. `crawl_attempts` 통합 append-only 테이블이 구현에 부재. → 쿼리를 조인/UNION으로 개정하거나 전 시도 append-only 테이블을 도입하고, 명칭을 `crawls`/`crawl_attempts` 한쪽으로 통일할 것.
- **비차단 advisory 3건(원 설계 문서 각주 정리, 코드/확정본은 이미 정합):** ① platform §4-2 예시 DDL이 구명칭(`force_strategy`/`default_ttl_seconds`/`needs_cookies`) + `failed_crawls`에 error_class/stage 컬럼 누락 — 통합 §1-1/§1-2가 이미 대체. ② reliability §6.1 domain_rules DDL이 §1-2 대비 필드 서브셋. ③ reliability §0 Fresh Success Ratio "완성도≥0.5" 괄호값 — §1-4에서 ≥0.66(status=ok)로 확정.
- **검증 실행 상태:** typecheck 에러 0 · smoke 15/15 · Node 22 · 레거시 심볼 grep 0건. **참조 구현은 확정 경계면 계약을 코드로 충실히 반영함.**
