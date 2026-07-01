---
name: og-reference-implementation
description: "합의된 설계를 실행 가능한 참조 구현으로 옮기는 스킬. 선택된 런타임으로 URL 정규화·SSRF-safe 페치·계층적 승격·OG 폴백 파싱·2단계 캐시 key·API·실패 계측을 코드로 구현하고 ADR과 실행 안내를 함께 만든다. 참조 구현·예제 코드·스캐폴딩·PoC 요청 시 반드시 이 스킬을 사용할 것."
---

# OG Reference Implementation — 참조 구현 생성

4개 설계 산출물을 **실행 가능한 참조 구현**으로 통합한다. 목표는 완벽한 프로덕션 코드가 아니라 **정확한 골격 + 핵심 로직**이다.

## 언제 이 스킬을 쓰는가
설계가 합의된 뒤 실제 코드로 옮길 때. 참조 구현, 스캐폴딩, 핵심 알고리즘 예제.

## 구현 절차

1. **런타임 확정** — runtime-strategist 결정을 그대로 따른다(임의 변경 금지). 언어/프레임워크/라이브러리 고정.
2. **핵심 알고리즘 우선 구현** (완전 구현 대상):
   - `normalizeUrl(url)` — 소문자화, 기본포트/트래킹파라미터 제거, 쿼리 정렬, fragment 제거, punycode. → 캐시 key.
   - `safeFetch(url)` — 리다이렉트 따라가며 **홉마다 SSRF 검증**(DNS 해석 IP 검사), 본문 크기/타임아웃 제한, 최종 URL·redirect_chain 반환.
   - `extractOg(html, finalUrl)` — OG → Twitter Card → JSON-LD → HTML 기본 폴백, 상대 이미지 절대화, completeness 점수.
   - `fetchStrategy(url)` — static → oEmbed → headless 승격 (신호 기반).
   - `cacheKey` 2단계 — 정규화 URL→최종 URL 매핑, 최종 URL→payload.
3. **주변부 스텁** — API 라우트, 캐시 어댑터(Redis), 큐, 메트릭 계측 지점은 명확한 인터페이스 + 최소 구현 + `// TODO/EXTENSION` 주석.
4. **관측 내장** — 모든 크롤 경로에 error_code 분류와 메트릭 계측 훅.
5. **ADR + 실행 안내** — 주요 결정(런타임/DB/캐시 key/승격 조건)을 왜 그렇게 했는지 기록 + 실행 방법 최소 안내.

## 코드 품질 기준
- 자기완결·실행 가능해야 한다. 의사코드 금지, 실제 라이브러리 호출.
- 보안 기본값 내장: SSRF 가드, 본문 상한, 타임아웃, 스킴 허용목록.
- 설계 공백은 합리적 기본값 + `// ASSUMPTION:` 주석.
- 설계 간 모순은 임의 결정하지 말고 해당 설계자에게 질의(팀 모드) 또는 노트에 명시.

## 산출물 구조
```
_workspace/03_reference_implementation/
  ├─ (런타임에 맞는 프로젝트 구조)
  ├─ 핵심 모듈: url-normalize, safe-fetch, extract, strategy, cache-key
  ├─ API 엔트리포인트
  └─ 계측/설정
_workspace/03_implementation_notes.md   (ADR + 실행 안내 + 설계→코드 매핑)
```

## 원칙
- **선택된 런타임을 따른다.** 참조 구현은 설계의 충실한 반영이지 재설계가 아니다.
- **핵심 로직은 완전 구현, 주변부는 명확한 스텁.** 팀이 복사해 시작할 수 있어야 한다.
- **설계→코드 매핑을 남겨** 검증(design-integration-reviewer)을 쉽게 한다.
