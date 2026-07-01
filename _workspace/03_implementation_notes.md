# 03 · 참조 구현 노트 — ADR + 실행 안내 + 설계→코드 매핑

> 작성: implementation-engineer
> 대상: `_workspace/03_reference_implementation/` (Node.js 22 + TypeScript + Fastify)
> 단일 진실: `_workspace/02_integrated_architecture.md` (통합 아키텍처 = 확정 경계면 계약)
> 목적: 각 **확정 결정이 어느 파일에 어떻게 반영됐는지** 명시해 QA(design-integration-reviewer) 검증을 쉽게 한다.

검증 상태: `npm run typecheck` 에러 0 · `npm run smoke` 15/15 통과 · 라이브 e2e(example.com 추출 / 169.254.169.254 SSRF 차단 / 잘못된 URL) 정상.

---

## 1. ADR — 주요 결정과 근거 (왜 그렇게 했나)

### ADR-1. 런타임 = Node.js 22 + TypeScript + Fastify (고정)
통합 §0①·runtime-strategist §(a) 확정. 임의 변경 없이 그대로 채택. 페치=`undici`(수동 리다이렉트·IP 핀·타임아웃 세분), 파싱=`cheerio`, 헤드리스=`playwright`(optional dep). ESM + NodeNext.
**왜:** I/O 바운드 다중 페치에 이벤트 루프가 구조적으로 적합 + OG 도메인 생태계 성숙. 결정은 크롤/추출 마이크로서비스에 국한되며 API 계층 계약은 언어중립 JSON(`types.ts`).

### ADR-2. 에러 taxonomy = reliability-ops granular 집합 (단일 enum)
통합 §1-1 확정본을 `errors/taxonomy.ts` 한 파일의 `as const` 유니온으로 못박음. 4xx 세분(`HTTP_403/404/410/429/4XX_OTHER`), `REDIRECT_LOOP`를 `TOO_MANY_REDIRECTS`에서 **분리**, `RENDER_CRASH`/`NON_HTML` 확정명 사용.
**왜:** 운영 레버가 코드별로 다름(403=UA/헤드리스, 429=rate_limit, 404=종결). `errorClass/stage/category`를 **파생 상수**로 동봉해 `failed_crawls` 별도 컬럼 저장(문자열 파싱 금지) 계약을 코드로 강제.

### ADR-3. normalize_url = 단일 순수 함수 (공유 강제)
통합 §1-3. `url/normalize.ts` 하나만 존재하고 API·캐시 key·orchestrator가 전부 이 함수를 import. WHATWG `URL`을 1차 파서로(소문자·punycode·퍼센트·dot-segment 규격 처리) 쓰고 그 위에 트래킹 제거·쿼리 정렬·`#!` 보존을 얹었다.
**왜:** 정규화가 양측에서 갈리면 캐시 히트가 깨진다 → 물리적으로 함수 1개만 두어 drift 원천 차단. hashbang 보존은 §1-3 확정.

### ADR-4. SSRF = DNS 해석 후 + 홉마다 + IP 핀 (self-contained CIDR)
`fetch/ssrf-guard.ts`가 스킴/포트 허용목록 + DNS 해석 후 **모든** 응답 IP 검사 + IPv4-매핑 v6 언매핑 재적용 + 핀. `fetch/safe-fetch.ts`가 리다이렉트/meta-refresh **홉마다** `ssrfPrecheck`를 재호출하고, undici `Agent`의 커스텀 `connect.lookup`으로 검증된 IP에만 커넥트(리바인딩 방지).
**왜:** 리다이렉트가 내부 IP를 가리키는 것이 가장 흔한 우회. CIDR 매칭은 BigInt로 자체 구현(참조성) — 프로덕션은 `ipaddr.js` 권고(주석).

### ADR-5. 2단계 캐시 key + payload_key 우선순위 (정확 반영)
`cache/keys.ts`가 platform §(c) 명세를 함수명까지 그대로: `map_key/payload_key_of/payload_key/neg_key/lock_key/short_map_key`. `payload_key_of = normalize(canonical ?? og:url ?? final)`. `cache/unfurl-cache.ts`가 L1 LRU→L2 map→payload→neg 조회 + SWR(물리 TTL을 논리 TTL×(1+swr)로 저장) + single-flight(`SET NX EX`) + 락 실패 시 coalesce 재조회를 실제 구현.
**왜:** 단축·트래킹 변형을 하나의 payload로 수렴(히트율). SWR-after-expiry를 위해 물리 TTL을 논리보다 길게 저장.

