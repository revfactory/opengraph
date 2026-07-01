---
name: crawl-engine-design
description: "정적이지 않은 링크(JS 렌더링 SPA, 리다이렉트 체인, bit.ly/t.co 단축 링크, 봇 차단, 인터스티셜)에서 OG 메타데이터를 추출하는 크롤링 엔진을 설계하는 스킬. 계층적 페치 승격(static→oEmbed→headless), 리다이렉트/단축링크 해석, 최종 URL 확정, OG/Twitter/oEmbed/JSON-LD 폴백 파싱, SSRF 방어를 산출한다. 동적 링크·리다이렉트·단축 URL·크롤링 실패·헤드리스 렌더링 논의 시 반드시 이 스킬을 사용할 것."
---

# Crawl Engine Design — 링크 페치/파싱 엔진 설계

정적 HTML이 아닌 링크에서 최대한 싸게, 최대한 많이 OG를 얻는 엔진의 설계 절차. 핵심 원리는 **비용 순 승격**과 **최종 URL이 진실의 원천**이다.

## 언제 이 스킬을 쓰는가
동적/JS 렌더링 페이지, 리다이렉트, 단축 링크, 봇 차단 대응, 헤드리스 렌더링, OG 파싱 폴백, SSRF 방어 설계.

---

## 1. 계층적 페치 승격 (Escalation Ladder)

싼 방법부터 시도하고 실패 신호가 있을 때만 비싼 방법으로 승격한다. 대부분의 URL은 1단계에서 끝난다.

```
[정규화·SSRF 검증]
      ↓
1. Static fetch (HTTP GET)        ← ~80-90% 여기서 완료
      · 실제 브라우저 UA + Accept 헤더
      · 리다이렉트 따라감(체인 기록)
      · 본문 범위 제한 (앞 512KB~1MB / Range) — OG는 <head>에 있음
      · gzip/br 해제, charset 감지
      ↓ (OG 충분? → 완료)
      ↓ NO_OG_TAGS & content-type=HTML
2. oEmbed/공급자 API              ← YouTube/X/Vimeo/Spotify 등 known provider
      · 스크래핑보다 안정적, 렌더링 불필요
      ↓ (provider 아님 또는 실패)
3. Headless render (Playwright)   ← 비싸다. 마지막 폴백
      · SPA 셸 신호 or force-headless 도메인일 때만
      · network-idle 또는 특정 selector 대기 → DOM에서 추출
      · 브라우저 컨텍스트 풀, 동시성 상한, 하드 타임아웃
```

**승격 판단은 신호 기반**: static 결과가 `NO_OG_TAGS`인데 (a) content-type이 HTML이고 (b) `<head>`가 빈약(SPA 셸: 큰 JS 번들, 최소 메타)하거나 (c) 도메인이 per-domain 규칙에서 `force-headless`면 3단계로. 그 외에는 헤드리스로 올리지 않는다 (비용).

---

## 2. 리다이렉트 & 단축 링크 해석

**리다이렉트 처리:**
- 최대 홉 수 제한 (예: 10). 초과 시 `TOO_MANY_REDIRECTS`.
- **전체 체인 기록** (`redirect_chain: [url, status, location]`). 루프 감지(방문 URL 집합).
- HTTP 3xx뿐 아니라 **meta-refresh**(`<meta http-equiv=refresh>`)와 **JS 리다이렉트**(`location.href=`)도 처리. 후자는 static으로 안 잡히면 헤드리스 승격 신호.
- `Location`이 상대/프로토콜-상대 URL이면 현재 URL 기준으로 절대화.
- **최종 URL(final resolved URL)을 반드시 반환**한다 — OG 태그는 최종 페이지에서 나오고, 캐싱 key의 근거가 된다.

**단축 링크(bit.ly, t.co, lnkd.in, tinyurl, 브랜디드 도메인 등):**
- 본질은 HTTP 리다이렉트 → 위 알고리즘으로 최종 URL까지 따라간다.
- 일부(t.co 등)는 JS/쿠키/인터스티셜을 요구 → 헤드리스 승격이 필요할 수 있음.
- **known short-link 도메인 목록을 데이터로 관리**(코드 배포 없이 갱신) → (a) 항상 완전 해석, (b) 도메인별 전략 적용.
- **short→final 매핑을 캐시**하여 재해석 비용 제거 (긴 TTL — 단축 링크 타겟은 거의 안 변함).

