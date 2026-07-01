# 통합 아키텍처 — URL → Open Graph 추출 기능

> 통합: 오케스트레이터(리더). 입력: `_workspace/01_*` 4개 설계.
> 목적: 4개 고려사항의 최종 결정을 하나로 수렴하고, 산출물 간 **경계면 불일치를 확정 해소**한다.
> 상충은 삭제하지 않고 출처를 병기한 뒤 리더 판단으로 확정한다.

---

## 0. 4개 고려사항 — 최종 결정 요약

| # | 고려사항 | 최종 결정 (한 줄) | 근거 문서 |
|---|---|---|---|
| ① | 런타임 선택 | **그린필드 = Node.js 22(TS) + Fastify. 조직이 Python 중심이면 FastAPI로 반전.** 크롤러를 독립 마이크로서비스로 격리해 결정을 되돌릴 수 있게 한다 | `01_runtime_strategist` |
| ② | 실패 추적/실패율 감소 | **단일 에러 taxonomy + `failed_crawls`(Postgres) 집계 + per-domain 규칙 테이블(레버) + 주간 플라이휠(집계→진단→규칙→재시도/백필→측정)** | `01_reliability_ops` |
| ③ | 정적이지 않은 링크 | **비용 순 승격 래더(static→oEmbed→headless), 신호 기반 헤드리스 승격, 리다이렉트/단축링크 끝까지 추적해 최종 URL 확정, SSRF는 DNS 해석 후+홉마다** | `01_crawl_engine` |
| ④ | 아키텍처/캐싱/DB/속도 | **2단계 캐시 key(정규화 URL→payload_key, payload_key=canonical??og:url??final_url) + SWR + single-flight, Redis(핫)+Postgres(집계/내구)+오브젝트스토리지(이미지)** | `01_platform` |

**전체를 관통하는 3대 불변식**
1. **최종 URL이 진실의 원천** — 리다이렉트/단축링크 종점을 파싱·캐싱·SSRF 검증의 기준으로 삼는다.
2. **비용 순 승격** — 헤드리스는 신호가 있을 때만. "일단 헤드리스" 금지.
3. **분류 없는 실패는 못 고친다** — 모든 실패에 단일 에러 코드를 부여해 집계·감소 루프의 연료로 쓴다.

---

## 1. 경계면 불일치 해소 (리더 확정)

4개 설계를 대조한 결과 3건의 경계면 조정이 필요했다. 아래를 **확정본**으로 하고, 참조 구현·검증은 이를 단일 진실로 따른다.

### 1-1. [MISMATCH 해소] 에러 코드 Taxonomy — 확정본

- **충돌:** crawl-engine 초안은 요약형(`HTTP_4XX`, `HTTP_401_403`, `RENDER_FAILED`, `UNSUPPORTED_CONTENT`, `TOO_MANY_REDIRECTS`에 loop 포함)을 썼고, reliability-ops는 운영상 서로 다른 레버가 필요하므로 4xx 세분(`HTTP_403/404/410/429`)과 별도 코드(`REDIRECT_LOOP`, `EMPTY_BODY`, `PARSE_ERROR`, `RENDER_CRASH`)를 요구했다. 두 에이전트 모두 이 불일치를 스스로 지목함.
- **확정:** **reliability-ops의 granular 집합을 단일 진실로 채택**한다(운영 레버가 세분을 요구하므로). crawl-engine은 이 코드를 emit한다.