### ADR-6. 승격은 신호 기반 (헤드리스 남발 금지)
`strategy/fetch-strategy.ts`의 `decideEscalation`이 crawl §1.2 우선순위 표를 그대로 코드화(DONE/OEMBED/HEADLESS). SPA 셸·JS 리다이렉트·챌린지 신호는 `strategy/spa-signals.ts` 순수 함수. `orchestrator.ts`가 §1.1 래더(static→oEmbed→headless)를 전개하며 각 단계 부분 결과를 보존.
**왜:** 헤드리스는 CPU/메모리 비용이 크므로 신호가 있을 때만. 실패해도 static 부분 OG 보존(불변식 1).

### ADR-7. 관측 = cache 레이어가 요청 counter 소유
`metrics/instrumentation.ts`는 벤더 중립 `Metrics` 인터페이스. `og_crawl_total{status,error_code,strategy,cache}`는 **cache 상태를 아는 유일 지점**인 `unfurl-cache.ts`가 emit, `completeness`/`failed_crawls`는 crawl 반환 직후 `orchestrator.ts`가 emit(§8). `domain` 라벨은 원시 counter에 **미부착**(§3 카디널리티 규율) — 도메인 집계는 `failed_crawls`(SQL).
**왜:** 중복 카운트 방지 + cache 라벨 정확성 + 카디널리티 폭발 방지.

### ADR-8. DB = Redis + Postgres, 크롤 저장 정본 = `crawl_attempts`(append-only)
통합 §3 + **§3-bis 확정**. `persistence/postgres.ts`가 `crawl_attempts`(정본, 모든 시도 1행) + 파생 `failed_crawls`(롤업 top-N)·`crawls`(성공 payload 사본)·`dlq` DDL(주석) + `InMemoryCrawlStore`. **단일 `writeAttempt()` 경로**로 성공(unfurl-cache else 분기)·실패(orchestrator.fail) 모두 append, 기존 UPSERT/payload 쓰기는 파생 유지. 개발은 외부 의존 0, 프로덕션은 `pg`/`ioredis` 어댑터로 교체.
**왜:** 실패 추적(②) + §5-5 델타 측정이 **전 시도 단일 테이블**을 요구(GAP 3b) → `crawl_attempts` 정본. SQL 집계 강제 → Postgres, 핫 KV/TTL/락 → Redis. 스텁으로 즉시 실행 가능성 확보.

---

## 2. 설계 → 코드 매핑 표 (QA 검증용)

