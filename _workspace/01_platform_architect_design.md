# 01. Platform Architecture — OG 추출(unfurl) 서비스 시스템 디자인

> 담당: platform-architect
> 대상 고려사항: 요구사항 ④ — **응답 속도 개선 · 캐싱 key 기준 · DB 선택 유무 및 기준**
> 소비 입력: crawl-engine의 페치 결과 스키마(`normalized_url`/`final_url`/`canonical_url`/`redirect_chain`/`fetch_strategy`/`error_code`), reliability-ops의 SQL 집계 요구
> 산출 대상: runtime-strategist(배포 토폴로지), implementation-engineer(API 계약·캐시 key 함수 명세)

핵심 원리 세 줄:
1. **캐시 key는 정규화가 전부다.** 트래킹 파라미터 제거 + 쿼리 정렬만으로 히트율이 크게 오른다.
2. **최종/canonical URL로도 캐시**하여 단축·트래킹 변형을 하나의 payload로 수렴시킨다(2단계 키).
3. **DB는 접근 패턴의 함수** — Redis(핫 KV) + Postgres(집계/내구)가 이 도메인의 95%를 커버한다. 운영 요구(실패 추적)가 DB를 강제한다.

---

## 1. 아키텍처 다이어그램 (컴포넌트 / 데이터 흐름)

### 1-1. 전체 컴포넌트

```
                    클라이언트 (웹/앱/서버-투-서버)
                          │  GET /unfurl?url=...
                          ▼
                 ┌──────────────────┐
                 │   CDN / Edge     │  공개·캐시가능 응답 엣지 캐싱 (Cache-Control/ETag 존중)
                 └────────┬─────────┘
                          ▼
          ┌──────────────────────────────┐
          │  API 티어 (stateless, HPA)   │
          │   1) normalize_url()          │
          │   2) L1 인메모리 LRU 조회      │  ← 프로세스-로컬 (수천 hot key)
          │   3) L2 매핑/payload 캐시 조회 │  ← Redis
          │   4) miss → single-flight lock │
          │   5) 빠른 static은 인라인 크롤 │
          │      느린/헤드리스은 큐로 위임  │
          └───────┬───────────────┬───────┘
                  │ (동기 인라인)  │ (비동기 위임)
                  ▼               ▼
        ┌──────────────┐   ┌──────────────┐
        │  Redis 캐시  │   │  큐 (Streams/ │
        │  L2 (KV/TTL) │   │  SQS/Kafka)  │
        └──────┬───────┘   └──────┬───────┘
               │ miss             │ consume
               ▼                  ▼
        ┌──────────────────────────────────────┐
        │           크롤 워커 풀 (분리)          │
        │  ┌───────────────┐  ┌───────────────┐ │
        │  │ static 풀      │  │ headless 풀   │ │
        │  │ 가벼움/고동시성 │  │ 무거움/저동시성│ │
        │  │ HTTP+파서      │  │ 브라우저 웜풀  │ │
        │  └───────┬───────┘  └───────┬───────┘ │
        └──────────┼──────────────────┼─────────┘
                   ▼                  ▼
        ┌───────────────┐   ┌────────────────────┐
        │  PostgreSQL   │   │ 오브젝트 스토리지    │
        │  내구/운영/집계 │   │ (S3/GCS) 이미지 사본 │──▶ CDN
        │  crawls,       │   │ /img 프록시·리사이즈 │
        │  failed_crawls │   └────────────────────┘
        │  domain_rules  │
        └───────────────┘
```

### 1-2. 요청 데이터 흐름 (핫/콜드 경로)

