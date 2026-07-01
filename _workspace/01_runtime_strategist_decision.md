# 런타임 선정: 그린필드 신규 OG 추출 마이크로서비스는 **Node.js(TypeScript)** 를 기본값으로, 조직이 Python 중심이면 **Python(FastAPI)** 로 반전

> 이 문서는 요구사항 고려사항 ①(런타임 선택 기준: Node vs Python)에 대한 최종 설계 결정이다.
> 이 서비스의 **첫 결정점**이며, 여기서 확정한 언어/런타임과 라이브러리 스택은 `crawl-engine-architect`의 라이브러리 가정과 `implementation-engineer`의 참조 구현 전제를 규정한다. 최종 계약은 문서 말미 `## 경계면 계약` 참조.

---

## 권고 (한 줄)

**그린필드면 Node.js(TypeScript) + Fastify.** 근거: (1) OG 추출 도메인에 가장 성숙한 라이브러리 생태계(metascraper 모듈형 룰/폴백), (2) 이벤트 루프가 I/O 바운드 다중 페치에 구조적으로 적합, (3) Playwright 1급 + Puppeteer로 헤드리스 선택지가 넓음. **단, 조직 플랫폼이 Python 중심이면 이 결정을 뒤집는다** — 운영 일관성이 라이브러리 미세 우위를 이긴다(반대 선택 조건 참조).

---

## 워크로드 특성 규정 (매트릭스의 전제)

런타임 채점 전에 이 작업이 **무엇에 바운드되는지**부터 고정한다. 이것이 가중치의 근거다.

| 특성 | 판정 | 함의 |
|---|---|---|
| 지배적 비용 | **I/O 바운드** — HTTP 페치 왕복(DNS→TCP→TLS→TTFB→본문)이 전체 지연의 80%+ | "많은 동시 연결을 낮은 메모리 오버헤드로" 처리하는 능력이 1순위 요건 |
| CPU 비용 | **경량** — HTML 파싱(수십~수백 KB)만. 압축 해제(gzip/br)가 유일한 부담 | CPU 코어 수/멀티스레드는 부차적. 파서 속도는 미세 최적화 |
| 렌더링 | **별도 프로세스로 오프로드** — 동적 링크만 헤드리스 브라우저 사용 | 헤드리스는 런타임 선택과 **분리**된다(별도 워커 풀). 런타임 채점에서 가중치를 과도하게 주지 않음 |
| 병렬성 형태 | **높은 팬아웃 + 짧은 작업** — URL당 독립, 상태 공유 없음 | 프로세스 격리보다 **경량 동시성 프리미티브**(이벤트 루프/asyncio/코루틴)가 유리 |

**결론적 전제:** 이 워크로드는 CPU 병렬성이 아니라 **동시 I/O 대기 관리**가 핵심이다. GIL(Python) 논쟁은 여기서 거의 무의미하다 — asyncio 단일 이벤트 루프로도 수천 동시 페치가 가능하기 때문. 따라서 런타임 결정은 "성능"이 아니라 **생태계 성숙도 × 조직 정합성**으로 좁혀진다.

---

## 결정 매트릭스 (프로젝트 맥락으로 재채점)

가중치를 이 프로젝트 특성으로 재조정했다. 점수 1~5, `가중점수 = 가중치 × 점수`. 최대 가능점 = Σ(가중치)×5 = 17×5 = **85**.

### 시나리오 A — 그린필드 (조직 제약 미지정, 기본 가정)

팀 역량/기존 스택 축을 **중립(양쪽 3)** 으로 두어 다른 축이 결정하게 한다.

