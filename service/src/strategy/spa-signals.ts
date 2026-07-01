/**
 * strategy/spa-signals.ts — 승격 신호 감지 (crawl §1.2.1 / §2.3 / §1.2.2)
 *
 * 순수 함수 모음. static 본문(문자열)만 보고 헤드리스 승격 신호를 판정한다.
 *   - detectSpaShell:  <head>가 빈약한 SPA 셸인가 (가중 점수)
 *   - detectJsRedirect: 사실상 JS 리다이렉트 셸인가
 *   - detectChallenge:  Cloudflare 류 봇 인터스티셜인가
 *   - parseMetaRefresh: <meta http-equiv=refresh content="0;url=..."> 소프트 리다이렉트
 */

export interface SpaShellSignal {
  isSpaShell: boolean;
  score: number;
  reasons: string[];
}

/** crawl §1.2.1 SPA 셸 신호(가중 합산). 임계 초과면 SPA로 판정. */
export function detectSpaShell(html: string, hasOgOrTitle: boolean): SpaShellSignal {
  const reasons: string[] = [];
  let score = 0;

  const headMatch = html.match(/<head[\s\S]*?<\/head>/i);
  const head = headMatch ? headMatch[0] : html.slice(0, 4096);
  const metaCount = (head.match(/<meta\b/gi) ?? []).length;
  if (metaCount <= 3) {
    score += 0.4;
    reasons.push(`sparse <head> (meta=${metaCount})`);
  }

  const genericTitle = /<title>\s*(loading|please wait|\s*)\s*<\/title>/i.test(html);
  if (!hasOgOrTitle || genericTitle) {
    score += 0.3;
    reasons.push('no OG/twitter/jsonld + generic/absent <title>');
  }

  // 앱 마운트 루트 존재
  if (
    /<div[^>]+id=["'](root|app|__next|__nuxt)["']/i.test(html) ||
    /\bng-app\b|\bdata-reactroot\b/i.test(html)
  ) {
    score += 0.2;
    reasons.push('app mount root present');
  }

  // 본문<번들: script 바이트 비율이 매우 높음
  const scriptBytes = [...html.matchAll(/<script[\s\S]*?<\/script>/gi)].reduce(
    (a, m) => a + m[0].length,
    0,
  );
  const bodyText = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .trim();
  if (html.length > 0 && scriptBytes / html.length > 0.6 && bodyText.length < 400) {
    score += 0.2;
    reasons.push('script bytes >> visible body');
  }

  // 하이드레이션 페이로드는 오히려 static 추출 가능 신호 → SPA 점수 감점
  if (/__NEXT_DATA__|__NUXT__|window\.__INITIAL_STATE__/.test(html)) {
    score -= 0.3;
    reasons.push('hydration payload present (static-extractable, -)');
  }

  return { isSpaShell: score >= 0.6, score: Math.max(0, score), reasons };
}

/** crawl §2.3 JS 리다이렉트 감지 — static 본문이 사실상 리다이렉트 셸인가. */
export function detectJsRedirect(html: string): boolean {
  const patterns = [
    /location\.href\s*=/i,
    /location\.replace\s*\(/i,
    /location\.assign\s*\(/i,
    /window\.location\s*=/i,
    /top\.location\s*=/i,
    /document\.location\s*=/i,
  ];
  const hasPattern = patterns.some((p) => p.test(html));
  if (!hasPattern) return false;

  // 가시 텍스트가 매우 짧으면(리다이렉트 셸) 신호 강화
  const visible = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .trim();
  return visible.length < 200;
}

/** crawl §1.2.2 챌린지/인터스티셜 마커. */
export function detectChallenge(html: string, serverHeader: string | null): boolean {
  const cf = (serverHeader ?? '').toLowerCase().includes('cloudflare');
  const markers = [
    /just a moment/i,
    /cf-chl-/i,
    /__cf_chl/i,
    /attention required/i,
    /checking your browser/i,
  ];
  const hasMarker = markers.some((m) => m.test(html));
  return (cf && hasMarker) || hasMarker;
}

export interface MetaRefresh {
  url: string;
  delay: number;
}
/** <meta http-equiv="refresh" content="0;url=..."> 파싱. 없으면 null. */
export function parseMetaRefresh(html: string): MetaRefresh | null {
  const m = html.match(
    /<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["']?\s*(\d+)\s*;\s*url=([^"'>\s]+)/i,
  );
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  return { delay: Number(m[1]), url: m[2] };
}

/** 페이지가 리다이렉트 셸처럼 보이는가(본문이 사실상 비어있음). meta-refresh 추종 가드. */
export function looksLikeRedirectShell(html: string): boolean {
  const visible = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .trim();
  return visible.length < 512;
}