```
GET /unfurl?url=X
  │
  ├─ normalize_url(X) → norm
  │
  ├─ [L1 LRU] og:pl:{payload_key?} 있으면 즉시 반환 (수 µs)          ── 핫
  │
  ├─ [L2 매핑] og:map:{norm} → payload_key
  │     ├─ hit → [L2 payload] og:pl:{payload_key}
  │     │          ├─ fresh  → 200 반환 (cache:hit)                  ── 핫
  │     │          └─ stale  → 즉시 반환 + 백그라운드 갱신 (cache:stale) ── SWR
  │     └─ miss ──┐
  │               ▼
  ├─ [negative] og:neg:{norm} 있으면 → 4xx/부분결과 반환 (cache:negative)
  │
  └─ MISS: single-flight lock(og:lock:{norm}) 획득 시도
        ├─ 락 획득 → 크롤 결정: static 예상이면 인라인(타임아웃 예산 내),
        │            headless/느림 예상이면 큐 위임 → 202
        │   크롤 완료 → final_url/canonical_url/og:url 확보
        │   payload_key = normalize(canonical_url ?? og:url ?? final_url)
        │   [write] og:pl:{payload_key}=payload,
        │           og:map:{norm}=payload_key,
        │           og:map:{normalize(final_url)}=payload_key   (역방향 수렴)
        │   Postgres: crawls upsert / 실패 시 failed_crawls
        │   → 200/202 반환
        └─ 락 실패(다른 요청이 크롤 중) → 짧게 대기 후 캐시 재조회 (coalescing)
```

**설계 근거 — static/headless 풀 분리**: 헤드리스 브라우저는 크롬 인스턴스당 수백 MB + CPU를 소모한다. static HTTP 크롤과 같은 풀에 두면 헤드리스 한 건이 static 수백 건의 처리량을 잠식하고, 오토스케일 시그널도 오염된다. 두 풀은 **독립적으로 스케일**하며 각기 다른 동시성/타임아웃/리소스 limit을 갖는다.

---

## 2. API 계약 (동기 vs 비동기)

### 2-1. 엔드포인트

| 메서드 | 경로 | 경로 성격 | 설명 |
|---|---|---|---|
| GET | `/unfurl?url=&strategy=&refresh=` | **동기** | 캐시 히트 + 빠른 static. 타임아웃 예산 내에서 인라인 크롤. |
| POST | `/unfurl/batch` | **비동기** | URL 배열을 큐에 넣고 `202` + `job_id`들 반환. |
| GET | `/unfurl/jobs/{job_id}` | 폴링 | 비동기 작업 상태/결과 조회. |
| GET | `/img/{hash}` (or `/img?url=`) | 동기 | 프록시·리사이즈된 `og:image` 서빙(오브젝트 스토리지/CDN). |

- `strategy=auto|static|headless` (기본 auto), `refresh=true`로 강제 재크롤(캐시 무시, 재기록).
- 콜백이 필요하면 batch에 `webhook_url` 지원.

### 2-2. 동기 응답 봉투(envelope)

```jsonc
{
  "data": {                         // OG payload (crawl-engine 스키마 소비)
    "title": "...", "description": "...",
    "image": "https://cdn.svc/img/ab12...",   // 프록시된 이미지 URL
    "site_name": "...", "type": "article", "url": "https://.../canonical"
  },
  "meta": {
    "cache": "hit|miss|stale|negative",   // 소비자가 신선도 판단
    "completeness": "full|partial",       // 부분 결과 여부
    "fetch_strategy": "static|headless",  // 어떤 워커가 처리했는지
    "final_url": "https://...",           // 리다이렉트 최종 도착지
    "canonical_url": "https://...",       // 페이지 선언 canonical/og:url
    "fetched_at": "2026-07-01T03:00:00Z",
    "ttl_seconds": 86400
  },
  "error": null                          // 실패 시 { "code": "...", "message": "..." }
}
```

### 2-3. 동기 ↔ 비동기 전환 규칙(에스컬레이션)

