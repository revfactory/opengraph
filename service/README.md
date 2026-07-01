# OG Unfurl 서비스 — 참조 구현

URL → Open Graph 추출 서비스의 참조 구현. **통합 아키텍처(`_workspace/02_integrated_architecture.md`) 계약을 단일 진실**로 따른다.
런타임: **Node.js 22 + TypeScript + Fastify** (runtime-strategist 확정 · undici/cheerio/playwright).

핵심 알고리즘(정규화·SSRF-safe 페치·계층적 승격·OG 폴백·2단계 캐시 key)은 **완전 구현**이고,
인프라(Redis/Postgres)는 **인터페이스 뒤의 어댑터**라 환경변수만으로 인메모리 ↔ 실 백엔드를 오간다.

## 아키텍처 한 단락

`GET /unfurl` 은 URL 을 공유 순수함수로 정규화한 뒤 **2단계 캐시**(L1 LRU → L2 Redis `og:map`→`og:pl`)를
조회한다. fresh 면 즉시, stale 이면 SWR(즉시 반환 + 백그라운드 갱신), miss 면 `SET NX EX` single-flight
락으로 스탬피드를 막고 크롤 오케스트레이터를 호출한다. 오케스트레이터는 **비용 순 승격 래더**(static →
oEmbed → headless)를 전개하며 리다이렉트/단축링크를 끝까지 추적해 **최종 URL 을 진실의 원천**으로 확정하고,
DNS 해석 후 + 리다이렉트 홉마다 SSRF 를 재검증한다. 모든 시도(성공·실패)는 **`crawl_attempts`(append-only,
정본)** 1행으로 Postgres 에 적재되고, 실패는 `failed_crawls` 로 롤업되어 실패율 감소 플라이휠의 연료가 된다.
Redis 는 핫 캐시/락, Postgres 는 집계/내구 저장을 담당한다(어댑터 미설정 시 인메모리로 graceful fallback).

## 두 가지 기동 모드

### (A) 로컬 인메모리 — 외부 의존 0

`REDIS_URL`/`DATABASE_URL` 를 **설정하지 않으면** 인메모리 캐시/저장소로 즉시 뜬다.

```bash
npm install
npm run typecheck        # tsc --noEmit (에러 0)
npm run smoke            # 무네트워크 순수 로직 검증 (15 checks)
npm run dev              # Fastify 기동 (인메모리 — Redis/Postgres 불필요)
# 브라우저로 플레이그라운드 열기:
open http://localhost:8080/
curl 'http://localhost:8080/unfurl?url=https://example.com/&debug=true'
```

### (B) docker-compose — 실 Redis + Postgres

`redis:7` + `postgres:16` + one-shot `migrate`(스키마 적용) + `app` 를 함께 띄운다.
`app` 은 `REDIS_URL`/`DATABASE_URL` 이 주입되어 **ioredis/pg 어댑터**로 동작한다.

```bash
docker compose config    # (선택) YAML/의존 유효성 검증
docker compose up --build
curl 'http://localhost:8080/unfurl?url=https://example.com/'
```

기동 순서: `postgres`/`redis` healthy → `migrate`(001_init.sql 적용 후 종료) → `app`.
직접 컨테이너에 붙일 때는 `.env.example` 를 복사해 `REDIS_URL`/`DATABASE_URL` 를 지정하고 `npm run migrate && npm start`.

## 엔드포인트

| 메서드 · 경로 | 설명 |
|---|---|
| `GET /` | **플레이그라운드 UI**(`public/index.html`) — URL 입력 → 미리보기 카드 + 진단 리드아웃 |
| `GET /unfurl?url=&strategy=&refresh=&debug=` | 동기 추출. 캐시 → 크롤. 예산 초과 시 `202`+`job_id` 큐 승격. `debug=true` 면 진단 필드(redirect_chain·completeness·latency·source_map) 포함 |
| `GET /healthz` | 헬스체크(`{status:"ok"}`) |
| `POST /unfurl/batch` | 배치 비동기(스텁: 큐 enqueue 확장 지점) |
| `GET /unfurl/jobs/:id` | 잡 폴링(스텁) |
| `GET /img` | 이미지 프록시(스텁, `501`) |