| 평가 축 | 가중치 | Node.js(TS) | Python | 가중: Node / Py | 근거 |
|---|:---:|:---:|:---:|:---:|---|
| OG/크롤 라이브러리 생태계 | 3 | 5 | 4 | **15 / 12** | Node의 `metascraper`(모듈형 룰+폴백, oEmbed/JSON-LD/Twitter Card 통합)가 이 도메인 최강. Python은 `extruct`+`BeautifulSoup`로 견고하나 "링크 프리뷰" 특화 통합체는 얇음 |
| 헤드리스 브라우저 지원 | 3 | 5 | 4 | **15 / 12** | Playwright는 양쪽 1급. Puppeteer는 Node 전용이라 Node가 예제/생태계 미세 우위. (별도 프로세스라 실효 격차는 작음) |
| 동시성 모델(I/O 바운드) | 3 | 5 | 4 | **15 / 12** | Node 이벤트 루프는 다중 페치가 언어의 자연 상태. Python은 `asyncio`+`httpx`로 대등하나 sync+thread 폴백은 무겁고, async/sync 색깔 혼용 리스크 있음 |
| 팀 역량/기존 스택 | 4 | 3 | 3 | **12 / 12** | 그린필드 → 중립. **실전에선 대개 이 축이 전부를 압도**(시나리오 B/C) |
| 배포·관측 SDK | 2 | 4 | 4 | **8 / 8** | OTel/Prometheus/Datadog 모두 양쪽 성숙. 조직 표준을 따름 |
| 데이터/ML 후처리 | 2 | 3 | 5 | **6 / 10** | 콘텐츠 분류·임베딩·언어감지·요약이 로드맵에 크면 Python 우위 |
| **합계** | **17** | | | **71 / 66** | Node **71/85(83.5%)** vs Python **66/85(77.6%)** — Node 근소 우세 |

**해석:** 그린필드에서 Node가 이기지만 **압승은 아니다(5.9%p)**. 도메인 생태계·동시성 3개 축에서 각 1점씩 앞서는 것이 근거이며, 데이터/ML 로드맵이 커지면 Python이 역전한다. 즉 이 결정은 **약한 선호**이므로, 진짜 리스크 완화는 언어가 아니라 **격리 설계**로 한다(하단).

### 시나리오 B — 기존 스택이 Python 중심

팀 역량/기존 스택 축을 Python 5 / Node 2로, 배포·관측을 Python 5 / Node 3으로 재채점(조직 표준 반영).

| 축 | 가중치 | Node | Python | 가중: Node / Py |
|---|:---:|:---:|:---:|:---:|
| 라이브러리 생태계 | 3 | 5 | 4 | 15 / 12 |
| 헤드리스 | 3 | 5 | 4 | 15 / 12 |
| 동시성 | 3 | 5 | 4 | 15 / 12 |
| **팀 역량/기존 스택** | **4** | **2** | **5** | **8 / 20** |
| 배포·관측 SDK | 2 | 3 | 5 | 6 / 10 |
| 데이터/ML 후처리 | 2 | 3 | 5 | 6 / 10 |
| **합계** | 17 | | | **65 / 76** |

→ **Python 76 vs Node 65. 기존 Python 조직이면 Python으로 반전.** 도메인 라이브러리 우위(3점 차)를 운영 일관성(팀+배포+ML 12점 차)이 압도한다.

### 시나리오 C — 기존 스택이 Node 중심

팀/기존 스택 Node 5 / Python 2 → Node ≈ 79, Python ≈ 61. **기본 권고(Node)를 강하게 재확인.** 논쟁 불필요.

> **가중치에 대한 주석:** 팀 역량/기존 스택(가중치 4)이 단일 최대 축인 것은 의도적이다. 런타임 결정의 총소유비용(TCO)은 벤치마크가 아니라 **누가 3년간 이걸 유지보수·온콜하는가**에서 나온다.

---

## 언어별 라이브러리 맵 (실제 패키지명 — 착수 가능 수준)

`crawl-engine-architect`가 이 스택을 전제로 페치/파싱/헤드리스 계층을 설계한다.

### Node.js(TypeScript) — 기본 권고 스택