| 확정 결정 (출처) | 반영 파일 | 핵심 심볼 / 라인 근거 |
|---|---|---|
| **에러 taxonomy 확정본** (통합 §1-1) | `src/errors/taxonomy.ts` | `ERROR_CODES`(28개 enum), `ERROR_META`(errorClass/stage/category/retry/hardError), `httpStatusToErrorCode`(4xx 세분) |
| 4xx 세분 (HTTP_403/404/410/429/4XX_OTHER) | `src/errors/taxonomy.ts` | `httpStatusToErrorCode()` — 401→4XX_OTHER, 403/404/410/429 개별 |
| REDIRECT_LOOP ↔ TOO_MANY_REDIRECTS 분리 | `src/errors/taxonomy.ts`, `src/fetch/safe-fetch.ts` | 별도 enum · `REDIRECT_LOOP`(visited set) vs `TOO_MANY_REDIRECTS`(hop 상한) |
| **domain_rules 확정 스키마** (통합 §1-2) | `src/rules/domain-rules.ts` | `DomainRule`(force_headless/extra_headers/rate_limit_rps/ttl_override_sec 등 §1-2 필드 1:1), hot-reload `DomainRuleStore`(TTL 45s) |
| **공유 normalize_url** (통합 §1-3, platform §3-1) | `src/url/normalize.ts` | `normalizeUrl()` 8단계, `#!` 보존, `url/tracking-params.ts` 차단리스트 |
| 정규화 함수 단일 공유 | `src/url/normalize.ts` | API·`cache/keys.ts`·`orchestrator.ts`가 모두 이 함수 import (중복 구현 없음) |
| **캐시 key 2단계** (통합 §3, platform §(c)) | `src/cache/keys.ts` | `map_key/payload_key_of/payload_key/neg_key/lock_key/short_map_key`, `sha256_128` |
| payload_key = normalize(canonical ?? og:url ?? final) | `src/cache/keys.ts` | `payload_key_of()` — 우선순위 그대로 + normalize |
| 2단계 조회 + SWR + single-flight | `src/cache/unfurl-cache.ts` | `getUnfurl()`(L1→L2 map→payload→neg), `triggerBgRefresh`(SWR), `setNx` 락 + coalesce, 역방향 map write |
| **SSRF: DNS 후 + 홉마다 + IP 핀** (통합 §1-1/§4, crawl §4.1) | `src/fetch/ssrf-guard.ts`, `src/fetch/safe-fetch.ts` | `ssrfPrecheck()`(DNS lookup all + `isBlockedIp`), safe-fetch 홉마다 `precheck` 재호출 + `pinnedLookup` |
| 사설/메타데이터/링크로컬 v4·v6 차단 | `src/fetch/ssrf-guard.ts` | `BLOCKED_V4_CIDRS`/`BLOCKED_V6_CIDRS`/`BLOCKED_IP_LITERALS`, IPv4-매핑 언매핑 |
| 스킴/포트 허용목록 | `src/fetch/ssrf-guard.ts`, `src/config.ts` | `ALLOWED_SCHEMES`/`ALLOWED_PORTS` → `SCHEME_BLOCKED`/`PORT_BLOCKED` |
| 수동 리다이렉트 + 본문 상한 + 타임아웃 (crawl §2.1/§4.2) | `src/fetch/safe-fetch.ts` | `safeFetch()` `maxRedirections:0`, `readCapped`(TOO_LARGE), connect/headers/body 타임아웃, meta-refresh 추종 |
| 압축/charset (crawl §4.2) | `src/fetch/safe-fetch.ts` | `decompress`(gzip/br/deflate), `decodeBody`(CT→BOM→meta charset→utf-8, iconv-lite) |
| **폴백 추출 OG→Twitter→JSON-LD→HTML** (crawl §3.1) | `src/extract/extract-og.ts` | `extractOg()` 우선순위 채움 + `source_map` |
| og:image 상대→final_url 절대화, 다중 배열 | `src/extract/extract-og.ts` | `absolutize()` + `card.images[]`(대표=[0]) |
| completeness = 0.4·title+0.3·desc+0.3·image (§3.2/§1-4) | `src/extract/extract-og.ts` | `scoreCompleteness()`, `richness` 분리(`scoreRichness`) |
| canonical = rel=canonical→og:url→final | `src/extract/extract-og.ts` | canonical 산출 블록 |
| **승격 신호 표** (crawl §1.2) | `src/strategy/fetch-strategy.ts` | `decideEscalation()` 우선순위 1~8, `OEMBED_PROVIDERS` |
| SPA 셸 / JS 리다이렉트 / 챌린지 감지 | `src/strategy/spa-signals.ts` | `detectSpaShell/detectJsRedirect/detectChallenge/parseMetaRefresh` |
| 오케스트레이터 래더 (crawl §1.1) | `src/orchestrator.ts` | `fetchOg()` Stage0→1→승격→2/3→finalize, 부분결과 보존, 비-HTML `nonHtmlCard`(§3.3) |
| oEmbed Stage2 / headless Stage3 | `src/strategy/oembed.ts`, `src/strategy/headless.ts` | `oembedFetch()`, `HeadlessRenderer`(웜풀+세마포어+리소스 차단+대기 전략) |
| status ∈ {ok,partial,failed} (ok⟺≥0.66) | `src/orchestrator.ts` | `statusOf()`, `CONFIG.COMPLETE_THRESHOLD=0.66` |
| **표준 반환 스키마** (crawl §5/§경계면b) | `src/types.ts` | `FetchResult`(normalized/final/canonical/redirect_chain/fetch_strategy/error_code/completeness…) |
| **계측 지점** (reliability-ops §8) | `src/metrics/instrumentation.ts` + 소비처 | `Metrics` 인터페이스, `og_crawl_total`(unfurl-cache), completeness/`failed_crawls`(orchestrator), `og_rule_apply_total` |
| 카디널리티 규율(domain 라벨 금지) | `src/metrics/instrumentation.ts` | `crawlTotal` 라벨에 domain 없음, `domainBucket` 저카디널리티 |
| **`crawl_attempts` 정본 append-only** (통합 §3-bis / reliability-ops §2.1) | `src/persistence/postgres.ts` + 소비처 | `CrawlAttemptRecord`, `writeAttempt()`, `attemptFromResult()`, DDL(idx `(domain,error_code)`·`(rule_version)`). **단일 writeAttempt 경로**: 실패=`orchestrator.fail`, 성공=`unfurl-cache.crawlAndStore` else 분기 → 둘 다 `writeAttempt` 호출(캐시 히트는 미기록) |
| §5-5 규칙 전후 델타 (reliability-ops §5-5) | `src/persistence/postgres.ts` | `deltaByRuleVersion(domain, threshold)` = `FROM crawl_attempts GROUP BY (rule_version>=X)`. 전 시도 단일 소스 확보로 **이제 유효** |
| failed_crawls UPSERT(occurrences++) — 파생 롤업 뷰 | `src/persistence/postgres.ts` | `upsertFailedCrawl()` 롤업 키 (domain,error_code,final_url), §5-1 top-N 전용 |
| crawls payload 사본 — 파생(선택) | `src/cache/unfurl-cache.ts` | `writeCrawl()` 최신 성공 payload 내구 사본(캐시 재구축/프리워밍) |
| API 동기 + SWR + 타임아웃 예산 + 봉투 (platform §2) | `src/api/server.ts` | `GET /unfurl`(예산 레이스→202 승격), `toEnvelope`, `cacheControlFor`(SWR 헤더) |
| batch/jobs/img 스텁 | `src/api/server.ts` | `POST /unfurl/batch`, `GET /unfurl/jobs/:id`, `GET /img` (TODO EXTENSION) |
| 단축링크 short→final 캐시 (crawl §2.2) | `src/cache/unfurl-cache.ts`, `src/orchestrator.ts` | `short_map_key`, `shortMapGet` 단락, `is_short_link` 규칙 |