| 확정 error_code | error_class | stage | retryable | 비고 (구 crawl-engine 명 → 확정명) |
|---|---|---|---|---|
| `NO_OG_TAGS` | permanent* | parse | no | (동일) *SPA 신호 시 헤드리스 승격 |
| `PARSE_ERROR` | permanent | parse | no | 신규 채택 |
| `NON_HTML` | permanent | parse | no | `UNSUPPORTED_CONTENT` → **`NON_HTML`** |
| `EMPTY_BODY` | transient | fetch | yes(1) | 신규 채택 |
| `TOO_LARGE` | permanent | fetch | no | (동일) |
| `DNS_FAIL` | permanent | resolve | no | (동일) |
| `CONN_TIMEOUT` | transient | connect | yes | (동일) |
| `CONN_REFUSED` | transient | connect | yes(제한) | 신규 채택 |
| `READ_TIMEOUT` | transient | fetch | yes | crawl-engine 유지(ops 재시도표에 편입) |
| `TLS_ERROR` | permanent | connect | no | (동일) |
| `HTTP_403` | permanent→규칙 | fetch | no | `HTTP_401_403` → **`HTTP_403`**(401은 `HTTP_4XX_OTHER`) |
| `HTTP_404` | permanent | fetch | no | 세분 |
| `HTTP_410` | permanent | fetch | no | 세분 |
| `HTTP_429` | transient | fetch | yes(Retry-After) | (동일) |
| `HTTP_4XX_OTHER` | permanent | fetch | no | 그 외 4xx 폴백(401 포함) |
| `HTTP_5XX` | transient | fetch | yes | (동일) |
| `TOO_MANY_REDIRECTS` | permanent | redirect | no | 홉 상한 초과 |
| `REDIRECT_LOOP` | permanent | redirect | no | **분리**(구: TOO_MANY_REDIRECTS에 포함) |
| `JS_TIMEOUT` | transient | render | yes(1) | (동일) |
| `RENDER_CRASH` | transient | render | yes(1) | `RENDER_FAILED` → **`RENDER_CRASH`** |
| `BOT_CHALLENGE` | anti-bot | fetch/render | conditional | (동일) |
| `OEMBED_FAILED` | transient | oembed | yes | (동일) |
| `SSRF_BLOCKED` | permanent | precheck/redirect | no | (동일) |
| `SCHEME_BLOCKED` | permanent | precheck | no | (동일) |
| `PORT_BLOCKED` | permanent | precheck | no | (동일) |
| `ROBOTS_DISALLOWED` | permanent | precheck | no | (동일) |
| `INVALID_URL` | permanent | normalize | no | (동일) |
| `UNKNOWN` | permanent | any | no | 미분류(운영 알림) |

- `error_class`(transient/permanent)·`stage`·`category`는 `failed_crawls`에 **별도 컬럼**으로 저장(문자열 파싱 금지) — SQL 집계 성능.
- `status ∈ {ok, partial, failed}`, `fetch_strategy ∈ {static, oembed, headless}`는 공유 enum.

### 1-2. [DRIFT 해소] `domain_rules` 스키마 — 확정본

세 문서가 필드명이 갈렸다(`force_headless`(engine/ops) vs `force_strategy`(platform); `headers_override`(engine) vs `extra_headers`(ops); `rate_limit{rps,burst}`(engine) vs `rate_limit_rps`(ops/platform); `ttl_override_sec`(ops) vs `default_ttl_seconds`(platform)). **확정 스키마**(crawl-engine 소비 · platform TTL 소비 · reliability-ops 생산):

```sql
domain_rules(
  domain            TEXT PRIMARY KEY,          -- final_url 기준 eTLD+1
  force_headless    BOOLEAN DEFAULT false,     -- 확정(엔진 소비). platform 'force_strategy'는 이 값으로 매핑
  is_short_link     BOOLEAN DEFAULT false,     -- 단축링크 완전해석+short_map 캐시(엔진)
  ua_override       TEXT,
  extra_headers     JSONB,                     -- 확정(구 headers_override 통합)
  extra_cookies     JSONB,
  wait_selector     TEXT,
  click_selector    TEXT,
  render_timeout_ms INT,
  rate_limit_rps    NUMERIC,                   -- 확정(구 rate_limit{rps,burst}의 rps; burst는 extra로)
  max_redirects     INT,
  body_byte_cap     INT,
  robots_mode       TEXT DEFAULT 'respect',    -- respect|ignore
  allow_headless_on_challenge BOOLEAN DEFAULT false,
  oembed_endpoint   TEXT,
  ttl_override_sec  INT,                        -- 확정(platform 캐시 TTL 소비. 구 default_ttl_seconds)
  enabled           BOOLEAN DEFAULT true,
  version           INT DEFAULT 1,             -- 변경 시 ++, crawl_attempts.rule_version에 스탬프
  updated_by TEXT, updated_at TIMESTAMPTZ DEFAULT now()
)
```
- platform이 쓰던 `force_strategy(static|headless)`는 `force_headless` bool로 흡수(static 강제는 불필요 — 기본이 static). `needs_cookies`는 `extra_cookies` 유무로 대체.

### 1-3. [정합 확인] 공유 `normalize_url` — 단일 구현

세 문서가 "정규화는 하나의 순수 함수로 공유"에 합의. **platform §3-1의 8단계 규칙(버전 `v1`)을 정본**으로 하고 crawl-engine이 동일 구현으로 `normalized_url`을 채운다. 유일한 미세 차이(hashbang `#!` 보존)는 **보존으로 통일**(구형 AJAX 크롤 스킴 대응). 정규화가 양측에서 갈리면 캐시 히트가 깨지므로 **공유 라이브러리 1개**로 강제한다.

