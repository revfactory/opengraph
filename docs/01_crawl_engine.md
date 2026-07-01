# 01 · 크롤링 엔진 설계 — 정적이지 않은 링크 대응 (고려사항 ③)

> 작성: crawl-engine-architect
> 범위: 요구사항 ③ (동적/JS 렌더링 링크, 리다이렉트되는 단축 링크)
> 핵심 원리: **비용 순 승격(cost-ordered escalation)** · **최종 URL이 진실의 원천(final URL is source of truth)** · **실패는 삼키지 말고 에러 코드로 분류**
> 경계면: 마지막 `## 경계면 계약` 섹션이 reliability-ops / platform-architect / runtime-strategist / implementation-engineer 와의 단일 계약이다.

---

## 0. 엔진 개요 (한 장 요약)

임의의 사용자 입력 URL을 받아 **가장 싼 방법부터** OG 데이터를 시도하고, 실패 신호가 있을 때만 비싼 단계로 승격한다. 모든 리다이렉트/단축 링크는 끝까지 따라가 **최종 URL**을 확정하고, 그 최종 URL을 파싱·캐싱·SSRF 검증의 기준으로 삼는다. 모든 실패는 표준 에러 코드로 분류되어 운영으로 넘어간다.

```
입력 URL
  │
  ▼
[Stage 0] 정규화 + SSRF 사전검증 (DNS 해석 후 IP 검증, IP 핀)
  │
  ▼
[Stage 1] Static fetch ───────────────► OG 충분? ──► 완료 (~80-90%)
  │  (browser UA / redirect 추적 / Range·스트리밍 상한 / gzip·br / charset)
  │
  ├─(승격 신호 평가)
  │
  ├─ known provider 도메인 ─► [Stage 2] oEmbed/공급자 API ─► 완료
  │
  └─ SPA 셸 / JS 리다이렉트 / force_headless ─► [Stage 3] Headless(Playwright) ─► 완료/부분
  │
  ▼
[폴백 추출] OG → Twitter → oEmbed → JSON-LD → HTML  (완성도 점수 산출)
  │
  ▼
표준 반환 스키마 (normalized/final/canonical URL, redirect_chain, fetch_strategy, error_code, completeness)
```

**설계 불변식**
1. 각 단계는 **부분 결과라도 반환**한다. 상위 단계 실패 시 하위 단계의 부분 OG를 완성도 낮게 표기해 보존한다.
2. 승격은 **신호 기반**이다. "일단 헤드리스"는 금지 — 비용/차단 리스크가 크다.
3. SSRF 검증은 **DNS 해석 후 + 리다이렉트 홉마다** 반복한다. 이 한 줄이 사고를 막는다.

---

## 1. 계층적 페치 승격 래더 (Escalation Ladder)

### 1.1 오케스트레이터 의사코드

```pseudo
function fetch_og(input_url, domain_rules):
    t0 = now()
    result = new FetchResult(input_url)

    # ── Stage 0: 정규화 + SSRF 사전검증 ──
    norm = normalize_url(input_url)                 # §2.4
    result.normalized_url = norm
    guard = ssrf_precheck(norm)                     # DNS 해석→IP 검증→IP 핀 (§4)
    if guard.blocked: return fail(result, guard.error_code)   # SSRF_BLOCKED / SCHEME_BLOCKED / PORT_BLOCKED

    rule = resolve_domain_rule(norm.host, domain_rules)  # §경계면(c)

    # ── 단축링크 캐시 단락 ──
    if rule.is_short_link and cache.has(short_map, norm):
        norm = cache.get(short_map, norm)           # 최종 URL로 점프 (재해석 비용 0)
        result.redirect_chain.append({url: input_url, status: "CACHED", location: norm})

    # ── Stage 1: Static fetch ──
    static = static_fetch(norm, rule, guard.pinned_ip)   # §2.1, redirect 추적 포함
    result.merge(static)                            # final_url / redirect_chain / http_status / body
    if static.error_code in HARD_ERRORS:            # DNS_FAIL / SSRF_BLOCKED / TOO_MANY_REDIRECTS 등 → 헤드리스로도 해결 불가
        return fail(result, static.error_code)

    parsed = extract_metadata(static.body, result.final_url)   # §3 폴백 파서
    result.merge(parsed)

    # ── 승격 판단 (§1.2) ──
    decision = escalation_decision(result, static, rule)
    if decision == DONE:
        return finalize(result, "static", t0)

    if decision == OEMBED:                          # Stage 2
        oe = oembed_fetch(result.final_url, rule)
        if oe.ok:
            result.merge_fill(oe.metadata)          # 빈 필드만 채움
            return finalize(result, "oembed", t0)
        # oEmbed 실패 → 헤드리스 재평가로 낙하

    if decision == HEADLESS or should_headless_after_oembed(result, rule):  # Stage 3
        hl = headless_render(result.final_url, rule)     # §1.3
        if hl.ok:
            hl_parsed = extract_metadata(hl.dom_html, hl.final_url)
            result.merge_fill(hl_parsed)            # static 부분결과 위에 덮어쓰기(빈 필드 우선)
            result.final_url = hl.final_url         # JS 리다이렉트 반영
            return finalize(result, "headless", t0)
        else:
            # 헤드리스 실패해도 static 부분결과는 보존, 완성도 낮게
            return finalize(result, "static", t0, note=hl.error_code)  # JS_TIMEOUT 등

    return finalize(result, static.error_code ? "static" : "static", t0)
```