- 동기 경로는 **짧은 타임아웃 예산(기본 3s)**. 예산 초과·헤드리스 필요 판정 시 즉시 크롤을 **큐로 승격**하고 `202 Accepted { job_id, poll_url }` 반환. → 느린 origin이 커넥션을 점유해 전체 지연을 끌지 않게 한다.
- 부분 결과가 이미 있으면(예: static으로 title/description은 얻고 이미지 렌더만 남음) `meta.completeness:"partial"`로 **즉시 반환**하고 나머지는 백그라운드 보강.
- 응답에 HTTP 캐싱 헤더 부여: 공개·성공 응답은 `Cache-Control: public, max-age=..., stale-while-revalidate=...` + `ETag`로 **CDN/브라우저 캐싱** 유도. `refresh=true`나 실패는 `no-store`.

**권고**: 인터랙티브 경로 = 동기 + SWR + 짧은 타임아웃. 대량/미리보기 생성 = 비동기 큐 + 웹훅.

---

## 3. 캐싱 key 기준 (이 서비스의 심장)

### 3-1. URL 정규화 (1차 key 생성) — 단계별

정규화 품질이 곧 히트율이다. **결정적(deterministic)**이어야 하며, 순서대로 적용한다:

| # | 단계 | 예시 |
|---|---|---|
| 1 | scheme·host **소문자화** | `HTTP://Example.COM` → `http://example.com` |
| 2 | 기본 포트 제거 | `example.com:443` → `example.com` (`:80`도) |
| 3 | **트래킹 파라미터 제거** | `utm_*`, `fbclid`, `gclid`, `igshid`, `ref`, `ref_src`, `mc_eid`, `_hsenc`, `spm`, `yclid` 등 (허용리스트가 아닌 **차단리스트** 운영) |
| 4 | 남은 쿼리 파라미터 **키 기준 정렬** | `?b=2&a=1` → `?a=1&b=2` (순서 무관 동일 key) |
| 5 | **fragment 제거** | `page#section` → `page` (단, `#!` hashbang·SPA route는 보존 옵션) |
| 6 | 경로 정규화 | 중복 슬래시 정리, `.`/`..` 해소, trailing slash 정책 통일 |
| 7 | **IDN → punycode**, 퍼센트 인코딩 대문자 통일·불필요 인코딩 해제 | `한글.com` → `xn--bj0bj06e.com` |
| 8 | (선택) 기본 `index.html` 등 흔한 default doc 제거는 **하지 않음**(오탐 위험) | — |

→ `norm = normalize_url(input)`
→ `key1 = "og:map:v1:" + sha256_128(norm)`

> 해시는 sha256의 앞 128비트(hex 32자)를 사용해 key 길이를 고정. **원본 `norm`은 Postgres에 컬럼으로 보존**(디버깅·재현·역조회용). `v1`은 정규화 규칙 버전 — 규칙이 바뀌면 버전을 올려 전체 무효화 없이 점진 이행.

### 3-2. 2단계 키 — 최종/canonical URL로도 캐시

서로 다른 단축(`bit.ly/x`)·트래킹 변형이 **같은 canonical 페이지로 수렴**한다. 이를 캐시에 반영하면 히트율이 급등한다.

```
매핑 캐시   og:map:v1:{sha(norm)}        → payload_key         (긴 TTL, 거의 불변)
payload 캐시 og:pl:v1:{sha(payload_key)}  → OG payload + 메타   (도메인/origin TTL)
```

**payload_key 결정 우선순위** (페이지가 선언한 정체성이 최우선):

```
payload_key = normalize( canonical_url            // <link rel="canonical">
                         ?? og_url                 // og:url
                         ?? final_url )            // 리다이렉트 최종 도착 URL
```

**조회/기록 흐름**:
1. `norm`으로 매핑 캐시 조회 → `payload_key` 획득 → payload 캐시 조회. **다른 입력이 같은 `payload_key`를 이미 채웠다면 첫 크롤 없이 즉시 히트.**
2. 매핑 miss → 크롤 후 `payload_key` 산출 → payload 기록 + `og:map:{norm}` 기록 + `og:map:{normalize(final_url)}` **역방향 매핑도 기록**(final URL로 직접 들어와도 수렴).

