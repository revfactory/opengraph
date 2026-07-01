# 요구사항: URL 입력 → Open Graph 추출 기능

## 기능 개요
서비스에서 사용자가 URL을 입력하면 해당 URL의 Open Graph 메타데이터를 추출하여 링크 미리보기(제목/설명/이미지 등)를 제공한다.

## 4개 고려사항 (반드시 다룰 것)
1. **런타임 선택 기준** — Node.js vs Python. 결정 근거와 매트릭스.
2. **운영/모니터링** — 크롤링 실패 시 실패된 링크를 어떻게 추적하고, 어떻게 실패율을 줄여 나가는가.
3. **정적이지 않은 링크 대응** — 동적(JS 렌더링) 링크, 리다이렉트되는 단축 링크(bit.ly 등).
4. **아키텍처/시스템 디자인** — 응답 속도 개선, 캐싱 key 기준, DB 선택 유무 및 선택 기준.

## 제약/맥락
- 조직 기존 스택/규모는 미지정 → 그린필드 가정 + 기존스택 존재 시 분기 병기.
- 산출물은 시니어 엔지니어가 곧바로 착수 가능한 수준의 설계 + 참조 구현.

## 경계면 계약 (에이전트 간 정합 필수)
- 에러 코드 taxonomy는 crawl-engine ↔ reliability-ops 단일 진실.
- 페치 결과 스키마(normalized_url/final_url/canonical_url/redirect_chain/fetch_strategy/error_code)는 crawl-engine이 정의, platform-architect(캐시 key)·reliability-ops(추적)가 소비.
- reliability-ops의 SQL 집계 요구는 platform-architect의 DB 선택 제약.
- runtime-strategist의 언어 결정은 crawl-engine 라이브러리 가정·implementation 언어의 전제.