`finalize()`는 completeness 점수(§3.2)를 계산하고 `status`(ok/partial/failed)를 결정한다:
- completeness ≥ `COMPLETE_THRESHOLD`(기본 0.66, 즉 핵심 3필드 중 2개) → `ok`
- 0 < completeness < threshold → `partial`
- 0 이거나 치명 에러 → `failed`

### 1.2 승격 판단 신호 (핵심)

`escalation_decision(result, static, rule)` 반환값: `DONE | OEMBED | HEADLESS`

| 우선순위 | 조건 | 결정 | 이유 |
|---|---|---|---|
| 1 | `completeness ≥ COMPLETE_THRESHOLD` | **DONE** | 이미 충분. 더 비싼 단계 불필요 |
| 2 | `content_type`이 HTML이 아님 (image/pdf/video/json) | **DONE** | 헤드리스로도 OG 안 나옴. §3.3 비-HTML 처리 |
| 3 | `static.error_code` ∈ 하드에러(DNS_FAIL/CONN_TIMEOUT/SSRF_BLOCKED/TOO_MANY_REDIRECTS) | **DONE(fail)** | 렌더링해도 동일 실패 |
| 4 | `rule.force_headless == true` | **HEADLESS** | 도메인 사전지식(항상 SPA/차단) |
| 5 | `final_url.host` ∈ known oEmbed providers | **OEMBED** | 스크래핑보다 안정적, 렌더 불필요 |
| 6 | `NO_OG_TAGS` & HTML & **SPA 셸 신호**(§1.2.1) | **HEADLESS** | 클라이언트 렌더 콘텐츠 |
| 7 | `NO_OG_TAGS` & HTML & **JS 리다이렉트 신호**(§2.3) | **HEADLESS** | 정적으로 못 따라간 리다이렉트 |
| 8 | `HTTP 403/429` + 챌린지 마커(§1.2.2) & `rule.allow_headless_on_challenge` | **HEADLESS** | 봇 인터스티셜 통과 시도(정책 gated) |
| else | — | **DONE** | 부분 결과라도 확정 (헤드리스 남발 금지) |

#### 1.2.1 SPA 셸 신호 (static `<head>`가 빈약한가?)
아래를 가중 합산해 `spa_shell_score`가 임계 초과면 SPA로 판정:
- `<head>` 내 `<meta>` 태그 수 ≤ 3 (charset/viewport만 존재)
- OG/Twitter/JSON-LD/`<title>` 모두 부재 또는 `<title>`이 일반 셸("Loading…", 사이트명만)
- 앱 마운트 루트 존재: `<div id="root">`, `<div id="app">`, `<div id="__next">`, `ng-app`, `data-reactroot`
- `<body>` 텍스트 길이 대비 `<script>` 바이트 비율이 매우 높음 (본문<번들)
- `__NEXT_DATA__`/`__NUXT__`/`window.__INITIAL_STATE__` 등 하이드레이션 페이로드는 **오히려 static 추출 가능 신호** → SPA 점수 감점(그 JSON에서 메타 추출 시도)

#### 1.2.2 챌린지/인터스티셜 마커
`Server: cloudflare` + 본문에 `Just a moment`, `cf-chl-`, `__cf_chl`, `Attention Required`, `Checking your browser`, 또는 `<meta http-equiv=refresh>`로만 구성된 초박형 페이지. 이 경우 헤드리스 승격은 **per-domain 정책(`allow_headless_on_challenge`)으로만** 허용한다(무한 챌린지 루프·차단 악화 방지). 미허용 시 `BOT_CHALLENGE`로 분류.

---

## 2. 리다이렉트 & 단축 링크 해석 알고리즘

### 2.1 HTTP 리다이렉트 추적 (Stage 1 내부)