---

## 3. 폴백 추출 우선순위 + 완성도 점수

OG(`og:*`)가 이상적이지만 없을 때를 대비해 폴백 계층을 둔다. 우선순위 순으로 채운다:

| 순위 | 소스 | 필드 |
|---|---|---|
| 1 | Open Graph (`og:title/description/image/url/type/site_name`) | 표준 |
| 2 | Twitter Card (`twitter:title/description/image/card`) | OG 보완 |
| 3 | oEmbed (provider 응답) | title/author/thumbnail |
| 4 | JSON-LD / microdata (`schema.org`) | headline/image/description |
| 5 | HTML 기본 (`<title>`, `<meta name=description>`, 대표 `<img>`, favicon) | 최후 폴백 |

- 각 필드는 위에서부터 채우고, 이미 채워졌으면 덮지 않는다 (OG 우선).
- **완성도 점수(completeness)** 계산: 핵심 필드(title/description/image) 충족 비율. 소비자가 품질을 판단하고 캐시 TTL을 조정할 수 있게 반환.
- `og:image` 등 상대 URL은 **최종 URL 기준으로 절대화**한다.

---

## 4. 안전성 체크리스트 (필수)

크롤러는 임의 URL을 받는 SSRF의 온상이다. 다음을 코드에 내장한다:

- **SSRF 가드**: 사설 IP 대역(10/8, 172.16/12, 192.168/16, 127/8, ::1, fc00::/7), 링크로컬(169.254/16), **클라우드 메타데이터(169.254.169.254)** 차단. **DNS 해석 후의 실제 IP로 검증**하고, **리다이렉트 홉마다 재검증**한다 (리다이렉트가 내부로 point할 수 있음 — 가장 흔한 실수).
- **스킴 허용목록**: http/https만. `file:`, `gopher:`, `ftp:` 등 거부.
- **본문 크기 상한**: 스트리밍하며 상한 초과 시 중단 (`TOO_LARGE`).
- **요청 타임아웃**: 연결/전체 각각. 헤드리스는 별도 하드 타임아웃.
- **charset/압축**: Content-Type + `<meta charset>` + BOM으로 인코딩 결정. gzip/br 해제.
- **UA/헤더**: 실제 브라우저 UA + `Accept`/`Accept-Language`. 봇 차단 도메인은 per-domain 규칙으로 UA/헤더 오버라이드.
- **robots.txt**: 존중 여부는 정책 결정 — 존중 시 정책 위반은 `ROBOTS_DISALLOWED`로 분류.

---

## 5. 표준 반환 스키마

엔진의 출력은 아키텍처(캐싱)와 운영(실패추적)의 입력이 된다. 다음을 반드시 포함:

```json
{
  "input_url": "https://bit.ly/xxxx",
  "normalized_url": "https://bit.ly/xxxx",
  "final_url": "https://example.com/article/123",
  "canonical_url": "https://example.com/article/123",
  "redirect_chain": [{"url":"...","status":301}, ...],
  "fetch_strategy": "static | oembed | headless",
  "status": "ok | partial | failed",
  "error_code": null,
  "http_status": 200,
  "content_type": "text/html",
  "completeness": 0.83,
  "og": { "title": "...", "description": "...", "image": "...", "site_name": "...", "type": "article" },
  "fetched_at": "ISO-8601",
  "latency_ms": 412
}
```

`normalized_url`/`final_url`/`canonical_url`은 **캐싱 key 설계의 근거**(platform-architect와 공유). `error_code`/`fetch_strategy`/`latency_ms`는 **운영 메트릭의 입력**(reliability-ops와 공유).

## 원칙
- **비용 순 승격**: 헤드리스는 마지막 폴백. 항상 헤드리스로 크롤하지 않는다.
- **최종 URL이 진실**: 리다이렉트/단축링크는 끝까지 따라가고 최종 URL을 캐싱·파싱의 기준으로 삼는다.
- **실패를 삼키지 말고 에러 코드로 분류**하여 운영으로 넘긴다.
- SSRF 검증은 **DNS 해석 후 + 홉마다** — 이 한 줄이 사고를 막는다.
