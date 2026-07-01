---
name: unfurl-platform-architecture
description: "OG 추출(unfurl) 서비스의 시스템 아키텍처를 설계하는 스킬. API 형태(동기/비동기), 캐싱 전략과 캐시 key 기준(URL 정규화 + 최종 URL 2단계 키), TTL/negative cache/SWR, DB 선택 유무와 선택 기준(Redis+Postgres+오브젝트 스토리지), 응답 속도 최적화(request coalescing/CDN/범위요청), 큐 기반 확장 토폴로지를 산출한다. 아키텍처·캐싱 key·DB 선택·응답 속도·시스템 디자인·확장 논의 시 반드시 이 스킬을 사용할 것."
---

# Unfurl Platform Architecture — OG 추출 서비스 시스템 설계

OG 추출 서비스 전체를 설계한다. 응답 속도·비용·정합성의 트레이드오프를 조율한다. 핵심 원리: **캐시 key는 정규화가 전부**, **최종 URL로도 캐시하면 히트율이 뛴다**, **DB 선택은 접근 패턴의 함수**.

## 언제 이 스킬을 쓰는가
API 설계, 캐싱 전략/캐시 key, TTL, DB 선택 여부와 기준, 응답 속도 개선, 확장 토폴로지, 이미지 프록시.

---

## 1. 아키텍처 개요

```
클라이언트
   │  GET /unfurl?url=...
   ▼
[CDN/Edge]  (공개·캐시 가능 응답 캐싱)
   ▼
[API 티어] (stateless, 오토스케일)
   │   1) URL 정규화 → 캐시 key
   │   2) 캐시 조회 (핫 경로 — 대부분 여기서 반환)
   │   3) miss → single-flight로 크롤 요청
   ▼
[인메모리 LRU] → [Redis 캐시] → (miss)
   ▼
[큐]  (콜드/대량/재시도 — SQS/Redis Streams/Kafka)
   ▼
[크롤 워커]  static 풀 ┃ headless 풀 (리소스 프로파일 분리)
   ▼
[Postgres 내구/운영]  +  [오브젝트 스토리지 이미지] + CDN
```

핵심 분리: **static 워커와 headless 워커를 다른 풀로**. 헤드리스는 CPU/메모리가 무거워 같은 풀에 두면 static 처리량을 잠식한다.

---

## 2. API 계약 (동기 vs 비동기)

- **동기** `GET /unfurl?url=`: 캐시 히트(대부분)와 빠른 static 크롤에 사용. **짧은 타임아웃 예산**(예: 3s)을 두고 초과 시 부분 결과 또는 202로 전환.
- **비동기** `POST /unfurl/batch` → `202 Accepted` + 폴링/웹훅: 대량 미리보기 생성, 콜드 헤드리스 크롤 등 느린 경로. 큐에 넣고 완료 시 알림.
- 응답에 `completeness`와 `cache`(hit/miss/stale)를 실어 소비자가 품질/신선도를 판단하게 한다.

**권고**: 인터랙티브 경로는 동기+SWR+짧은 타임아웃, 대량은 비동기 큐.

---

## 3. 캐싱 key 기준 (이 서비스의 심장)

### 3-1. URL 정규화 (1차 key)

캐시 key는 정규화 품질이 히트율을 결정한다. 순서대로:
1. scheme/host **소문자화**
2. 기본 포트 제거 (`:80`, `:443`)
3. **트래킹 파라미터 제거**: `utm_*`, `fbclid`, `gclid`, `igshid`, `ref`, `mc_eid` 등
4. 쿼리 파라미터 **정렬** (순서 무관하게 동일 key)
5. **fragment(`#...`) 제거**
6. trailing slash 정규화, 중복 슬래시 정리
7. **IDN → punycode**, 퍼센트 인코딩 정규화

→ `key1 = "og:v1:" + sha256(normalized_url)`

### 3-2. 2단계 키 — 최종 URL로도 캐시

서로 다른 단축/트래킹 변형이 **같은 canonical 페이지로 수렴**한다. 이를 활용해 히트율을 크게 올린다:

```
매핑 캐시 : normalized_url  → final_url / canonical_url   (긴 TTL, 값이 거의 안 변함)
payload 캐시: final_url(또는 og:url/canonical) → OG payload
```

조회 흐름: `normalized_url`로 매핑 캐시 조회 → `final_url` 획득 → payload 캐시 조회. miss여도 다른 입력이 같은 `final_url`을 이미 채웠다면 즉시 히트. 페이지가 선언한 `og:url`/`<link rel=canonical>`이 있으면 그것을 payload key로 우선.

### 3-3. TTL / Negative / SWR