---

## 3. 통합 §4 QA 검증 포인트 → 구현 대응

| # | 검증 포인트 | 구현 근거 | 상태 |
|---|---|---|---|
| 1 | 에러 taxonomy 동일 문자열 | 전 모듈이 `errors/taxonomy.ts`의 `ErrorCode` 유니온만 사용. 임의 문자열은 `isKnownErrorCode` 가드 | ✅ 단일 enum |
| 2 | domain_rules 동일 필드명 | `rules/domain-rules.ts` `DomainRule`이 §1-2 스키마와 1:1. safe-fetch/strategy/cache가 이 타입 소비 | ✅ |
| 3 | normalize_url 단일 공유 함수 | `url/normalize.ts` 1개. API·워커·엔진 경로가 전부 import (중복 구현 grep 결과 0) | ✅ |
| 4 | payload_key = normalize(canonical ?? og:url ?? final) | `cache/keys.ts` `payload_key_of`, smoke 테스트로 우선순위 검증 | ✅ smoke |
| 5 | SSRF: DNS 해석 후 + 홉마다 + IP 핀 | `ssrf-guard.ts`(DNS all + IP 검사) + `safe-fetch.ts`(홉마다 precheck + pinnedLookup). 라이브 e2e에서 169.254.169.254 차단 확인 | ✅ e2e |
| 6 | completeness 임계 정합 (ok⟺≥0.66) | `config.COMPLETE_THRESHOLD=0.66`, `orchestrator.statusOf`, `fetch-strategy.decideEscalation` 모두 동일 상수 참조 | ✅ |

---

## 4. 실행 안내