이 구조로 `bit.ly/x`, `example.com/article?utm_source=a`, `example.com/article?fbclid=b`, `example.com/article`가 모두 **하나의 payload_key**로 모인다.

### 3-3. TTL / Negative cache / SWR

| 종류 | 정책 | 기본값(예) |
|---|---|---|
| **positive TTL** | origin `Cache-Control: max-age`/`Expires` 존중, 없으면 도메인별 기본(뉴스 길게, 소셜·실시간 짧게), 그다음 전역 기본 | 전역 24h, 범위 1h~7d |
| **negative cache**(실패) | 짧은 TTL로 깨진 URL 반복 크롤 방지하되 회복 허용. `error_code` 함께 저장. 4xx는 길게, 5xx/timeout는 짧게(+지수백오프) | 5xx/timeout 5m, 4xx 30m |
| **SWR (stale-while-revalidate)** | 만료 임박·직후 값은 **즉시 반환** + 백그라운드 갱신 트리거 → 체감 지연 최소, 스탬피드 완화 | stale 허용 창 10~30% of TTL |
| **매핑 캐시 TTL** | 단축→최종 매핑은 거의 불변 → 길게 | 7~30d |
| **single-flight lock** | 콜드 URL 동시요청 합류용 짧은 락 | `og:lock:v1:{sha(norm)}` TTL 10~30s |

Redis 저장 형태(요약): `og:map:*`·`og:pl:*`는 `SET ... EX ttl`(payload는 JSON/MessagePack), lock은 `SET NX EX`, LRU L1은 프로세스-로컬 map + TTL.

---

## 4. DB 선택 유무 및 기준

### 4-1. "DB가 필요한가?"에 정직하게

- **순수 best-effort 캐시 + 운영 요구 없음(MVP·PoC)** → **Redis-only도 가능**. 재시작 시 캐시 소실을 감수하고, 다시 크롤로 채운다. 코드/운영 최소.
- **그러나 요구사항 ②(크롤링 실패 추적 + 실패율 감소)** 는 **조회·집계 가능한 내구 저장소를 강제**한다. 실패 링크를 나중에 도메인별로 모아 top-N을 뽑고, 규칙을 만들어 실패율을 낮추는 루프는 휘발성 캐시로 불가능하다.
- → **결론: 이 서비스의 현실적 기준선은 `Redis(캐시) + Postgres(내구/운영/집계)`.** MVP에서도 Postgres를 함께 두는 것을 권장(운영 데이터는 처음부터 쌓여야 가치가 있음).

### 4-2. 저장소 결정표 (무엇을 · 어디에 · 왜)

| 무엇 | 어디에 | 왜 |
|---|---|---|
| OG payload 핫 캐시, `norm→payload_key` 매핑, single-flight lock | **Redis** (KeyDB/Dragonfly 대안) | key-value 핫 읽기, TTL 네이티브, SWR/락 구현 용이, µs급 지연 |
| 크롤 레코드(`crawls`), **`failed_crawls`**, per-domain 규칙(`domain_rules`), payload 내구 사본 | **PostgreSQL** | **실패 도메인 top-N·실패율 시계열 등 SQL 집계** 필요, 유연 payload는 **JSONB**, 트랜잭션·운영 신뢰 |
| 프록시·리사이즈된 `og:image` 사본 | **오브젝트 스토리지(S3/GCS)** + CDN | 핫링크/깨진 이미지 방지, 엣지 캐싱, API 티어에서 바이너리 분리 |
| 시계열 메트릭(지연·실패율·큐 깊이) | **Prometheus**(+장기 저장) | 이미 관측 스택, 알림/대시보드 |
| 프로세스-로컬 초핫 key | **인메모리 LRU (L1)** | 네트워크 홉 제거, Redis 부하 완충 |