| 계층 | 패키지 | 선택 근거 / 대안 |
|---|---|---|
| **HTTP 페치** | **`undici`** (Node 내장 fetch의 엔진) | 커넥션 풀·keep-alive·수동 리다이렉트 제어·`maxRedirections`·타임아웃 세분화가 크롤러에 필수. 고수준 편의가 필요하면 대안 `got`(hooks/retry 내장) |
| **HTML 파싱** | **`cheerio`** (위 `htmlparser2` 엔진) | 관대한 파싱 + jQuery형 셀렉터. `<meta property="og:*">`/`<link rel=canonical>` 추출에 직접적 |
| **OG/메타 추출 통합** | **`metascraper`** (+ 룰 플러그인: `metascraper-title/-description/-image/-url/-author/-date/-logo`) | 모듈형 룰 + 폴백 체인(og→twitter→JSON-LD→휴리스틱)이 이 도메인 최강. 대안 `open-graph-scraper`(단일 패키지·간편), `unfurl`(경량) |
| **구조화 데이터** | `metascraper`가 다수 커버; JSON-LD 직접 파싱 시 `jsonld` | Twitter Card/oEmbed/JSON-LD 통합 폴백 |
| **헤드리스** | **`playwright`**(권장) / 대안 `puppeteer` | 동적 링크 전용 워커에서만. `playwright-core` + 크로미움 단일 채널 |
| **문자셋/인코딩** | `iconv-lite` + `content-type` | EUC-KR/Shift_JIS 등 비 UTF-8 페이지 대응(한국 대상이면 필수) |
| **URL 정규화** | 내장 `URL`(WHATWG) + `normalize-url` | 캐시 key 정규화·리다이렉트 추적의 기반(→ platform-architect가 소비) |
| **웹 프레임워크** | **`fastify`**(권장) / 대안 `NestJS`(구조 선호 시) | 고처리량·저오버헤드 I/O 서버. Express보다 스루풋 우위 |
| **런타임** | Node.js LTS(22.x). 대안 검토: Bun(성숙도 리스크로 프로덕션 기본값 아님) | |

### Python — 반대 선택 스택 (시나리오 B)

| 계층 | 패키지 | 선택 근거 / 대안 |
|---|---|---|
| **HTTP 페치** | **`httpx`** (async, HTTP/2) | asyncio 네이티브·리다이렉트/타임아웃 제어. 대안 `aiohttp`(순수 async 성숙) |
| **HTML 파싱** | **`selectolax`**(lexbor 엔진, 매우 빠름) / 대안 `BeautifulSoup4`+`lxml` | selectolax는 C 기반으로 대량 파싱에 유리. 관대함이 필요하면 bs4 |
| **OG/구조화 데이터** | **`extruct`** (OpenGraph/Microdata/RDFa/JSON-LD 통합 추출) + `w3lib` | Python 진영에서 구조화 메타 추출 표준. 대안 `metadata_parser` |
| **헤드리스** | **`playwright`**(Python 바인딩) | Node와 동일 엔진 — 헤드리스 계층은 언어 무관 |
| **문자셋** | `charset-normalizer` | requests/httpx 생태계 표준 인코딩 감지 |
| **URL 정규화** | `courlan` / `w3lib.url` + `yarl` | 크롤링 특화 URL 정규화·필터 |
| **웹 프레임워크** | **`FastAPI` + `uvicorn`**(async) | asyncio 기반 고처리량. Gunicorn+uvicorn workers로 배포 |
| **런타임** | CPython 3.12+. `asyncio` 전면 사용(동기 requests 금지) | GIL은 I/O 바운드라 무해하나 **async/sync 색깔 일관성**을 규율로 강제 |

> **헤드리스 계층 공통 원칙:** Playwright는 양쪽 언어에서 동일 브라우저 엔진을 구동하므로, **헤드리스 워커는 런타임 결정과 독립적으로 교체 가능**하다. 이 계층을 별도 서비스로 두면 언어 선택 리스크가 추가로 줄어든다.

---

## 반대 선택 조건 (아래 중 하나라도 참이면 Python)

이 프로젝트에서 기본 권고(Node)를 뒤집어야 하는 조건 점검표. **하나라도 강하게 참이면 Python.**

