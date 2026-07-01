/**
 * url/domain.ts — eTLD+1 추출 (reliability-ops 집계 축 `domain`)
 *
 * failed_crawls.domain = final_url 기준 eTLD+1 (reliability-ops §2.1). 이 값이 플라이휠
 * GROUP BY 의 축이다. 정확한 eTLD+1 은 Public Suffix List 가 필요 — 프로덕션은 `tldts`
 * 사용을 권고(EXTENSION). 여기선 다단계 TLD 소집합을 처리하는 경량 근사 구현.
 */

// 흔한 다단계 퍼블릭 서픽스 소집합(근사). 프로덕션은 전체 PSL 사용.
const MULTI_LEVEL_SUFFIXES: ReadonlySet<string> = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
  'co.kr', 'or.kr', 'go.kr', 'ne.kr', 'pe.kr', 're.kr',
  'co.jp', 'or.jp', 'ne.jp', 'go.jp',
  'com.au', 'net.au', 'org.au',
  'com.br', 'com.cn', 'com.tw', 'co.in', 'co.nz', 'com.mx',
]);

/** host → eTLD+1(registrable domain). 실패 시 host 그대로. */
export function registrableDomain(host: string): string {
  const h = host.replace(/\.+$/, '').toLowerCase();
  const labels = h.split('.');
  if (labels.length <= 2) return h;

  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_LEVEL_SUFFIXES.has(lastTwo)) {
    return labels.slice(-3).join('.');
  }
  return labels.slice(-2).join('.');
}

/** URL 문자열 → eTLD+1. 파싱 실패 시 빈 문자열. */
export function domainOf(url: string): string {
  try {
    return registrableDomain(new URL(url).hostname);
  } catch {
    return '';
  }
}