**수동 추적을 원칙**으로 한다(라이브러리 자동 추적 off). 이유: 홉마다 SSRF 재검증·체인 기록·IP 핀이 필요하기 때문.

```pseudo
function static_fetch(url, rule, pinned_ip):
    visited = set()
    chain = []
    hops = 0
    cur = url
    cur_ip = pinned_ip

    loop:
        if hops > MAX_REDIRECT_HOPS(=10): return err(chain, TOO_MANY_REDIRECTS)
        norm_cur = canonicalize_for_loopcheck(cur)          # 프래그먼트 제거·소문자 host
        if norm_cur in visited: return err(chain, REDIRECT_LOOP)  # 코드상 TOO_MANY_REDIRECTS 하위로 매핑 가능
        visited.add(norm_cur)

        resp = http_get(cur, headers=build_headers(rule), connect_to=cur_ip,
                        connect_timeout=CT, total_timeout=TT, stream=true)

        # 3xx 처리
        if resp.status in [301,302,303,307,308]:
            loc = absolutize(resp.headers.Location, base=cur)   # 상대/프로토콜-상대 절대화
            chain.append({url: cur, status: resp.status, location: loc, hop_type: "http"})
            g = ssrf_precheck(loc)                               # ★ 홉마다 재검증
            if g.blocked: return err(chain, g.error_code)
            cur = loc; cur_ip = g.pinned_ip; hops += 1
            continue

        # 2xx 본문 수신 (스트리밍 + 크기 상한 §4)
        body = read_capped(resp, MAX_BODY_BYTES)               # 초과 시 TOO_LARGE
        content_type, charset = detect_encoding(resp, body)     # header + <meta charset> + BOM
        text = decode(body, charset)

        # meta-refresh 소프트 리다이렉트
        mr = parse_meta_refresh(text)                           # <meta http-equiv=refresh content="0;url=..">
        if mr and mr.delay <= META_REFRESH_MAX_DELAY(=5) and looks_like_redirect_shell(text):
            loc = absolutize(mr.url, base=cur)
            chain.append({url: cur, status: 200, location: loc, hop_type: "meta_refresh"})
            g = ssrf_precheck(loc); if g.blocked: return err(chain, g.error_code)
            cur = loc; cur_ip = g.pinned_ip; hops += 1
            continue

        # 최종 페이지 도달
        return ok(final_url=cur, redirect_chain=chain, http_status=resp.status,
                  content_type=content_type, body=text,
                  js_redirect_signal=detect_js_redirect(text))   # §2.3
```

- **3xx 종류 구분 불필요**하게 전부 따라가되 체인에 status 기록(운영이 301 캐시성 vs 302 임시성 구분 가능).
- `Location` 다중 값/개행 삽입 등 이상은 방어적으로 첫 유효값만 사용.
- 리다이렉트 응답에도 쿠키가 실릴 수 있음 — 세션 쿠키 저장 후 다음 홉에 재전송(일부 인터스티셜은 쿠키 기반). 쿠키 jar은 요청 단위로만 유지(전역 공유 금지).

### 2.2 단축 링크(bit.ly, t.co, lnkd.in, tinyurl, 브랜디드 도메인 등)

- **본질은 HTTP 리다이렉트** → §2.1 알고리즘이 그대로 최종 URL까지 도달한다.
- **known short-link 도메인 목록은 데이터로 관리**(§경계면(c) `is_short_link`) — 코드 배포 없이 갱신. 목록에 있으면 (a) 항상 완전 해석 강제, (b) 도메인별 전략 적용.
- **short → final 매핑을 캐시**(긴 TTL, 기본 30일 — 단축 타겟은 거의 불변). 캐시 히트 시 §1.1처럼 최종 URL로 점프해 재해석 비용 0.
- t.co / 일부 브랜디드 단축은 **JS/쿠키 인터스티셜** → static이 `js_redirect_signal` 또는 `BOT_CHALLENGE` 반환 시 헤드리스로 승격해 최종 URL 확보.
- lnkd.in 등은 외부 링크 경고 인터스티셜 페이지(`external-link`)를 냄 → per-domain `wait_selector`/`click_selector`(선택)로 통과 or meta-refresh 파싱.

### 2.3 JS 리다이렉트 감지 (`detect_js_redirect`)

static 본문이 사실상 리다이렉트 셸인지 판정:
- 인라인 `<script>`에 `location.href=`, `location.replace(`, `location.assign(`, `window.location=`, `top.location=` 패턴 존재
- `<body>` 가시 텍스트가 매우 짧고(예: <200자) 위 패턴이 유일한 동작
- SPA 라우터 초기 리다이렉트(해시/history) 도 포함