- [ ] **조직 플랫폼이 Python 중심** — Django/FastAPI 기반 서비스군, Python CI/배포/관측 표준, 사내 공용 라이브러리가 Python. → 운영 일관성이 도메인 라이브러리 미세 우위를 이긴다. **(시나리오 B, 가장 흔한 반전 사유)**
- [ ] **팀이 Python에 확연히 강함** — 유지보수·온콜·채용 풀이 Python. TCO는 벤치마크가 아니라 유지보수 인력에서 결정.
- [ ] **무거운 데이터/ML 후처리가 로드맵** — 추출 후 콘텐츠 분류/임베딩/언어감지/요약/썸네일 비전 처리. Python의 데이터 스택(numpy/torch/transformers) 접근성이 결정적.
- [ ] **재사용할 크롤링 자산이 Python으로 존재** — 사내 스크래이핑 파이프라인, Scrapy 기반 인프라, 프록시/anti-bot 미들웨어.

**미지정 시 판단 규칙:** 위 어느 것도 확인되지 않으면 **그린필드 = Node.js(TS)** 를 채택하되, **격리 설계로 반전 비용을 상수화**한다. 조직 정보가 확보되면 매트릭스만 재채점하면 되며, 격리된 크롤러는 재작성 범위가 이 서비스 하나로 국한된다.

---

## 격리 설계 권고 (언어 결정을 되돌릴 수 있게 = 리스크의 진짜 완화책)

런타임 논쟁(5.9%p 근소차)보다 **경계 격리가 리스크를 훨씬 크게 줄인다.** 언어를 틀려도 재작성 범위가 봉인되기 때문이다.

```
                 ┌─────────────────────────────────────────────┐
   Client ──────▶│  API/Preview 서비스 (조직 표준 언어 무관)      │
                 │  - URL 검증/정규화, 캐시 조회, 응답 조립        │
                 └───────────────┬─────────────────────────────┘
                                 │  언어중립 계약: {url} → OG payload JSON
                                 ▼
                 ┌─────────────────────────────────────────────┐
                 │  ★ Crawl/Extract 마이크로서비스 (런타임 결정 지점) │
                 │  - 페치 → 파싱 → 정규화 → error_code 매핑        │
                 │  - 여기만 Node/Python 결정에 갇힘 → 교체 시 이것만 │
                 └───────────────┬─────────────────────────────┘
                                 │  fetch_strategy=dynamic 일 때만
                                 ▼
                 ┌─────────────────────────────────────────────┐
                 │  Headless Render 워커 풀 (언어 무관, Playwright)│
                 │  - 리소스 프로파일 상이(고메모리) → 독립 스케일   │
                 └─────────────────────────────────────────────┘
```

**3대 격리 원칙:**
1. **크롤/추출을 독립 마이크로서비스로** — 나머지 서비스와 HTTP/gRPC/큐로만 통신. 언어 교체 시 재작성 범위 = 이 서비스 1개. (→ 조직이 Python이어도 API 계층은 Python, 크롤러만 Node 유지 같은 하이브리드도 가능)
2. **헤드리스 렌더를 별도 워커 풀로 재격리** — 메모리/CPU 프로파일이 페치와 완전히 다름(브라우저 인스턴스당 수백 MB). 독립 오토스케일·독립 언어 교체. 큐(예: `fetch_strategy=dynamic`)로 오프로드.
3. **계약을 언어중립 스키마로 고정** — `{url}` 입력 → OG payload JSON 출력을 JSON Schema로 못박음. 이 스키마가 안정적이면 내부 런타임은 블랙박스.

> **경계 스키마의 소유권:** 페치 결과 스키마(`normalized_url`/`final_url`/`canonical_url`/`redirect_chain`/`fetch_strategy`/`error_code`) 자체는 **`crawl-engine-architect`가 정의**하고 platform-architect(캐시 key)·reliability-ops(추적)가 소비한다(요구사항 경계면 계약). 나는 그 스키마를 **구현할 언어/라이브러리**를 규정할 뿐, 스키마 필드는 crawl-engine의 진실을 따른다. 다만 격리 마이크로서비스 경계 자체는 위와 같이 강력히 권고한다.

