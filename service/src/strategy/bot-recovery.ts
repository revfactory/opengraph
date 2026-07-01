/**
 * strategy/bot-recovery.ts — 봇 차단(403/challenge) 회복 래더의 순수 헬퍼
 *
 * 원본이 기본 UA를 봇으로 차단(HTTP_403 / BOT_CHALLENGE)했을 때의 전환 규칙:
 *   ① per-domain UA 오버라이드 재시도(프리뷰-봇 UA)  →  ② 헤드리스 전환  →  ③ 실패
 * 설계 근거: crawl §1.2.2(챌린지 마커) + reliability-ops §5-2/§5-3(패턴→규칙 레버).
 *
 * 이 파일은 순수 함수만 둔다(부수효과 없음). 실제 I/O 오케스트레이션은 orchestrator.ts.
 * 순수하므로 smoke 로 결정적 검증한다.
 */

import { CONFIG } from '../config.js';
import type { ErrorCode } from '../errors/taxonomy.js';

/** 봇 차단으로 판정되어 UA 오버라이드/헤드리스 전환이 유효한 에러인가. */
export function isBotBlock(code: ErrorCode): boolean {
  return code === 'HTTP_403' || code === 'BOT_CHALLENGE';
}

/**
 * 재시도할 프리뷰-봇 UA 후보 목록(순서 유지).
 * 이미 시도한 UA(기본 UA 또는 기존 rule.ua_override)는 제외해 무의미한 반복을 막는다.
 */
export function recoveryUaCandidates(alreadyTried: (string | null)[]): string[] {
  const tried = new Set(alreadyTried.filter((x): x is string => !!x));
  return CONFIG.RECOVERY_UAS.filter((ua) => !tried.has(ua));
}