응답 봉투(platform §2-2):
```jsonc
{ "data": { "title": "...", "image": "...", "url": "<canonical>" },
  "meta": { "cache": "hit|miss|stale|negative", "completeness": "full|partial",
            "fetch_strategy": "static|oembed|headless", "final_url": "...", "ttl_seconds": 86400 },
  "error": null }
```
응답 헤더: `x-cache`(캐시 상태), `x-trace-id`(상관관계), `cache-control`(SWR: `stale-while-revalidate`).

## 환경변수

전부 선택 — 미설정 시 `config.ts`(통합 아키텍처 확정값) 기본값. 전체 목록은 `.env.example` 참조.

| 변수 | 기본값 | 의미 |
|---|---|---|
| `PORT` | `8080` | HTTP 포트 |
| `REDIS_URL` | (미설정) | **설정 시 ioredis 어댑터**. 없으면 인메모리 캐시 |
| `DATABASE_URL` | (미설정) | **설정 시 pg 어댑터**(crawl_attempts/failed_crawls/domain_rules). 없으면 인메모리 |
| `OG_SYNC_BUDGET_MS` | `3000` | 동기 응답 예산(초과 시 202 승격) |
| `OG_CONNECT_TIMEOUT_MS` / `OG_HEADERS_TIMEOUT_MS` / `OG_TOTAL_TIMEOUT_MS` | `3000`/`5000`/`8000` | 페치 타임아웃 세분 |
| `OG_MAX_REDIRECT_HOPS` | `10` | 리다이렉트 홉 상한 |
| `OG_MAX_BODY_BYTES` | `2097152` | 본문 크기 상한 |
| `OG_ALLOWED_SCHEMES` / `OG_ALLOWED_PORTS` | `http,https` / `80,443,8080,8443` | SSRF 허용목록 |
| `OG_COMPLETE_THRESHOLD` | `0.66` | `ok` 판정 완성도 임계(§1-4) |
| `OG_*_TTL_SEC` | (config) | 캐시/negative/short-map TTL |
| `OG_MAX_HEADLESS_CONCURRENCY` | `4` | 헤드리스 동시성 |

## 테스트

```bash
npm run smoke            # 순수 로직 15 checks (무네트워크, 항상 실행)
npm run test:integration # e2e (node:test). 실 의존성 없으면 네트워크 케이스 skip
```

`test:integration` 은 서버를 조립해 `inject` 로 e2e 를 관통한다:
정상 추출 → 캐시 히트(`x-cache=hit`) → **SSRF 차단**(`169.254.169.254`→`SSRF_BLOCKED`, 네트워크 불필요) →
리다이렉트/단축링크 해석(http→https 추적 후 `final_url` 확정). 외부 네트워크가 없으면 SSRF/백엔드 선택만
실행하고 나머지는 skip 한다(`INTEGRATION_SKIP_NET=1` 로 강제 skip 가능). `REDIS_URL`/`DATABASE_URL` 이
있으면 실제 Redis/Postgres 를 관통한다.

## 인프라 어댑터

| 포트(인터페이스) | 인메모리(기본) | 실 어댑터 | 파일 |
|---|---|---|---|
| `CacheClient` | `InMemoryCacheClient` | `IoredisCacheClient` | `src/cache/redis-store.ts` |
| `CrawlStore` | `InMemoryCrawlStore` | `PgCrawlStore` | `src/persistence/pg-store.ts` |
| `DomainRuleProvider` | `StaticSeedRuleProvider` | `PgDomainRuleProvider` | `src/persistence/pg-store.ts` |

- 선택 팩토리: `createCacheClient()` / `createPersistence()` (env 유무로 어댑터 결정, 접속 실패 시 강등).
- 스키마: `migrations/001_init.sql`(전체 DDL) · 적용기 `npm run migrate`.
- 헤드리스 `playwright` 는 optionalDependency — 미설치여도 static/oEmbed 경로는 동작(graceful fallback).
  헤드리스 사용 시 `npx playwright install chromium`.

설계→코드 매핑과 ADR 은 `_workspace/03_implementation_notes.md` 참조.
