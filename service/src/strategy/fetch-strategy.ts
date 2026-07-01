/**
 * strategy/fetch-strategy.ts — 승격 판단 (crawl §1.2, 신호 기반)
 *
 * 비용 순 승격: static → oEmbed → headless. "일단 헤드리스" 금지(불변식 2).
 * escalation_decision(result, static, rule) → DONE | OEMBED | HEADLESS.
 * 우선순위 표(crawl §1.2)를 그대로 코드로 옮겼다. QA는 이 표와 대조한다.
 */

import { CONFIG } from '../config.js';
import { isHardError, type ErrorCode } from '../errors/taxonomy.js';
import type { DomainRule } from '../rules/domain-rules.js';
import type { StaticFetchResult } from '../types.js';
import { detectChallenge, detectSpaShell } from './spa-signals.js';

export type EscalationDecision = 'DONE' | 'OEMBED' | 'HEADLESS';

export interface EscalationInput {
  completeness: number;
  contentIsHtml: boolean;
  hasMeta: boolean; // false → NO_OG_TAGS
  staticResult: StaticFetchResult;
  rule: DomainRule;
  /** static 단계에서 발생한 비치명 에러(있으면). */
  softError?: ErrorCode;
}

export interface EscalationResult {
  decision: EscalationDecision;
  reason: string;
  /** OEMBED 결정 시 사용할 엔드포인트(있으면). */
  oembedEndpoint?: string;
}

/** known oEmbed providers (crawl §1.2 우선순위 5). host(eTLD+1 또는 정확) → 엔드포인트. */
export const OEMBED_PROVIDERS: Record<string, string> = {
  'twitter.com': 'https://publish.twitter.com/oembed',
  'x.com': 'https://publish.twitter.com/oembed',
  'youtube.com': 'https://www.youtube.com/oembed',
  'youtu.be': 'https://www.youtube.com/oembed',
  'vimeo.com': 'https://vimeo.com/api/oembed.json',
  'flickr.com': 'https://www.flickr.com/services/oembed/',
  'soundcloud.com': 'https://soundcloud.com/oembed',
  'tiktok.com': 'https://www.tiktok.com/oembed',
  'spotify.com': 'https://open.spotify.com/oembed',
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/** host → 등록 provider 엔드포인트(정확 → 부모 도메인). */
export function resolveOembedEndpoint(url: string, rule: DomainRule): string | null {
  if (rule.oembed_endpoint) return rule.oembed_endpoint; // 규칙이 최우선(discovery 생략)
  const host = hostOf(url);
  if (OEMBED_PROVIDERS[host]) return OEMBED_PROVIDERS[host]!;
  const labels = host.split('.');
  for (let i = 1; i < labels.length - 1; i++) {
    const parent = labels.slice(i).join('.');
    if (OEMBED_PROVIDERS[parent]) return OEMBED_PROVIDERS[parent]!;
  }
  return null;
}

/**
 * escalation_decision — crawl §1.2 우선순위 표.
 * 이 함수는 순수(부수효과 없음): static 성공 후 파싱 결과·규칙·신호만 본다.
 */
export function decideEscalation(input: EscalationInput): EscalationResult {
  const { completeness, contentIsHtml, hasMeta, staticResult, rule } = input;

  // 1. 이미 충분
  if (completeness >= CONFIG.COMPLETE_THRESHOLD) {
    return { decision: 'DONE', reason: `completeness ${completeness} ≥ ${CONFIG.COMPLETE_THRESHOLD}` };
  }

  // 2. 비-HTML → 헤드리스로도 OG 안 나옴(§3.3에서 최소 카드 처리)
  if (!contentIsHtml) {
    return { decision: 'DONE', reason: 'non-HTML content-type' };
  }

  // 3. 하드에러 → 렌더링해도 동일 실패(방어적; 보통 safeFetch가 이미 throw)
  if (input.softError && isHardError(input.softError)) {
    return { decision: 'DONE', reason: `hard error ${input.softError}` };
  }

  // 4. force_headless 도메인
  if (rule.force_headless) {
    return { decision: 'HEADLESS', reason: 'rule.force_headless' };
  }

  // 5. known oEmbed provider
  const endpoint = resolveOembedEndpoint(staticResult.final_url, rule);
  if (endpoint) {
    return { decision: 'OEMBED', reason: 'known oEmbed provider', oembedEndpoint: endpoint };
  }

  // 6. NO_OG_TAGS + HTML + SPA 셸 신호
  if (!hasMeta) {
    const spa = detectSpaShell(staticResult.body, hasMeta);
    if (spa.isSpaShell) {
      return { decision: 'HEADLESS', reason: `SPA shell (${spa.reasons.join(', ')})` };
    }
    // 7. NO_OG_TAGS + HTML + JS 리다이렉트 신호
    if (staticResult.js_redirect_signal) {
      return { decision: 'HEADLESS', reason: 'JS redirect shell' };
    }
  }

  // 8. 챌린지 마커 + 정책 허용
  if (rule.allow_headless_on_challenge) {
    const server = null; // server 헤더는 staticResult에 없음 — body 마커로 판정(보수적)
    if (detectChallenge(staticResult.body, server)) {
      return { decision: 'HEADLESS', reason: 'bot challenge (policy-gated)' };
    }
  }

  // else: 부분 결과라도 확정(헤드리스 남발 금지)
  return { decision: 'DONE', reason: 'partial result accepted (no headless signal)' };
}

/** oEmbed 실패 후 헤드리스 재평가(crawl §1.1 should_headless_after_oembed). */
export function shouldHeadlessAfterOembed(completeness: number, rule: DomainRule): boolean {
  if (rule.force_headless) return true;
  return completeness < CONFIG.COMPLETE_THRESHOLD;
}