### 1-4. [GAP 표기] completeness 임계 정합
- crawl-engine: `status=ok ⟺ completeness ≥ 0.66`. reliability-ops의 "Fresh Success Ratio"는 `status=ok`를 세되 괄호에 `completeness ≥ 0.5`로 적었다. **확정:** `status`는 crawl-engine이 소유(≥0.66=ok). reliability-ops의 Fresh 지표는 `status=ok` 기준을 사용한다(0.5 괄호는 참고값). QA가 이 정합을 확인.

---

## 2. 통합 데이터 흐름 (4개 설계를 하나로)

```
[클라이언트] GET /unfurl?url=X
   │
   ▼  (API 티어 · 조직 표준 언어 무관 — ①격리)
normalize_url(X)=norm ─────────────► 공유 순수함수(§1-3)
   │
   ├─ L1 LRU / L2 Redis 조회 (④캐싱)
   │     og:map:{norm}→payload_key→og:pl:{payload_key}
   │     ├ fresh → 반환(hit)   ├ stale → 반환+백그라운드갱신(SWR)   ├ neg → 실패 반환
   │
   └─ MISS → single-flight lock(og:lock:{norm})  (④스탬피드 방지)
        │
        ▼  (크롤/추출 마이크로서비스 — ①런타임 결정 봉인 지점)
        [Stage0] 정규화+SSRF 사전검증(DNS해석 IP핀)   (③안전)
        [Stage1] static fetch: 수동 리다이렉트 추적(홉마다 SSRF 재검증),
                 단축링크 최종 URL 확정, Range로 <head>만            (③)
        [승격판단] 신호 기반 → oEmbed(Stage2) / headless(Stage3)     (③)
        [폴백 파싱] OG→Twitter→oEmbed→JSON-LD→HTML, completeness      (③)
        │
        ▼ 표준 반환 스키마(normalized/final/canonical URL, redirect_chain,
        │                   fetch_strategy, error_code, completeness)
        │
        ├─►(④) payload_key=normalize(canonical??og:url??final)
        │      Redis write: og:pl:{payload_key}, og:map:{norm}, og:map:{final} 역방향
        │      Postgres write: crawls / (실패 시) failed_crawls  (②추적)
        │      실패 시 negative-cache + 메트릭/이벤트 emit         (②)
        │
        └─►(②) 계측: og_crawl_total{status,error_code,strategy,cache}, latency,
                     failed_crawls UPSERT(domain×error_code), rule_version 스탬프
   │
   ▼
[비동기 루프](②) 큐→재시도(transient, 백오프)→DLQ→주간 플라이휠(집계→진단→규칙→백필→측정)
                 규칙은 domain_rules(§1-2)에 기록 → 크롤 워커가 hot-reload 소비 → 실패율 우하향
```

## 3. 컴포넌트 ↔ 저장소 매핑 (④ DB 선택 확정)

| 컴포넌트 | 저장소 | 이유 |
|---|---|---|
| OG payload 핫 캐시 / `norm→payload_key` 매핑 / single-flight 락 | **Redis** | µs 핫 KV, TTL 네이티브, SWR/락 |
| `crawls` / `failed_crawls` / `domain_rules` / `dlq` / payload 내구 사본 | **PostgreSQL** | `GROUP BY domain,error_code` SQL 집계(②의 강제 제약), JSONB payload |
| `og:image` 프록시/리사이즈 사본 | **오브젝트 스토리지(S3/GCS)+CDN** | 핫링크/깨진 이미지 방지 |
| 시계열 메트릭 | **Prometheus** | SLO/알림/대시보드 |
| short→final 매핑 | Redis `short_map`(긴 TTL) | 재해석 비용 0 |

> **"DB가 필요한가"의 확정 답:** 순수 캐시만이면 Redis-only도 가능하나, **고려사항 ②(실패 추적/감소)가 조회 가능한 내구 저장소를 강제** → `Redis + Postgres`가 기준선. 이 조합이 도메인의 95%를 커버.

## 3-bis. [GAP 3b 해소 — 리더 확정] 크롤 저장 모델: `crawl_attempts` 정본

QA가 발견한 GAP: reliability-ops의 플라이휠 델타 측정(§5-5)은 **전 시도가 한 테이블**에 있어야 하는데, 구현/platform은 성공→`crawls` / 실패→`failed_crawls`로 분리 저장하고 통합 append-only 로그가 없었다. 명칭도 통합 §2(`crawls`) ↔ reliability(`crawl_attempts`)로 갈렸다.