```bash
cd _workspace/03_reference_implementation
npm install
npm run typecheck   # tsc --noEmit — 에러 0
npm run smoke       # 무네트워크 순수 로직 15 checks
npm run dev         # Fastify (인메모리 Redis/Postgres 스텁, 외부 의존 0)
curl 'http://localhost:8080/unfurl?url=https://example.com/'
```

- 헤드리스 활성화: `npx playwright install chromium` (미설치 시 static/oEmbed 경로는 정상, headless는 `RENDER_CRASH` graceful fallback → static 부분결과 보존).
- 프로덕션 배선: `index.ts`의 `InMemoryCacheClient`→`IoredisCacheClient`(unfurl-cache 하단 주석), `InMemoryCrawlStore`→`pg` 어댑터, `StaticSeedRuleProvider`→Postgres `domain_rules` provider.

---

## 5. 스텁 / 확장 지점 (`// TODO`·`// EXTENSION`)

| 영역 | 현재 | 확장 |
|---|---|---|
| Redis | `InMemoryCacheClient` | `ioredis` 어댑터(`IoredisCacheClient` 주석 제공) |
| Postgres | `InMemoryCrawlStore`(UPSERT 로직만 실제) | `pg`/`postgres.js` + DDL(주석) 적용 |
| 큐/DLQ | `POST /unfurl/batch` 202 스텁 | Redis Streams/SQS/Kafka + 재시도/DLQ(reliability-ops §7) |
| 이미지 프록시 | `GET /img` 501 | S3/GCS 리사이즈 사본 + CDN(platform §4-2) |
| 헤드리스 | 동적 import graceful fallback | 별도 워커 풀/원격 브라우저(browserless, 경계면 d) |
| oEmbed discovery | known provider 맵 + rule endpoint | `<link rel=alternate type=application/json+oembed>` 자동탐지 |
| 트래킹 파라미터/PSL | 상수 시드 | config/domain_rules hot-reload · `tldts` 전체 PSL |
| robots.txt | rule `robots_mode` 필드만 | robots 파서 + `ROBOTS_DISALLOWED` 강제 |

---

## 6. ASSUMPTION 목록 (설계 공백 → 합리적 기본값)

각 항목은 코드에 `// ASSUMPTION:` 주석으로 병기. 설계자 확인 시 조정 가능.

1. **normalize trailing slash**: 병합하지 않고 **보존**(오탐 병합 위험 회피). `//a///b/`→`/a/b/`(중복 슬래시만 정리). — `url/normalize.ts`
2. **userinfo 제외**: `user:pass@` 는 캐시 key·SSRF 관점에서 정규화 시 제거. — `url/normalize.ts`
3. **content-type 미상**: HTML로 낙관 처리(파서가 재판정). — `config.isHtmlContentType`
4. **UA 기본값**: `OGUnfurlBot/1.0` — per-domain `ua_override`로 교체(twitter는 facebookexternalhit 시드). — `config.ts`
5. **body cap 적용 지점**: 압축 바이트에 cap(해제 후 재-cap은 EXTENSION). — `fetch/safe-fetch.ts`
6. **eTLD+1**: 경량 다단계 서픽스 소집합 근사. 프로덕션은 `tldts`. — `url/domain.ts`
7. **오케스트레이터 재시도**: transient 재시도/DLQ는 큐 워커 책임으로 분리(동기 경로는 1회). taxonomy에 정책만 코드화. — `errors/taxonomy.ts`
8. **ttl_override_sec 소비**: 규칙 TTL 오버라이드는 캐시 레이어 EXTENSION(현재 completeness 기반 TTL). — `cache/unfurl-cache.ts`

---

## 7. 설계 간 모순 처리 결과

임의 결정 없이 **통합 아키텍처 확정본을 단일 진실로 소비**했다. crawl-engine 초안의 요약형 에러코드/필드명(`HTTP_4XX`, `headers_override`, `force_strategy`, `RENDER_FAILED`)은 §1-1/§1-2 확정본(`HTTP_403…`, `extra_headers`, `force_headless`, `RENDER_CRASH`)으로 통일했다. 새로운 모순은 발견되지 않았다. (crawl §5 스키마와 platform §(c) key 함수는 통합본과 이미 정합.)