→ `js_redirect_signal=true`면 승격표 7번으로 **헤드리스가 실제 브라우저에서 자연스럽게 리다이렉트를 수행**하고 `document.location`으로 최종 URL 확정. (static은 JS를 실행하지 않으므로 여기서 멈춘다.)

### 2.4 URL 정규화 (`normalize_url`) — 캐싱 key의 근거

platform-architect의 캐시 key 설계에 직접 사용된다. 규칙(멱등):
1. 스킴/호스트 소문자화, 트레일링 닷 제거
2. 기본 포트 제거(:80/:443)
3. 프래그먼트(`#...`) 제거 (단, `#!` hashbang은 보존 — 구형 AJAX 크롤 스킴)
4. 트래킹 파라미터 제거: `utm_*`, `fbclid`, `gclid`, `igshid`, `ref`, `ref_src`, `mc_eid` 등(목록은 데이터 관리)
5. 쿼리 파라미터 키 정렬(값 보존), 빈 쿼리 `?` 제거
6. percent-encoding 대문자 정규화, 불필요한 인코딩 해제, 경로 `.`/`..` 정리
7. IDN → punycode(ASCII) 변환

> **주의:** 정규화는 `normalized_url`(캐시 입력)용이다. **파싱·완성도·`og:image` 절대화의 기준은 항상 `final_url`(리다이렉트 종점)**이며, 표준화된 표시 URL은 `canonical_url`(`<link rel=canonical>`)이다. 세 URL을 분리 반환하는 이유가 여기 있다(§경계면(b)).

---

## 3. 폴백 추출 우선순위 + 완성도 점수

### 3.1 추출 우선순위 (위에서부터 채우고, 이미 채워졌으면 덮지 않음)

| 순위 | 소스 | 매핑 필드 | 비고 |
|---|---|---|---|
| 1 | **Open Graph** `og:title/description/image/url/type/site_name/image:width/height` | 표준 전체 | 최우선 |
| 2 | **Twitter Card** `twitter:title/description/image/card/site` | OG 공백 보완 | `twitter:image`는 `og:image` 없을 때만 |
| 3 | **oEmbed** (provider JSON) | `title/author_name/thumbnail_url/html` | Stage 2에서만 |
| 4 | **JSON-LD / microdata** (`schema.org` Article/Product/VideoObject/BreadcrumbList) | `headline/name/image/description/datePublished` | `<script type=application/ld+json>` 파싱, 배열/`@graph` 순회 |
| 5 | **HTML 기본** `<title>`, `<meta name=description>`, 본문 대표 `<img>`(면적 최대·og 후보), `favicon`/`apple-touch-icon` | 최후 폴백 | 저품질 표기 |

부가 규칙:
- **필드별 독립 채움**: title은 OG에서, image는 Twitter에서 오는 혼합도 허용(각 필드가 우선순위대로 첫 유효값 채택).
- **`og:image` 등 상대/프로토콜-상대 URL은 `final_url` 기준 절대화.** 다중 `og:image`는 배열 보존(대표=첫 번째).
- `canonical_url` = `<link rel=canonical href>` (없으면 `og:url`, 그것도 없으면 `final_url`).
- HTML 엔티티 디코드·공백 정리·과도한 길이 절단(title 300자, description 500자 상한).
- 언어: `<html lang>`/`og:locale` 수집(표시 품질용, 선택 필드).

### 3.2 완성도 점수 (`completeness` ∈ [0,1])

핵심 3필드 가중합 (소비자가 품질 판단·캐시 TTL 조정에 사용):

```
completeness = 0.40·has(title) + 0.30·has(description) + 0.30·has(image)
```

- `has(x)`는 공백/플레이스홀더 제외 유효값일 때 1.
- 가산 보너스(캡 1.0 유지, 선택): `site_name`/`type` 존재 시 각 +0.05 를 별도 `richness` 필드로 분리 보고(완성도 자체는 3필드로 고정해 계약 안정성 확보).
- `image` 검증: URL 스킴 http/https, 확장자/`content-type` 힌트로 명백한 비이미지 배제. (실제 이미지 fetch 검증은 옵션 — 비용상 기본 off, platform 캐시 워밍 시에만.)

**소비 규약(권장, platform-architect):**
- completeness ≥ 0.66 → 표준 TTL(예: 24h)
- 0 < completeness < 0.66 → 짧은 TTL(예: 1–6h, 재시도 여지)
- `failed` → negative-cache 짧게(예: 5–15m, 썬더링 방지)

### 3.3 비-HTML content-type 처리 (조기 종료)