**Postgres 최소 스키마(발췌)** — reliability-ops의 집계 요구를 충족:

```sql
crawls(
  id, norm_url TEXT, payload_key TEXT, final_url TEXT, canonical_url TEXT,
  fetch_strategy TEXT, http_status INT, payload JSONB,
  fetched_at TIMESTAMPTZ, ttl_seconds INT,
  redirect_chain JSONB
)  -- payload_key/norm_url 인덱스, GIN(payload)

failed_crawls(
  id, norm_url TEXT, domain TEXT, error_code TEXT,     -- crawl-engine↔reliability-ops 공용 taxonomy
  http_status INT, fetch_strategy TEXT, attempt INT,
  failed_at TIMESTAMPTZ, last_error TEXT
)  -- domain/error_code/failed_at 인덱스

domain_rules(
  domain TEXT PRIMARY KEY, force_strategy TEXT,        -- static|headless 강제
  rate_limit_rps INT, default_ttl_seconds INT,
  ua_override TEXT, needs_cookies BOOL, updated_at TIMESTAMPTZ
)
```

### 4-3. DB 선택 기준 (일반화)

접근 패턴의 함수로 고른다:

- **핫 key-value 읽기 / TTL / 락** → **Redis**
- **분석·집계·리포팅(top-N, 실패율 추이, GROUP BY)** → **SQL(Postgres)**
- **유연/가변 스키마 payload** → **JSONB(Postgres)** 또는 문서 DB
- **시계열 메트릭** → **Prometheus/TimescaleDB**
- **대용량 바이너리** → **오브젝트 스토리지 + CDN**
- 특수 DB(Mongo/Cassandra/ES)는 **스케일·검색 요구가 강제할 때만**. 조기 도입은 운영 비용만 늘린다.

> **Redis + Postgres 조합이 이 도메인의 95%를 커버**한다. 나머지는 이미지(오브젝트 스토리지)와 메트릭(Prometheus)으로 충분.

---

## 5. 응답 속도 최적화 기법

우선순위 순(지렛대 큰 순):

1. **캐시 우선 + SWR** — 최대 지렛대. 대부분 요청이 L1/L2에서 즉시 반환. 만료값도 즉시 주고 뒤에서 갱신.
2. **request coalescing (single-flight)** — 콜드 URL에 동시요청이 몰려도(썬더링 허드) **크롤은 1회**, 나머지는 결과 공유. 캐시 스탬피드 방지의 핵심. `og:lock:{norm}` + 짧은 대기-재조회.
3. **2단계 키 수렴** — 단축/트래킹 변형을 하나의 payload로 모아 콜드 크롤 자체를 줄임.
4. **커넥션 풀 + keep-alive + HTTP/2**, **DNS 캐싱** — 워커의 origin 재접속 비용 제거.
5. **범위 요청(Range) / 조기 종료** — `<head>`만 받아 파싱(OG는 문서 앞부분). `</head>` 만나면 다운로드 중단.
6. **gzip/br 응답 협상**, **헤드리스 브라우저 웜풀**(콜드 스타트 제거).
7. **프리워밍** — 인기 URL·도메인 홈을 사전 크롤/갱신(스케줄러 + 큐).
8. **CDN 엣지 캐싱** — 공개·캐시가능 응답을 엣지에서 종료(ETag/Cache-Control/SWR 헤더).
9. **타임아웃 예산 + 부분 결과** — 빨리 실패/승격. 느린 origin이 전체 p99를 끌지 않게.
10. **L1 인메모리 LRU** — Redis 홉조차 생략하는 프로세스-로컬 초핫 캐시.

---

## 6. 확장 토폴로지 (규모 3구간)

