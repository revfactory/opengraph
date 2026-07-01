# opengraph — URL → Open Graph 추출 서비스

사용자가 URL을 입력하면 해당 URL의 Open Graph 메타데이터(제목·설명·이미지 등)를 추출해 링크 미리보기를 제공하는 서비스의 **설계 · 참조 구현 · 운영 체계**.

> 이 저장소는 `og-extraction-orchestrator` 하네스(전문 에이전트 팀)로 산출됐다. **실행 가능한 서비스 소스는 [`service/`](service/)**, 설계 상세는 [`docs/`](docs/). 하네스 재실행/부분 수정은 CLAUDE.md의 트리거 규칙 참조. (`_workspace/`는 팀 실행의 감사 추적용 중간 산출물)

---

## 4개 핵심 결정 (요약)

| # | 주제 | 결정 | 상세 |
|---|------|------|------|
| ① | **런타임** | 그린필드 = **Node.js 22 + TypeScript + Fastify**. 조직이 Python 중심이면 **FastAPI로 반전**. 크롤러를 독립 마이크로서비스로 격리해 결정을 되돌릴 수 있게 함 | [docs/01_runtime.md](docs/01_runtime.md) |
| ② | **실패 추적 / 실패율 감소** | 단일 **에러 taxonomy(28코드)** → `crawl_attempts`/`failed_crawls`(Postgres) **SQL 집계** → **per-domain 규칙 테이블(hot-reload 레버)** → **주간 플라이휠** | [docs/01_reliability_ops.md](docs/01_reliability_ops.md) |
| ③ | **정적이지 않은 링크** | **비용 순 승격 래더**(static→oEmbed→headless), 신호 기반 헤드리스, 리다이렉트/단축링크 최종 URL 확정, **SSRF: DNS 해석 후 + IP 핀 + 홉마다 재검증** | [docs/01_crawl_engine.md](docs/01_crawl_engine.md) |
| ④ | **아키텍처 / 캐싱 / DB / 속도** | **2단계 캐시 key**(정규화 URL→payload_key) + SWR + single-flight, **Redis(핫) + Postgres(집계/내구) + 오브젝트 스토리지(이미지)** | [docs/01_platform.md](docs/01_platform.md) |

**통합 설계 + 경계면 확정**: [docs/02_integrated_architecture.md](docs/02_integrated_architecture.md) · **경계면 검증(QA)**: [docs/04_integration_review.md](docs/04_integration_review.md)

---

## 아키텍처 한눈에

```
클라이언트 ─GET /unfurl?url=─▶ [CDN] ─▶ [API 티어(stateless)]
                                          │ normalize_url → 2단계 캐시 조회(L1 LRU → Redis)
                                          │  hit → 즉시 / stale → SWR / miss → single-flight
                                          ▼
                              [크롤/추출 마이크로서비스]  ← 런타임 결정 봉인 지점
                                Stage0 정규화+SSRF(DNS후 IP핀)
                                Stage1 static(수동 리다이렉트·홉마다 SSRF·Range)
                                승격신호→ Stage2 oEmbed / Stage3 headless(Playwright, 별도 풀)
                                폴백파싱 OG→Twitter→oEmbed→JSON-LD→HTML (completeness)
                                          │
                     ┌────────────────────┼─────────────────────┐
                     ▼                    ▼                     ▼
              Redis(핫캐시/락)   Postgres(crawl_attempts·      오브젝트스토리지
                                 failed_crawls·domain_rules·dlq)   +CDN(이미지)
                                          │
                          [비동기] 큐→재시도(백오프)→DLQ→주간 플라이휠(집계→진단→규칙→백필→측정)
```

**3대 불변식**: ① 최종 URL이 진실의 원천 · ② 비용 순 승격(헤드리스는 신호가 있을 때만) · ③ 분류 없는 실패는 못 고친다(단일 에러 코드).

---

## 참조 구현

Node.js 22 + TypeScript. 소스는 [`service/`](service/)(23개 모듈). 코어 로직(URL 정규화·SSRF-safe 페치·계층적 승격·OG 폴백 파싱·2단계 캐시 key·에러 taxonomy)은 완전 구현. 상세 실행법은 [`service/README.md`](service/README.md).

```bash
cd service
npm install
npm run typecheck      # 타입 검증
npm run smoke          # 순수 로직 검증 15종
# 로컬 인메모리 모드로 기동 (외부 의존 0):
npm run dev
open http://localhost:8080/   # ← 웹 콘솔(플레이그라운드): URL 입력 → 미리보기 + 진단
# 실제 Redis+Postgres 모드:
docker compose up
```

**웹 콘솔** (`GET /`, [`service/public/index.html`](service/public/index.html)) — URL을 입력하면 추출된 OG 미리보기 카드와 진단 리드아웃(fetch 전략·캐시 상태·완성도 게이지·**리다이렉트/단축링크 체인**·source map·에러 taxonomy)을 보여주는 단일 파일 플레이그라운드. 같은 오리진의 `/unfurl?...&debug=true`를 호출한다.

- **검증 상태**: `typecheck` 에러 0 · `smoke` 15/15 · 라이브 e2e(정상 추출 / SSRF 차단 / INVALID_URL) 통과 · 경계면 QA 11 PASS / 0 MISMATCH.

---

## 디렉토리

```
opengraph/
├── README.md                 # (이 파일) 최종 패키지
├── CLAUDE.md                 # 하네스 포인터 + 트리거 규칙 + 변경 이력
├── service/                  # ★ 실행 가능한 Node/TS 서비스 (src/ 23개 모듈, docker compose up)
│   ├── src/                  #   normalize·safe-fetch·ssrf·extract·cache·taxonomy·api ...
│   ├── migrations/ · docker-compose.yml · Dockerfile · test/
│   └── README.md             #   서비스 실행 안내
├── docs/                     # 확정 설계 문서 (4개 고려사항 + 통합 + QA)
├── .claude/agents/ (6) · skills/ (7)   # 재사용 하네스
└── _workspace/               # 팀 실행 중간 산출물 (설계 원본 01~04 · 감사 추적)
```