`content_type`이 HTML이 아니면 헤드리스 승격 없이 규칙 기반 최소 카드 생성:
- `image/*` → `og:image = final_url`, title = 파일명, completeness 부분.
- `application/pdf` → title = PDF 메타/파일명(선택: 1페이지 추출은 범위 밖, 후속 훅).
- `application/json`/oEmbed 직결 → JSON에서 title/thumbnail 매핑.
- `video/*`, `audio/*` → 미디어 카드(썸네일 없음, type 표기).

---

## 4. 안전성 체크리스트 (필수 — 코드에 내장)

크롤러는 임의 URL을 받는 **SSRF의 온상**이다. 아래는 협상 불가 항목이다.

### 4.1 SSRF 가드 (`ssrf_precheck`)
- **스킴 허용목록**: `http`/`https`만. `file:`,`gopher:`,`ftp:`,`data:`,`blob:`,`ws(s):` 거부 → `SCHEME_BLOCKED`.
- **DNS 해석 후 실제 IP로 검증** (호스트명 문자열 검사만으로 불충분). 차단 대역:
  - IPv4: `10/8`, `172.16/12`, `192.168/16`, `127/8`, `0/8`, `169.254/16`(링크로컬), `100.64/10`(CGNAT), `192.0.2/24`·`198.51.100/24`·`203.0.113/24`(문서용), 브로드캐스트/멀티캐스트
  - IPv6: `::1`, `fc00::/7`(ULA), `fe80::/10`(링크로컬), `::ffff:0:0/96`(IPv4-매핑 → 매핑 해제 후 v4 규칙 재적용), `64:ff9b::/96`(NAT64)
  - **클라우드 메타데이터**: `169.254.169.254`, `fd00:ec2::254`(AWS IMDSv2), `metadata.google.internal`, Azure/`100.100.100.200`(Alibaba) 등 — 도메인/IP 양쪽 차단
- **DNS 리바인딩 방지(TOCTOU)**: 검증에 사용한 IP를 **핀(pin)** 하여 그 IP로 직접 커넥트(`connect_to`/커스텀 resolver). 검증-연결 사이 재해석 금지.
- **리다이렉트 홉마다 재검증** (§2.1) — 리다이렉트가 내부 IP를 가리키는 것이 **가장 흔한 우회**. meta-refresh/JS 리다이렉트 종점도 동일 검증.
- **포트 허용목록**: 80/443(+ 필요 시 8080/8443). 그 외 → `PORT_BLOCKED`(내부 서비스 스캔 차단).

### 4.2 리소스/견고성
- **본문 크기 상한**: 스트리밍하며 `MAX_BODY_BYTES`(기본 2MB) 초과 시 중단 → `TOO_LARGE`. static은 OG가 `<head>`에 있으므로 Range/조기중단으로 대역폭 절약(가능하면 앞 512KB–1MB만).
- **타임아웃**: connect(기본 3s) / total(기본 8s) 분리. 헤드리스는 별도 하드 타임아웃(기본 10s, §1.3).
- **charset/압축**: `Content-Type` + `<meta charset>` + BOM 순으로 인코딩 결정. `gzip`/`br`/`deflate` 해제. 잘못된 charset은 UTF-8 폴백.
- **UA/헤더**: 실제 브라우저 UA + `Accept`,`Accept-Language`,`Accept-Encoding`. 봇 차단 도메인은 per-domain `ua_override`/`headers_override`.
- **redirect 홉 상한**: `MAX_REDIRECT_HOPS`(기본 10) + 루프 감지.
- **robots.txt**: 존중 여부는 **정책 결정**(기본: OG 미리보기 목적상 존중하되 per-domain override). 위반 차단 시 `ROBOTS_DISALLOWED`.
- **동시성/속도**: per-domain `rate_limit`(§경계면(c)) 준수 — 한 도메인 폭주 방지, 차단 회피. 전역 헤드리스 동시성 상한(§1.3).

---

## 1.3 헤드리스(Playwright) 승격 규칙 + 최적화

> **런타임 가정(runtime-strategist 확인 필요):** 헤드리스 참조 구현은 **Playwright**(Chromium)이다. Node 선택 시 `playwright`, Python 선택 시 `playwright`(python). Node 대안으로 `puppeteer`도 동등. 두 언어 모두 동일 Chromium을 구동하므로 본 설계는 **언어 중립**이다. 만약 runtime이 서버리스/경량 런타임을 택하면 헤드리스는 **원격 브라우저 서비스**(browserless/외부 렌더 API)로 분리 배치할 것을 권고(§경계면 (d) 가정).

