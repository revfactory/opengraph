/**
 * url/normalize.ts — 공유 normalize_url (단일 구현, §1-3 정본)
 *
 * 출처: platform §3-1 8단계 + crawl §2.4. 통합 §1-3 확정:
 *   - platform §3-1의 8단계 규칙(버전 v1)을 정본으로 하고 crawl-engine이 동일 구현으로
 *     normalized_url을 채운다.
 *   - 유일한 미세 차이(hashbang `#!` 보존)는 **보존으로 통일**(구형 AJAX 크롤 스킴).
 *   - 정규화가 양측에서 갈리면 캐시 히트가 깨지므로 **공유 라이브러리 1개**로 강제.
 *
 * 계약: 순수·결정적(부수효과 없음). 동일 의미 URL → 동일 문자열.
 * 이 함수를 API 티어·크롤 워커·crawl-engine이 동일하게 사용한다(QA 검증 포인트 #3).
 *
 * 라이브러리: WHATWG URL(Node 내장)을 1차 파서로 사용(host 소문자·punycode·퍼센트 정규화·
 * dot-segment 해소를 표준 규격대로 수행). 그 위에 트래킹 제거·쿼리 정렬·fragment 정책을 얹는다.
 * (runtime-strategist §(b): 내장 URL + normalize-url 전제. 여기선 결정적 제어를 위해 직접 구현.)
 */

import { CONFIG } from '../config.js';
import { CrawlError } from '../errors/taxonomy.js';
import { isTrackingParam } from './tracking-params.js';

/** 정규화 규칙 버전 — 캐시 key 접두사(platform §3-1)와 동일 개념. 규칙 변경 시 증가. */
export const NORMALIZE_VERSION = 'v1';

/**
 * normalize_url — 8단계 결정적 정규화.
 * @throws {CrawlError} INVALID_URL — 파싱 불가/비지원 스킴 형태.
 */
export function normalizeUrl(raw: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new CrawlError('INVALID_URL', 'empty url');
  }

  let u: URL;
  try {
    // WHATWG URL: (1) scheme·host 소문자, (7) IDN→punycode·퍼센트 대문자 정규화,
    //             (6) 경로 dot-segment(./..) 해소 를 규격대로 수행한다.
    u = new URL(raw.trim());
  } catch {
    throw new CrawlError('INVALID_URL', `unparseable url: ${raw.slice(0, 120)}`);
  }

  // 스킴은 정규화 결과 문자열에 소문자로 반영됨(WHATWG). http/https 외 스킴도 정규화는 하되
  // 캐시 key로만 쓰인다 — 실제 스킴 차단은 ssrf-guard(SCHEME_BLOCKED)가 담당.
  const scheme = u.protocol.replace(/:$/, ''); // 'http'

  // (1보강) host 소문자 + 트레일링 닷 제거. WHATWG는 host를 소문자화하지만 트레일링 닷은 보존한다.
  let host = u.hostname.replace(/\.+$/, '');

  // (2) 기본 포트 제거. WHATWG는 :80/:443을 이미 빈 포트로 정규화한다. 비표준 포트만 남는다.
  const port = u.port; // '' 이면 기본 포트

  // ── (4) 트래킹 파라미터 제거 + (5) 쿼리 키 정렬 ──
  const params = [...u.searchParams.entries()].filter(([k]) => !isTrackingParam(k));
  // 키 기준 안정 정렬(값 보존, 동일 키의 상대 순서 유지).
  params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const sp = new URLSearchParams();
  for (const [k, v] of params) sp.append(k, v);
  let query = sp.toString(); // 퍼센트 인코딩 정규화됨
  // (5) 빈 쿼리 `?` 제거는 query === '' 로 자연 처리.

  // ── (6) 경로 정규화: 중복 슬래시 정리. dot-segment는 WHATWG가 이미 해소. ──
  // ASSUMPTION: 중복 슬래시 병합은 platform §3-1(6) "중복 슬래시 정리" 지시를 따름.
  //   trailing slash는 **보존**(오탐 병합 위험 회피 — §3-1(8) 정신과 동일). 루트 '/'는 유지.
  let path = u.pathname.replace(/\/{2,}/g, '/');
  if (path === '') path = '/';

  // ── (3) fragment 정책: 일반 fragment 제거, `#!` hashbang은 보존(§1-3 확정). ──
  let hash = '';
  if (u.hash.startsWith('#!')) {
    hash = u.hash; // hashbang 보존(구형 AJAX 크롤 스킴)
  }

  // (8) 기본 index.html 등 default doc 제거는 하지 않음(오탐 위험, platform §3-1(8)).

  // ── 재조립 (userinfo는 제외) ──
  // ASSUMPTION: userinfo(user:pass@)는 캐시 key·SSRF 관점에서 제외한다. 자격증명은 key에 부적합.
  const authority = port ? `${host}:${port}` : host;
  let out = `${scheme}://${authority}${path}`;
  if (query) out += `?${query}`;
  if (hash) out += hash;
  return out;
}

/**
 * 리다이렉트 루프 감지용 경량 정규화(crawl §2.1 canonicalize_for_loopcheck).
 * fragment 제거 + host 소문자 만 — 전체 normalize보다 싸고, 루프 판정에 충분.
 */
export function canonicalizeForLoopCheck(u: string): string {
  try {
    const url = new URL(u);
    url.hash = '';
    return `${url.protocol}//${url.hostname.toLowerCase()}${url.port ? ':' + url.port : ''}${url.pathname}${url.search}`;
  } catch {
    return u;
  }
}

/**
 * 상대/프로토콜-상대 URL을 base 기준 절대화(crawl §2.1 absolutize, §3.1 og:image 절대화).
 * 실패 시 원본 반환(호출부가 유효성 판단).
 */
export function absolutize(ref: string, base: string): string {
  try {
    return new URL(ref, base).toString();
  } catch {
    return ref;
  }
}

// 규칙 버전 핀(참조용) — CONFIG.KEY_SCHEME_VERSION 과 정합 유지.
export const _versionCheck = NORMALIZE_VERSION === CONFIG.KEY_SCHEME_VERSION;
