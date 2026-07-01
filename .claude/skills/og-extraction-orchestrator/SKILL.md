---
name: og-extraction-orchestrator
description: "URL을 입력받아 Open Graph를 추출하는 기능의 설계·참조구현·운영 체계를 에이전트 팀으로 조율하는 오케스트레이터. 런타임 선택(node/python), 동적/리다이렉트/단축링크 크롤링, 실패 추적·실패율 감소, 캐싱 key·DB 선택·응답속도 아키텍처, 참조 구현, 통합 검증을 하나의 워크플로우로 엮는다. OG/오픈그래프/링크 미리보기/unfurl/메타데이터 추출 기능 개발 요청 시 반드시 이 스킬을 사용할 것. 후속 작업: OG 추출 설계 수정·부분 재실행·업데이트·보완·다시 실행·이전 결과 개선, '크롤러만 다시', '캐싱 전략만', '런타임 결정만' 류 요청에도 반드시 이 스킬을 사용."
---

# OG Extraction Orchestrator

URL → Open Graph 추출 기능의 **설계 + 참조 구현 + 운영 체계**를 에이전트 팀으로 산출하는 통합 스킬.

## 실행 모드: 하이브리드

| Phase | 모드 | 이유 |
|---|---|---|
| Phase 2 (설계 팬아웃) | 에이전트 팀 | 4개 설계 축이 서로 인터페이스를 규정 — 실시간 교차 조율이 품질을 올림 |
| Phase 3 (통합) | 리더(오케스트레이터) | 4개 산출물을 하나의 아키텍처로 수렴 |
| Phase 4 (구현) | 서브 에이전트 | 단독 생성 작업, 팀 통신 불필요 |
| Phase 5 (검증) | 서브 에이전트 | QA 1명이 경계면 교차 검증(생성-검증 쌍) |

> **팀 실행 실체:** `TeamCreate`가 가용하면 그대로 사용한다. 미가용 환경에서는 리더가 `Agent` 도구로 **이름 있는 백그라운드 에이전트**를 스폰하고(`run_in_background: true`), `SendMessage`로 조율하며, `TaskCreate/TaskUpdate`로 공유 작업 목록을 관리한다 — 동일한 팀 시맨틱.

## 에이전트 구성

| 팀원 | 에이전트 타입 | 고려사항 | 스킬 | 출력 |
|---|---|---|---|---|
| runtime-strategist | 커스텀 | ① 런타임 선택 | runtime-selection | `_workspace/01_runtime_strategist_decision.md` |
| crawl-engine-architect | 커스텀 | ③ 동적/리다이렉트/단축링크 | crawl-engine-design | `_workspace/01_crawl_engine_architect_design.md` |
| reliability-ops-engineer | 커스텀 | ② 실패추적/실패율감소 | crawl-reliability-ops | `_workspace/01_reliability_ops_engineer_design.md` |
| platform-architect | 커스텀 | ④ 캐싱key/DB/속도 | unfurl-platform-architecture | `_workspace/01_platform_architect_design.md` |
| implementation-engineer | 커스텀 | 참조 구현(생성) | og-reference-implementation | `_workspace/03_reference_implementation/` + `03_implementation_notes.md` |
| design-integration-reviewer | 커스텀(general-purpose 권한) | 경계면 검증 | design-integration-review | `_workspace/04_integration_review.md` |

**모든 Agent 호출에 `model: "opus"` 명시.**

## 워크플로우

### Phase 0: 컨텍스트 확인 (후속 작업 지원)
1. `_workspace/` 존재 여부 확인.
2. 실행 모드 결정:
   - **미존재** → 초기 실행. Phase 1로.
   - **존재 + 부분 수정 요청**(예: "크롤러만 다시", "캐싱 전략만") → **부분 재실행**. 해당 에이전트만 재호출, 이전 산출물 경로를 프롬프트에 포함하여 개선분만 덮어쓴다. 그 후 Phase 5(검증)만 재실행.
   - **존재 + 새 입력** → **새 실행**. 기존 `_workspace/`를 `_workspace_{YYYYMMDD_HHMMSS}/`로 이동 후 Phase 1.

### Phase 1: 준비
1. 사용자 입력 분석 — 대상 서비스 맥락(기존 스택/규모/제약)이 있으면 추출. 없으면 각 에이전트가 시나리오 분기하도록 표기.
2. `_workspace/` 및 `_workspace/00_input/` 생성, 요구사항·4개 고려사항을 저장.

### Phase 2: 설계 팬아웃 (에이전트 팀)
1. 팀 구성 — 4개 설계 에이전트를 opus로 스폰:
   ```
   TeamCreate(team_name: "og-extraction-team", members: [
     { name: "runtime-strategist",       agent_type: "runtime-strategist",       model: "opus", prompt: "runtime-selection 스킬로 런타임 결정..." },
     { name: "crawl-engine-architect",   agent_type: "crawl-engine-architect",   model: "opus", prompt: "crawl-engine-design 스킬로 페치 엔진 설계..." },
     { name: "reliability-ops-engineer", agent_type: "reliability-ops-engineer", model: "opus", prompt: "crawl-reliability-ops 스킬로 운영 체계 설계..." },
     { name: "platform-architect",       agent_type: "platform-architect",       model: "opus", prompt: "unfurl-platform-architecture 스킬로 아키텍처 설계..." }
   ])
   ```
   (TeamCreate 미가용 시: 위 4명을 `Agent(..., run_in_background: true, model: "opus")`로 병렬 스폰.)