### 승격은 언제만? (§1.2 재확인)
SPA 셸 신호 · JS 리다이렉트 신호 · `force_headless` 도메인 · (정책 허용 시)봇 챌린지 — **오직 이때만**. 그 외 헤드리스 금지.

### 렌더 파이프라인
```pseudo
function headless_render(url, rule):
    ctx = pool.acquire()                 # 브라우저 1개 재사용, 요청마다 new context(격리)
    try:
        page = ctx.new_page()
        route_block(page, [image, media, font, stylesheet, ad/analytics 도메인])  # DOM만 필요 → 무거운 리소스 차단
        page.set_extra_headers(build_headers(rule))
        page.goto(url, wait_until="commit", timeout=NAV_TIMEOUT(=10s))
        wait_strategy(page, rule)         # 아래
        dom = page.content()              # 렌더 후 outerHTML
        final = page.url                  # JS 리다이렉트 반영된 최종 URL
        return ok(dom_html=dom, final_url=final)
    catch Timeout: return err(JS_TIMEOUT)
    catch NavError: return err(RENDER_FAILED)
    finally: page.close(); pool.release(ctx)   # context 파기(메모리 누수 방지)
```

**대기 전략(`wait_strategy`) 우선순위:**
1. `rule.wait_selector` 있으면 → `page.wait_for_selector(sel, timeout)` (가장 정확)
2. 없으면 → `og:title` 또는 `<meta property^=og:>` 출현 대기(짧은 폴링) + `networkidle`(캡)
3. 그래도 미충족 → `domcontentloaded` + 짧은 settle(예: 500ms) 후 진행

### 최적화 (비용/처리량)
- **브라우저 프로세스 1개 상주 + 요청당 ephemeral context**: 프로세스 콜드스타트 제거, 컨텍스트 격리로 쿠키/스토리지 누수 방지.
- **동시성 상한(세마포어)** `MAX_HEADLESS_CONCURRENCY`(기본 = min(코어수, 4~8)) — 헤드리스는 CPU/메모리 바운드. 초과 요청은 큐잉 또는 즉시 `partial`(static 결과) 반환(정책).
- **리소스 차단**: image/media/font/stylesheet + 광고/애널리틱스 도메인 abort → 페이지 로드 2–5배 가속, 대역폭 절감. (단, `lazy-loaded og:image`가 필요한 극소수는 per-domain 예외.)
- **하드 타임아웃 + 워커 재활용 상한**: N 페이지마다 context/브라우저 재생성(메모리 릴리즈). 크래시 시 브라우저 재기동 헬스체크.
- **캐시 단락**: 최종 URL이 캐시에 있으면 헤드리스 진입 자체를 회피(platform 캐시가 상위).
- **결과 보존**: 헤드리스 실패(JS_TIMEOUT 등)라도 static 부분 OG는 반환하고 completeness 낮게 표기 — 실패를 삼키지 않는다.

---

## 5. 표준 반환 스키마 (JSON)

엔진의 출력은 아키텍처(캐싱)·운영(실패추적)의 입력이다. 필드 계약은 §경계면(b)와 동일.

```json
{
  "input_url": "https://bit.ly/xxxx",
  "normalized_url": "https://bit.ly/xxxx",
  "final_url": "https://example.com/article/123",
  "canonical_url": "https://example.com/article/123",
  "redirect_chain": [
    {"url": "https://bit.ly/xxxx", "status": 301, "location": "https://t.co/yyy", "hop_type": "http"},
    {"url": "https://t.co/yyy", "status": 200, "location": "https://example.com/article/123", "hop_type": "js"}
  ],
  "fetch_strategy": "static",
  "status": "ok",
  "error_code": null,
  "http_status": 200,
  "content_type": "text/html; charset=utf-8",
  "completeness": 0.83,
  "richness": 0.10,
  "og": {
    "title": "...", "description": "...", "image": "https://example.com/a.jpg",
    "image_width": 1200, "image_height": 630,
    "site_name": "Example", "type": "article", "url": "https://example.com/article/123",
    "locale": "ko_KR"
  },
  "source_map": { "title": "og", "description": "twitter", "image": "og" },
  "fetched_at": "2026-07-01T03:12:44Z",
  "latency_ms": 412,
  "cache": { "short_link_cached": false }
}
```

- `source_map`: 각 필드가 어느 소스(og/twitter/oembed/jsonld/html)에서 왔는지 — 품질 디버깅·운영 분석용.
- `normalized_url`/`final_url`/`canonical_url` → **캐싱 key 근거**(platform-architect).
- `error_code`/`fetch_strategy`/`latency_ms`/`redirect_chain` → **운영 메트릭 입력**(reliability-ops).