| 종류 | 정책 |
|---|---|
| positive TTL | origin `Cache-Control`/`Expires` 존중, 없으면 도메인별 기본(뉴스 길게, 소셜 짧게), 전역 기본 1~7일 |
| **negative cache**(실패) | 짧은 TTL(5~30분) — 깨진 URL 반복 크롤 방지하되 회복 허용. `error_code`도 저장 |
| **SWR** | 만료 직전 값은 즉시 반환 + 백그라운드 갱신 → 체감 지연 최소 |
| 매핑 캐시 | 긴 TTL (단축→최종 매핑은 거의 불변) |

---

## 4. DB 선택 유무 및 기준

### "DB가 필요한가?"에 정직하게

- **순수 best-effort 캐시 + 운영 요구 없음(MVP)** → Redis-only 가능. 재시작 시 캐시 소실 감수.
- **그러나** 실패 추적·실패율 감소(운영 요구)는 **조회 가능한 내구 저장소를 강제**한다 → Postgres 필요. 대부분의 실서비스는 여기 해당.

### 저장소 결정표

| 무엇 | 어디에 | 왜 |
|---|---|---|
| OG payload 핫 캐시, URL→최종 매핑 | **Redis**(KeyDB/Dragonfly) | key-value 핫 읽기, TTL 네이티브, SWR 구현 용이 |
| 크롤 레코드 / `failed_crawls` / per-domain 규칙 / payload 내구 사본 | **PostgreSQL** | 실패 도메인 top-N 등 **SQL 집계** 필요, 유연 payload는 **JSONB**, 운영상 신뢰 |
| `og:image` 프록시/리사이즈 사본 | **오브젝트 스토리지(S3/GCS)** + CDN | 핫링크/깨진 이미지 방지, 엣지 캐싱 |
| 시계열 메트릭 | Prometheus(+장기 저장) | 이미 관측 스택 |

### DB 선택 기준 (일반화)

접근 패턴의 함수로 고른다: **핫 key-value 읽기 → Redis**, **분석/집계 → SQL**, **유연 스키마 payload → JSONB/문서**, **시계열 → Prometheus/TimescaleDB**. 특수 DB(Mongo/Cassandra)는 스케일이 강제할 때만. **Redis + Postgres 조합이 이 도메인의 95%를 커버**한다.

---

## 5. 응답 속도 최적화

- **캐시 우선 + SWR** — 최대 지렛대. 대부분 요청이 캐시에서 즉시 반환.
- **request coalescing (single-flight)** — 콜드 URL에 동시 요청이 몰려도(썬더링 허드) **크롤은 1회만** 하고 나머지는 그 결과를 공유. 캐시 스탬피드 방지의 핵심.
- **커넥션 풀 + keep-alive + HTTP/2**, **DNS 캐싱**.
- **범위 요청**으로 `<head>`만 — OG는 앞부분에 있음.
- **gzip/br**, **헤드리스 브라우저 풀 웜스타트**.
- **프리워밍**: 인기 URL을 사전 크롤/갱신.
- **CDN 엣지 캐싱**: 공개·캐시 가능 응답.
- **타임아웃 예산**: 빨리 실패하고 부분 결과 반환 — 느린 origin이 전체 지연을 끌지 않게.

---

## 6. 확장 토폴로지

- **stateless API 티어** 오토스케일.
- **큐**(SQS/Redis Streams/Kafka)로 비동기 + 재시도 + DLQ.
- **워커 풀 분리**: static(가벼움, 고동시성) ┃ headless(무거움, 저동시성).
- **도메인별 rate-limit**: 예의(politeness) + 429 회피. per-domain 규칙의 `rate_limit_rps` 소비.
- 규모 3구간으로 제시: MVP(단일 API+Redis+Postgres) / 성장기(큐+워커 분리+CDN) / 대규모(멀티리전 캐시, 이미지 파이프라인, 프리워밍).

## 출력 형식
(1) 아키텍처 다이어그램 → (2) API 계약 → (3) 캐시 key 규칙 + 2단계 키 + TTL/negative/SWR → (4) DB 결정표 + 선택 기준 → (5) 응답 속도 기법 → (6) 확장 토폴로지.

## 원칙
- **캐시 key는 정규화가 전부다.** 트래킹 파라미터 제거 + 쿼리 정렬만으로 히트율이 크게 오른다.
- **최종 URL로도 캐시**하여 단축/변형 URL을 수렴시킨다.
- **DB는 접근 패턴의 함수** — Redis(핫) + Postgres(집계/내구)가 기본선. 운영 요구가 DB를 강제한다.
- **request coalescing**으로 캐시 스탬피드를 막는다.