2. 작업 등록:
   ```
   TaskCreate(tasks: [
     { title: "런타임 결정",   assignee: "runtime-strategist" },
     { title: "크롤 엔진 설계", assignee: "crawl-engine-architect" },
     { title: "운영 체계 설계", assignee: "reliability-ops-engineer" },
     { title: "아키텍처 설계",  assignee: "platform-architect" }
   ])
   ```
3. **팀 통신 규칙(경계면 조율):**
   - runtime-strategist → crawl-engine-architect: 사용 가능한 라이브러리 스택 공유
   - crawl-engine-architect ↔ reliability-ops-engineer: **에러 코드 taxonomy 단일 진실 합의**, per-domain 규칙 필드 합의
   - crawl-engine-architect → platform-architect: 페치 결과 스키마(정규화/최종/canonical URL) 공유 → 캐시 key 근거
   - reliability-ops-engineer → platform-architect: SQL 집계 요구 공유 → DB 선택 제약
   - 각 팀원은 완료 시 `_workspace/01_*` 저장 + 리더에게 알림
4. 리더는 유휴 알림/TaskGet으로 진행을 모니터링, 막힌 팀원은 SendMessage로 개입.

### Phase 3: 통합 (리더)
1. `_workspace/01_*` 4개 산출물을 Read.
2. 상충/경계면을 수렴하여 **통합 아키텍처 문서** 작성: `_workspace/02_integrated_architecture.md`
   - 4개 고려사항에 대한 최종 결정을 한 문서로 (런타임 / 크롤 엔진 / 운영 / 아키텍처).
   - 상충은 삭제하지 않고 출처 병기 + 리더 판단 근거.

### Phase 4: 참조 구현 (서브 에이전트 · 생성)
1. `Agent(name: "implementation-engineer", agent_type: "implementation-engineer", model: "opus", prompt: "01_* + 02_integrated 읽고 og-reference-implementation 스킬로 참조 구현 생성...")`
2. 출력: `_workspace/03_reference_implementation/` + `_workspace/03_implementation_notes.md`.

### Phase 5: 통합 검증 (서브 에이전트 · 검증, incremental)
1. `Agent(name: "design-integration-reviewer", agent_type: "design-integration-reviewer", model: "opus", prompt: "01_*/02_/03_ 읽고 design-integration-review 스킬로 경계면 교차 검증...")`
2. 출력: `_workspace/04_integration_review.md`.
3. MISMATCH/GAP 발견 시: 해당 에이전트를 부분 재실행(Phase 0의 부분 재실행 경로) → 재검증. 최대 2회.

### Phase 6: 최종 산출 & 정리
1. 통합 아키텍처 + 참조 구현 + 검증 결과를 사용자에게 요약 보고 (4개 고려사항별 결론).
2. 최종 산출물을 사용자 지정 경로(또는 프로젝트 루트)에 정리. `_workspace/` 보존.
3. Phase 7(피드백) 안내.

## 데이터 흐름
```
[00_input] → 4개 설계 에이전트(팀, 경계면 SendMessage 조율)
   → 01_runtime / 01_crawl_engine / 01_reliability / 01_platform
   → [리더 통합] 02_integrated_architecture
   → [implementation-engineer] 03_reference_implementation + notes
   → [design-integration-reviewer] 04_integration_review
   → (MISMATCH 시 부분 재실행) → 최종 보고
```

## 에러 핸들링
| 상황 | 전략 |
|---|---|
| 설계 에이전트 1명 실패 | 1회 재시도. 재실패 시 해당 고려사항 부분 누락 명시하고 진행 |
| 에러 taxonomy 불일치 | crawl-engine과 reliability-ops에 재합의 요청(경계면 #2). 미합의 시 양쪽 병기 |
| 캐시key ↔ 페치스키마 불일치 | design-integration-reviewer가 MISMATCH 보고 → 해당 에이전트 부분 재실행 |
| 구현이 설계와 불일치 | reviewer가 지목 → implementation-engineer 부분 재실행(최대 2회) |
| 과반 실패 | 사용자에게 알리고 진행 여부 확인 |
| 타임아웃 | 현재까지 산출물로 통합, 미완 영역 명시 |

## 테스트 시나리오

### 정상 흐름
1. 사용자가 "URL 입력 → OG 추출 기능 개발" + 4개 고려사항 제공.
2. Phase 1에서 요구사항 분해, `_workspace/` 생성.
3. Phase 2에서 4개 설계 에이전트가 팀으로 병렬 설계, 경계면 조율.
4. Phase 3에서 리더가 통합 아키텍처 도출.
5. Phase 4에서 참조 구현 생성, Phase 5에서 경계면 검증 PASS.
6. 예상 결과: `02_integrated_architecture.md` + `03_reference_implementation/` + `04_integration_review.md`.

### 에러 흐름
1. Phase 5에서 reviewer가 "에러코드 라벨 불일치(경계면 #2)" MISMATCH 보고.
2. 리더가 crawl-engine·reliability-ops를 부분 재실행하여 taxonomy 통일.
3. reviewer 재검증 → PASS.
4. 2회 후에도 잔여 MISMATCH면 최종 보고서에 명시하고 진행.

## 후속 작업
- 부분 재실행: "크롤러 설계만 다시", "캐싱 key 기준만 보완", "런타임을 Python 전제로 다시" → 해당 에이전트만 재호출(Phase 0).
- 각 에이전트는 이전 산출물이 있으면 읽고 피드백 반영분만 수정한다.