---

## 경계면 계약

> 이 섹션이 팀 간 **단일 진실**이다. 다른 에이전트는 여기 정의를 소비하고, 변경 제안은 이 문서로 역류시킨다.

### (a) 표준 에러 코드 Taxonomy 초안 — crawl-engine ↔ reliability-ops 단일 진실

`error_code`는 아래 enum만 사용한다. `retryable`은 reliability-ops의 재시도/알림 정책 입력, `stage`는 실패 지점, `client_facing`은 사용자 노출용 카테고리.

| error_code | category | stage | retryable | 의미 / 트리거 |
|---|---|---|---|---|
| `OK` | success | - | - | 정상 (참고용, 보통 null) |
| `NO_OG_TAGS` | extract | parse | no | HTML이나 OG/폴백 메타 부재(부분 결과 가능) |
| `DNS_FAIL` | network | resolve | yes(백오프) | 호스트 해석 실패 |
| `CONN_TIMEOUT` | network | connect | yes | 연결 타임아웃 |
| `READ_TIMEOUT` | network | fetch | yes | 본문 수신 타임아웃(total) |
| `TLS_ERROR` | network | connect | no | 인증서/핸드셰이크 실패 |
| `HTTP_4XX` | http | fetch | no(429 제외) | 4xx(세부 `http_status` 보존) |
| `HTTP_401_403` | http | fetch | conditional | 인증/차단 — 헤드리스/UA 재시도 여지 |
| `HTTP_429` | http | fetch | yes(백오프+rate_limit) | 레이트리밋 |
| `HTTP_5XX` | http | fetch | yes | 원본 서버 오류 |
| `TOO_MANY_REDIRECTS` | redirect | redirect | no | 홉 상한 초과 (REDIRECT_LOOP 포함) |
| `TOO_LARGE` | resource | fetch | no | 본문 크기 상한 초과 |
| `UNSUPPORTED_CONTENT` | content | parse | no | HTML/이미지 등 처리 불가 타입 |
| `JS_TIMEOUT` | headless | render | yes(1회) | 헤드리스 렌더 타임아웃 |
| `RENDER_FAILED` | headless | render | yes(1회) | 헤드리스 네비/크래시 |
| `BOT_CHALLENGE` | anti-bot | fetch/render | conditional | 챌린지/인터스티셜 미통과 |
| `OEMBED_FAILED` | provider | oembed | yes | 공급자 API 실패(→헤드리스 낙하) |
| `SSRF_BLOCKED` | security | precheck/redirect | no | 사설/메타데이터/차단 IP |
| `SCHEME_BLOCKED` | security | precheck | no | 비허용 스킴 |
| `PORT_BLOCKED` | security | precheck | no | 비허용 포트 |
| `ROBOTS_DISALLOWED` | policy | precheck | no | robots.txt 정책 위반(존중 모드) |
| `INVALID_URL` | input | normalize | no | 파싱 불가 입력 |
| `UNKNOWN` | internal | any | no | 미분류(운영 알림 대상) |

> reliability-ops 협의 포인트: (1) `retryable` 컬럼을 재시도 정책의 소스로 쓸지, 별도 정책표로 뺄지. (2) SQL 집계를 위해 `category`/`stage`를 별도 컬럼으로 저장할 것(문자열 파싱 금지) — platform DB 스키마 제약(§요구사항 경계면).

### (b) 페치 결과 스키마 — crawl-engine 정의, platform(캐시 key) · reliability-ops(추적) 소비

| 필드 | 타입 | 소비자 | 설명 |
|---|---|---|---|
| `input_url` | string | ops | 원본 입력(감사) |
| `normalized_url` | string | **platform(캐시 key 후보1)** | §2.4 정규화 결과. 멱등 |
| `final_url` | string | **platform(캐시 key 후보2·권장)** / parse 기준 | 리다이렉트 종점 = 진실의 원천 |
| `canonical_url` | string | platform(중복 병합) | `rel=canonical`→`og:url`→`final_url` |
| `redirect_chain` | array<{url,status,location,hop_type}> | ops | 리다이렉트 경로. `hop_type`∈`http|meta_refresh|js|cached` |
| `fetch_strategy` | enum `static|oembed|headless` | ops(비용) / platform(TTL 힌트) | 성공 단계 |
| `status` | enum `ok|partial|failed` | 모두 | completeness/에러 기반 |
| `error_code` | enum(§a) \| null | **ops(단일 진실)** | |
| `http_status` | int \| null | ops | 최종 응답 코드 |
| `content_type` | string \| null | parse/ops | |
| `completeness` | float[0,1] | **platform(TTL)** / ops(품질) | 핵심 3필드 가중합(§3.2) |
| `richness` | float[0,1] | platform | site_name/type 등 부가 |
| `og` | object | 소비자(렌더) | 정규화된 OG 카드 |
| `source_map` | object | ops(품질분석) | 필드별 출처 |
| `latency_ms` | int | **ops(SLO)** | 총 소요 |
| `fetched_at` | ISO-8601 | platform(신선도)/ops | |