| 구간 | 트래픽 가정 | 최소 아키텍처 | 저장소 | 워커 | 부가 |
|---|---|---|---|---|---|
| **MVP** | ~수십 rps, 단일 리전 | 단일 API 프로세스(인라인 크롤), L1 LRU | Redis 1 + Postgres 1 | static 인라인, headless는 온디맨드 1대 | 큐 없음(동기 위주), 기본 negative cache |
| **성장기** | 수백~수천 rps | stateless API(HPA) + **큐** + 워커 풀 **분리** + **CDN** | Redis(복제) + Postgres(리드레플리카) + S3 | static 풀 ┃ headless 풀 각자 오토스케일 | SWR·프리워밍·이미지 프록시, per-domain rate-limit, DLQ |
| **대규모** | 수만+ rps, 멀티리전 | 멀티리전 API + **지역 캐시(Redis 클러스터)** + 글로벌 CDN | Redis Cluster/Dragonfly, Postgres 샤딩/파티셔닝, S3+글로벌 CDN | 리전별 워커 풀, 헤드리스 전용 노드풀 | 이미지 파이프라인 분리, 프리워밍 파이프라인, 크로스리전 캐시 워밍 |

**확장 축 공통**:
- **stateless API 티어** — 세션/상태를 캐시·DB로 밀어내 자유 오토스케일.
- **큐(Redis Streams / SQS / Kafka)** — 비동기 + 재시도(지수백오프) + **DLQ**. 콜드/헤드리스/배치 흡수.
- **워커 풀 분리** — static(가벼움·고동시성) ┃ headless(무거움·저동시성). 리소스 limit·타임아웃·스케일 시그널 독립.
- **per-domain rate-limit** — `domain_rules.rate_limit_rps` 소비. politeness + 429 회피.

**장애 폴백**:
- **Redis 장애** → L1 LRU로 저하 운전 + 미스는 직접 크롤(coalescing만 프로세스-로컬로). 쓰기는 재시도 큐.
- **Postgres 장애** → **캐시-only 저하 모드**: 서빙은 계속, `crawls`/`failed_crawls` 기록은 버퍼링 후 복구 시 flush. 운영 지표는 일시 손실 감수하되 서비스 가용성 우선.
- **크롤 origin 장애** → negative cache + 백오프로 반복 크롤 차단, 부분/stale 결과 서빙.

---

## 경계면 계약

이 문서는 병렬로 작업 중인 세 에이전트와의 인터페이스를 아래로 고정한다.

### (a) 캐시 key가 소비하는 crawl-engine 페치 결과 필드
캐시 key 로직은 crawl-engine이 정의하는 페치 결과 스키마의 다음 필드에 **의존**한다(요구사항의 단일 진실 스키마):

| 필드 | 캐시에서의 용도 |
|---|---|
| `normalized_url` | 1차 key `og:map:v1:{sha(normalized_url)}` 생성. **정규화 규칙은 §3-1을 crawl-engine과 공유**(양측이 동일 함수 사용 — 아래 (c) 참조). |
| `final_url` | payload_key 폴백(3순위) + **역방향 매핑** `og:map:v1:{sha(normalize(final_url))}` 기록. |
| `canonical_url` | payload_key **1순위**(페이지 선언 `<link rel=canonical>`). |
| `og:url` (payload 내) | payload_key **2순위**(canonical 없을 때). |
| `redirect_chain` | (참고) 매핑 무결성 검증·디버깅. 캐시 key엔 미사용, Postgres에 보존. |
| `fetch_strategy` | 응답 `meta.fetch_strategy`·스케일 시그널. |
| `error_code` | **negative cache**(`og:neg`)에 저장 + failed_crawls 기록. |

→ **요청**: crawl-engine은 정규화를 §3-1 규칙(버전 `v1`)으로 수행하고 `normalized_url`을 그 결과로 채울 것. 정규화가 양측에서 갈리면 캐시 히트가 깨진다. 정규화 함수는 (c)의 단일 구현을 공유한다.