**리더 확정:** 세 테이블의 역할을 분리하고 `crawl_attempts`를 정본으로 채택한다.

| 테이블 | 역할 | 정본 문서 |
|---|---|---|
| **`crawl_attempts`** (정본, append-only) | **모든** 시도(ok/partial/failed) 1행. `status,error_code,error_class,stage,domain,fetch_strategy,http_status,completeness,latency_ms,rule_version,cache,ts` 보유. **§5-5 델타 측정·SLO 드릴다운·감사의 단일 소스** | reliability §2.1/§5-5 |
| **`failed_crawls`** (롤업 뷰) | `(domain,error_code,final_url)` 미해소 실패 집계(occurrences/resolved). **플라이휠 §5-1 top-N 전용.** 실패 시도에서 파생/유지 | reliability §2.2 |
| **`crawls`** (선택·머티리얼라이즈) | 최신 성공 payload 내구 사본(캐시 재구축/프리워밍용) | platform §4-2 |

**구현 조치(implementation-engineer 부분 재실행):** 모든 시도(성공·실패)를 단일 `writeAttempt()` 경로로 `crawl_attempts`에 append. 기존 `failed_crawls` UPSERT·`crawls` payload 쓰기는 파생으로 유지. reliability §5-5 델타 쿼리의 `FROM crawl_attempts`가 이제 유효. 명칭은 `crawl_attempts`로 통일(통합 §2 다이어그램의 `crawls` 언급은 payload 사본을 가리키는 것으로 각주).

## 3-ter. [기능 추가] 봇 차단(403) 회복 래더 — per-domain UA/헤드리스 전환 + 규칙 학습

고려사항 ②③의 실제 동작. 원본이 기본 UA를 봇으로 차단(`HTTP_403`/`BOT_CHALLENGE`)했을 때 즉시 실패하지 않고 전환한다. 근거: crawl §1.2.2(챌린지 마커) + reliability-ops §5-2/§5-3(패턴→규칙 레버) + §6.3(canary 학습).

**래더(orchestrator, static 실패 시):**
1. **① per-domain UA 오버라이드 전환** — 프리뷰-봇 UA(`facebookexternalhit/1.1`→`Twitterbot`→브라우저 UA)로 순차 재시도. 대다수 사이트가 링크 프리뷰용으로 화이트리스트하는 관행 활용.
2. **② 헤드리스 전환** — UA로도 막히면 실브라우저(Playwright) 렌더로 통과 시도.
3. **③ 실패** — 둘 다 막히면 `HTTP_403` 실패로 보고하되 `allow_headless_on_challenge` 규칙을 제안(다음엔 처음부터 헤드리스).

**규칙 학습(플라이휠 폐곡선):** ①/②로 통과하면 그 도메인 규칙(`ua_override`/`force_headless`)을 `DomainRuleStore.learn()`으로 학습 → **다음 요청부터 `resolve()`가 base 규칙 위에 오버레이해 처음부터 적용**(hot-reload 생존). 프로덕션은 canary→measure(§6.3) 후 Postgres `domain_rules` 승격. 반환 스키마에 `recovery: { via, ua?, learned }` 추가(응답 `?debug=true`로 노출, 플레이그라운드가 회복 배지 표시).

구현: `strategy/bot-recovery.ts`(순수 헬퍼) + `orchestrator.ts`(래더) + `rules/domain-rules.ts`(학습 오버레이). 검증: smoke 3종 + 무네트워크 통합 e2e(403→ua_override 회복→학습→2차 무회복) — 모두 통과. 코어 로직(normalize/ssrf/extract/keys/taxonomy) 무변경, 어댑터/오케스트레이션 계층에만 추가.

## 4. QA(design-integration-reviewer)에게 넘기는 검증 포인트
1. 경계면 #2(에러 taxonomy): §1-1 확정본을 crawl-engine·reliability-ops·구현이 **동일 문자열**로 쓰는지.
2. 경계면 domain_rules: §1-2 확정 스키마를 3자가 동일 필드명으로 쓰는지.
3. 경계면 normalize_url: 구현이 **단일 공유 함수**를 API·워커·엔진에 쓰는지(§1-3).
4. 캐시 key ↔ 페치 스키마: payload_key = normalize(canonical??og:url??final)가 코드에 정확히 반영되는지.
5. SSRF: 구현이 **DNS 해석 후 + 리다이렉트 홉마다** 검증하고 IP를 핀하는지.
6. completeness 임계(§1-4) 정합.
