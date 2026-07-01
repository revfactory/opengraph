/**
 * config.ts — 중앙 설정 (타임아웃/상한/임계/캐시 TTL/env)
 *
 * 기본값은 crawl-engine §4(안전성)·§3.2(임계)·platform §3-3(TTL) 확정값을 코드로 옮긴 것.
 * env 로 오버라이드 가능. ASSUMPTION 주석은 설계 공백에 대한 합리적 기본값 표기.
 */

function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function str(name: string, def: string): string {
  return process.env[name] ?? def;
}
function bool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return def;
  return v === '1' || v.toLowerCase() === 'true';
}

export const CONFIG = {
  // ── 정규화/키 스킴 버전 (platform §3-1: v1 → 규칙 변경 시 접두사 증가로 점진 이행) ──
  KEY_SCHEME_VERSION: 'v1',

  // ── 페치 상한/타임아웃 (crawl §4.2) ──
  MAX_BODY_BYTES: num('OG_MAX_BODY_BYTES', 2 * 1024 * 1024), // 2MB
  HEAD_ONLY_BYTES: num('OG_HEAD_ONLY_BYTES', 1 * 1024 * 1024), // static은 <head>만: 앞 1MB 우선
  CONNECT_TIMEOUT_MS: num('OG_CONNECT_TIMEOUT_MS', 3_000),
  TOTAL_TIMEOUT_MS: num('OG_TOTAL_TIMEOUT_MS', 8_000),
  HEADERS_TIMEOUT_MS: num('OG_HEADERS_TIMEOUT_MS', 5_000),
  MAX_REDIRECT_HOPS: num('OG_MAX_REDIRECT_HOPS', 10),
  META_REFRESH_MAX_DELAY: num('OG_META_REFRESH_MAX_DELAY', 5), // seconds

  // ── 포트/스킴 허용목록 (crawl §4.1) ──
  ALLOWED_SCHEMES: str('OG_ALLOWED_SCHEMES', 'http,https').split(','),
  ALLOWED_PORTS: str('OG_ALLOWED_PORTS', '80,443,8080,8443')
    .split(',')
    .map((p) => Number(p.trim()))
    .filter((p) => Number.isFinite(p)),

  // ── 헤드리스 (crawl §1.3) ──
  HEADLESS_NAV_TIMEOUT_MS: num('OG_HEADLESS_NAV_TIMEOUT_MS', 10_000),
  HEADLESS_SETTLE_MS: num('OG_HEADLESS_SETTLE_MS', 500),
  MAX_HEADLESS_CONCURRENCY: num('OG_MAX_HEADLESS_CONCURRENCY', 4),

  // ── 완성도 임계 (crawl §3.2 / §1-4 확정: ok ⟺ completeness ≥ 0.66) ──
  COMPLETE_THRESHOLD: num('OG_COMPLETE_THRESHOLD', 0.66),
  TITLE_MAX: 300,
  DESC_MAX: 500,

  // ── User-Agent / 헤더 기본값 (crawl §4.2) ──
  // ASSUMPTION: 봇 미리보기 관행에 맞춘 브라우저 UA. per-domain ua_override로 교체 가능.
  DEFAULT_UA: str(
    'OG_DEFAULT_UA',
    'Mozilla/5.0 (compatible; OGUnfurlBot/1.0; +https://example.svc/bot)',
  ),
  DEFAULT_ACCEPT_LANGUAGE: str('OG_ACCEPT_LANGUAGE', 'en,ko;q=0.8'),

  // ── 봇 차단(403/challenge) 회복 래더 (crawl §1.2.2 + reliability-ops §5-2/§5-3) ──
  // 원본이 기본 UA를 봇으로 차단(HTTP_403)하면 아래 프리뷰-봇 UA로 순차 재시도한 뒤,
  // 그래도 막히면 헤드리스로 전환한다. 성공 시 해당 도메인 규칙(ua_override/force_headless)을
  // 학습(hot-reload)하여 다음 요청부터는 처음부터 적용 → 실패율 감소 플라이휠의 자동화.
  BOT_RECOVERY_ENABLED: bool('OG_BOT_RECOVERY', true),
  // facebookexternalhit는 대다수 사이트가 링크 프리뷰용으로 화이트리스트한다(관행).
  RECOVERY_UAS: str(
    'OG_RECOVERY_UAS',
    [
      'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      'Twitterbot/1.0',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    ].join('|'),
  )
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean),

  // ── 캐시 TTL (platform §3-3) ──
  DEFAULT_TTL_SEC: num('OG_DEFAULT_TTL_SEC', 24 * 3600), // 전역 24h
  MIN_TTL_SEC: num('OG_MIN_TTL_SEC', 3600), // 부분 결과 짧게
  MAP_TTL_SEC: num('OG_MAP_TTL_SEC', 7 * 24 * 3600), // 매핑 거의 불변 → 7d
  SHORT_MAP_TTL_SEC: num('OG_SHORT_MAP_TTL_SEC', 30 * 24 * 3600), // short→final 30d
  NEG_TTL_4XX_SEC: num('OG_NEG_TTL_4XX_SEC', 30 * 60), // 4xx 30m
  NEG_TTL_5XX_SEC: num('OG_NEG_TTL_5XX_SEC', 5 * 60), // 5xx/timeout 5m
  SWR_WINDOW_RATIO: num('OG_SWR_WINDOW_RATIO', 0.2), // stale 허용 창 = TTL의 20%
  LOCK_TTL_SEC: num('OG_LOCK_TTL_SEC', 20), // single-flight 락
  L1_MAX_ENTRIES: num('OG_L1_MAX_ENTRIES', 5_000),
  L1_TTL_MS: num('OG_L1_TTL_MS', 30_000),

  // ── API 타임아웃 예산 (platform §2-3: 동기 경로 짧은 예산) ──
  SYNC_BUDGET_MS: num('OG_SYNC_BUDGET_MS', 3_000),

  // ── robots (crawl §4.2: 기본 respect, per-domain override) ──
  ROBOTS_DEFAULT_MODE: str('OG_ROBOTS_MODE', 'respect') as 'respect' | 'ignore',

  // ── 인프라 연결 (주변부: 스텁이 소비) ──
  REDIS_URL: str('OG_REDIS_URL', 'redis://127.0.0.1:6379'),
  POSTGRES_URL: str('OG_POSTGRES_URL', 'postgres://localhost:5432/ogsvc'),
  PORT: num('PORT', 8080),

  // ── 관측 ──
  METRICS_ENABLED: bool('OG_METRICS_ENABLED', true),
} as const;

/** HTML content-type 판정 (승격표 2번 / NON_HTML). */
export function isHtmlContentType(ct: string | null): boolean {
  if (!ct) return true; // ASSUMPTION: content-type 미상 → HTML로 낙관 처리(파서가 재판정)
  const t = ct.toLowerCase();
  return t.includes('text/html') || t.includes('application/xhtml+xml');
}