### (b) reliability-ops의 SQL 집계 요구 충족
reliability-ops의 실패 추적/실패율 감소 루프는 **PostgreSQL**로 충족한다. 아래 질의가 인덱스로 효율 실행되도록 §4-2 스키마를 설계했다:

- **실패 도메인 top-N**: `SELECT domain, count(*) FROM failed_crawls WHERE failed_at > now()-interval '1 day' GROUP BY domain ORDER BY 2 DESC LIMIT N;`
- **error_code 분포**: `GROUP BY error_code`
- **도메인별 실패율 추이(시계열)**: `crawls` 대비 `failed_crawls`를 시간 버킷으로 집계
- **규칙 피드백**: 상습 실패 도메인 → `domain_rules`에 `force_strategy='headless'`·rate-limit·cookie 등 기록 → 크롤 워커가 소비 → 실패율 하락 루프

→ **요청**: reliability-ops는 실패 시 `failed_crawls`에 `error_code`(공용 taxonomy)·`domain`·`fetch_strategy`·`attempt`를 기록하고, 산출한 규칙을 `domain_rules`에 upsert할 것. taxonomy 확정본은 crawl-engine↔reliability-ops 합의를 단일 진실로 따른다.

### (c) implementation-engineer에게 전달할 캐시 key 함수 명세
아래를 **공유 유틸(단일 구현)**로 만들어 API 티어·크롤 워커·crawl-engine이 동일하게 사용한다.

```
# 1) 정규화 — 결정적. §3-1 규칙을 순서대로.
normalize_url(raw: str) -> str
  입력: 원본 URL 문자열
  출력: 정규화 URL(norm). 규칙 버전 v1.
  보장: 동일 의미 URL은 동일 문자열. 순수 함수(부수효과 없음).

# 2) 캐시 key 생성
map_key(norm: str)          -> "og:map:v1:" + sha256_128hex(norm)
payload_key_of(canonical_url, og_url, final_url) -> normalize(canonical_url or og_url or final_url)
payload_key(pk: str)        -> "og:pl:v1:"  + sha256_128hex(pk)
neg_key(norm: str)          -> "og:neg:v1:" + sha256_128hex(norm)
lock_key(norm: str)         -> "og:lock:v1:"+ sha256_128hex(norm)

# 3) 조회 오케스트레이션(의사코드)
get_unfurl(raw):
  norm = normalize_url(raw)
  if v := L1[map→payload] hit and fresh: return v (cache:hit)
  pk = redis.get(map_key(norm))
  if pk:
     p = redis.get(payload_key(pk))
     if p and fresh(p):  return p (cache:hit)
     if p and stale(p):  trigger_bg_refresh(norm); return p (cache:stale)  # SWR
  if neg := redis.get(neg_key(norm)): return error(neg) (cache:negative)
  if redis.set(lock_key(norm), NX, EX=20):        # single-flight
     r = crawl(norm)                               # static 인라인 or 큐 위임
     pk = payload_key_of(r.canonical_url, r.og_url, r.final_url)
     redis.setex(payload_key(pk), ttl(r), r.payload)
     redis.setex(map_key(norm), MAP_TTL, pk)
     redis.setex(map_key(normalize(r.final_url)), MAP_TTL, pk)   # 역방향 수렴
     persist_postgres(r)                           # crawls / failed_crawls
     return r.payload (cache:miss)
  else:
     wait_short(); return get_unfurl(raw)          # coalesce: 크롤 결과 공유
```

- **버전 규약**: 정규화/키 스킴 변경 시 `v1→v2`로 접두사만 올려 무중단 점진 이행(구버전 키는 TTL로 자연 소멸).
- **해시**: sha256 앞 128비트 hex(32자) 고정 길이. 원본 `norm`은 Postgres에 컬럼 보존.
- **결정성**: `normalize_url`은 반드시 순수·결정적. crawl-engine의 `normalized_url` 산출과 **동일 구현을 공유**해야 캐시 정합이 유지된다.