---

## POC로 검증할 항목 (라이브러리 성숙도 불확실성 해소)

착수 전 반나절 스파이크로 확정할 것:
1. `metascraper` 폴백 체인이 실제 대상 사이트군(뉴스/커머스/SNS)에서 og 누락 시 JSON-LD/휴리스틱으로 얼마나 복구하는지 — 커버리지 측정.
2. `undici` 수동 리다이렉트 추적으로 `redirect_chain` + 단축 URL(bit.ly 등) 최종 해석이 깔끔한지.
3. Playwright 워커 1개당 동시 렌더 처리량 & 메모리 상한 → 워커 풀 사이징.
4. (Python 채택 시) `httpx` async + `extruct` 조합의 인코딩 감지(`charset-normalizer`)가 EUC-KR 페이지에서 정상인지.

---

## 경계면 계약

> 이 섹션은 `crawl-engine-architect`와 `implementation-engineer`가 **전제로 삼을 인터페이스**다. 아래를 확정 사실로 소비하라.

### (a) 언어 / 런타임 — 확정

| 분기 | 결정 | 프레임워크 |
|---|---|---|
| **그린필드(기본)** | **Node.js 22 LTS + TypeScript** | **Fastify** (대안 NestJS) |
| 기존 스택 = Python | **CPython 3.12+ (asyncio 전면)** | **FastAPI + uvicorn** |
| 기존 스택 = Node | Node.js 22 LTS + TypeScript (기본 재확인) | Fastify |

- **미지정 시 소비 규칙:** `implementation-engineer`는 **Node.js(TypeScript) + Fastify** 를 참조 구현 언어로 전제하라. 조직이 Python 중심임이 확인되면 Python 스택으로 스위치(반대 선택 조건).
- 이 결정은 **크롤/추출 마이크로서비스에 국한**된다. API/Preview 계층은 조직 표준 언어를 따라도 되며, 계약은 언어중립 JSON.

### (b) 페치 · 파싱 · 헤드리스 라이브러리 스택 — 확정

| 계층 | 그린필드/Node (기본 전제) | Python 분기 (반대 선택 시) |
|---|---|---|
| **페치** | `undici` (대안 `got`) | `httpx` (async, 대안 `aiohttp`) |
| **HTML 파싱** | `cheerio` (`htmlparser2` 엔진) | `selectolax` (대안 `BeautifulSoup4`+`lxml`) |
| **OG/구조화 추출** | `metascraper` + 룰 플러그인 (대안 `open-graph-scraper`/`unfurl`) | `extruct` + `w3lib` (대안 `metadata_parser`) |
| **헤드리스(동적 링크 전용)** | **`playwright`** (대안 `puppeteer`) | **`playwright`** (Python 바인딩) |
| **문자셋** | `iconv-lite` + `content-type` | `charset-normalizer` |
| **URL 정규화** | 내장 `URL` + `normalize-url` | `courlan` / `w3lib.url` + `yarl` |

- **헤드리스 계층은 언어 무관(Playwright 공통 엔진)** — 별도 워커 풀로 격리하며, 런타임 결정과 독립적으로 교체 가능하다.
- `crawl-engine-architect`에게: 위 페치/파싱 라이브러리를 전제로 `redirect_chain`·`fetch_strategy`(static/dynamic)·`error_code` 매핑을 설계하라. `undici`(또는 `httpx`)의 수동 리다이렉트 제어가 단축 URL 추적의 구현 기반이다.
- `implementation-engineer`에게: 위 스택으로 참조 구현을 작성하라. 프레임워크 = Fastify(Node)/FastAPI(Python).

### 경계 아키텍처 — 확정 권고
- 크롤/추출은 **독립 마이크로서비스**(런타임 결정 봉인 지점).
- 헤드리스 렌더는 **별도 워커 풀**(독립 스케일/독립 교체).
- 서비스 간 계약은 **언어중립 JSON Schema** (필드 정의 소유권은 crawl-engine-architect).