> **캐시 key 권고(platform-architect 결정 사항):** 1차 key = `normalized_url`(입력 즉시 히트 가능, 리다이렉트 전), 2차/정규 key = `final_url`(서로 다른 입력이 같은 최종 URL로 수렴 시 결과 공유). 단축 링크는 `short_map`(short→final) 별도 캐시(TTL 길게). 세 URL을 분리 반환하는 이유가 이 다층 캐시를 가능케 함.

### (c) per-domain 규칙 필드 — 엔진이 소비 (데이터로 관리, 코드 배포 없이 갱신)

`domain_rules` 저장소(platform 소유, 엔진 소비). 매칭은 정확 호스트 → 상위 도메인 → 기본값 순.

| 필드 | 타입 | 기본 | 엔진에서의 효과 |
|---|---|---|---|
| `force_headless` | bool | false | 승격표 4번 — static 건너뛰고 즉시 헤드리스 |
| `is_short_link` | bool | false | 완전 해석 강제 + `short_map` 캐시 활성 |
| `wait_selector` | string\|null | null | 헤드리스 대기 셀렉터(§1.3) |
| `ua_override` | string\|null | null | User-Agent 교체(봇 차단 회피) |
| `headers_override` | map\|null | null | Accept/Referer/Cookie 등 헤더 주입 |
| `rate_limit` | {rps,burst}\|null | 전역기본 | per-domain 요청 속도 상한(폭주/차단 방지) |
| `allow_headless_on_challenge` | bool | false | 챌린지 마커 시 헤드리스 승격 허용(§1.2.2) |
| `robots_mode` | enum `respect|ignore` | respect | robots 존중 여부 override |
| `body_byte_cap` | int\|null | 전역기본 | 도메인별 본문 상한(무거운 페이지) |
| `oembed_endpoint` | url\|null | 자동탐지 | 명시 oEmbed 엔드포인트(discovery 생략) |
| `click_selector` | string\|null | null | 인터스티셜 통과 클릭(lnkd.in 류, 선택) |

### (d) runtime-strategist 대상 가정 (명시적)
- **static fetch**: HTTP 클라이언트 + 스트리밍 본문 상한 + **커스텀 resolver/connect-to-IP(핀)** 기능이 필수. Node라면 `undici`(dispatcher로 IP 핀·리다이렉트 수동제어), Python이라면 `httpx`(+ 커스텀 transport) 또는 `aiohttp`를 참조로 가정. 자동 리다이렉트는 **off**로 설정 가능해야 한다(홉별 SSRF 재검증 때문).
- **HTML 파싱**: Node `cheerio`/`parse5`, Python `selectolax`/`lxml`+`beautifulsoup4` 를 참조 가정. JSON-LD는 표준 JSON 파서.
- **headless**: Playwright(Chromium) — §1.3. 서버리스/경량 런타임 선택 시 원격 브라우저(browserless 등)로 분리 권고.
- **동시성 모델**: static은 IO 바운드(async 유리), headless는 CPU/메모리 바운드(별도 워커 풀·세마포어). runtime 결정이 이 두 풀의 배치를 좌우한다.
- 위 라이브러리는 **참조**일 뿐 계약이 아니다. 계약은 "기능 요건"(IP 핀·수동 리다이렉트·스트리밍 상한·헤드리스 분리)이며, runtime-strategist가 등가 라이브러리로 대체 가능하다.

### 하류 에이전트 액션 아이템
- **reliability-ops**: (a) 에러 taxonomy를 재시도/알림/대시보드 스키마로 채택, `category`/`stage` 컬럼화, `latency_ms`·`fetch_strategy`로 SLO/비용 집계.
- **platform-architect**: (b) 3-URL 다층 캐시 key 확정, `completeness` 기반 TTL, `short_map` 별도 스토어, `domain_rules` 저장소 소유.
- **implementation-engineer**: §1.1 오케스트레이터·§2.1 리다이렉트·§4.1 SSRF 의사코드를 참조 구현으로 전개.
- **runtime-strategist**: (d) 기능 요건을 만족하는 라이브러리 확정 → 본 문서의 "가정"을 "결정"으로 치환.
