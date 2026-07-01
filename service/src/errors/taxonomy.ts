/**
 * errors/taxonomy.ts — 확정 에러 코드 Taxonomy (단일 진실)
 *
 * 출처: _workspace/02_integrated_architecture.md §1-1 [MISMATCH 해소] 확정본.
 *   - reliability-ops의 granular 집합을 단일 진실로 채택(운영 레버가 세분을 요구).
 *   - crawl-engine이 이 코드를 emit → reliability-ops가 이 코드로 집계/재시도 분기.
 *
 * 계약(§1-1):
 *   - error_class(transient/permanent/anti-bot)·stage·category는 failed_crawls에
 *     **별도 컬럼**으로 저장(문자열 파싱 금지) — SQL 집계 성능.
 *   - status ∈ {ok, partial, failed}, fetch_strategy ∈ {static, oembed, headless} 는 공유 enum.
 *
 * 이 파일이 crawl-engine·reliability-ops·구현이 **동일 문자열**을 쓰는 근거다(QA 검증 포인트 #1).
 */

/** 확정 에러 코드 enum (§1-1 표 그대로). `as const` 로 문자열 리터럴 유니온 확보. */
export const ERROR_CODES = [
  // parse / extract
  'NO_OG_TAGS',
  'PARSE_ERROR',
  'NON_HTML', // 구 crawl-engine UNSUPPORTED_CONTENT → 확정 NON_HTML
  // fetch / resource
  'EMPTY_BODY',
  'TOO_LARGE',
  // resolve / connect / network
  'DNS_FAIL',
  'CONN_TIMEOUT',
  'CONN_REFUSED',
  'READ_TIMEOUT',
  'TLS_ERROR',
  // http (4xx 세분 — 운영 레버가 다름)
  'HTTP_403', // 구 HTTP_401_403 → 확정 HTTP_403 (401은 HTTP_4XX_OTHER)
  'HTTP_404',
  'HTTP_410',
  'HTTP_429',
  'HTTP_4XX_OTHER', // 그 외 4xx 폴백(401 포함)
  'HTTP_5XX',
  // redirect (REDIRECT_LOOP 분리 확정)
  'TOO_MANY_REDIRECTS',
  'REDIRECT_LOOP',
  // render (headless)
  'JS_TIMEOUT',
  'RENDER_CRASH', // 구 RENDER_FAILED → 확정 RENDER_CRASH
  // anti-bot / provider
  'BOT_CHALLENGE',
  'OEMBED_FAILED',
  // security / policy (precheck)
  'SSRF_BLOCKED',
  'SCHEME_BLOCKED',
  'PORT_BLOCKED',
  'ROBOTS_DISALLOWED',
  'INVALID_URL',
  // fallback
  'UNKNOWN',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** 파생 컬럼용 enum (failed_crawls 별도 컬럼 — 문자열 파싱 금지, §1-1). */
export type ErrorClass = 'transient' | 'permanent' | 'anti-bot';
export type ErrorStage =
  | 'normalize'
  | 'precheck'
  | 'resolve'
  | 'connect'
  | 'fetch'
  | 'redirect'
  | 'parse'
  | 'oembed'
  | 'render'
  | 'any';
export type ErrorCategory =
  | 'extract'
  | 'network'
  | 'http'
  | 'redirect'
  | 'resource'
  | 'content'
  | 'headless'
  | 'anti-bot'
  | 'provider'
  | 'security'
  | 'policy'
  | 'input'
  | 'internal';

/** 재시도 정책 (reliability-ops §7.1 재시도표 편입). */
export interface RetryPolicy {
  /** 재시도 가치가 있는가. */
  retryable: boolean;
  /** 최대 재시도 횟수(초과 시 DLQ 또는 규칙 대상 큐). */
  maxRetries: number;
  /** 'conditional' = 규칙/신호에 따라 조건부(BOT_CHALLENGE). */
  conditional?: boolean;
  /** Retry-After 헤더 우선(HTTP_429). */
  respectRetryAfter?: boolean;
  note?: string;
}

export interface ErrorMeta {
  code: ErrorCode;
  errorClass: ErrorClass;
  stage: ErrorStage;
  category: ErrorCategory;
  retry: RetryPolicy;
  /** 승격해도 동일 실패 → 헤드리스로도 해결 불가(하드 에러). crawl §1.2 우선순위 3. */
  hardError: boolean;
  /** 사용자 노출용 짧은 설명. */
  clientFacing: string;
}

const NO_RETRY: RetryPolicy = { retryable: false, maxRetries: 0 };

/**
 * 코드 → 메타 매핑 (§1-1 확정표 + reliability-ops §1/§7.1 재시도 정책 편입).
 * SQL 집계는 이 파생 컬럼(errorClass/stage/category)을 직접 저장한다.
 */
export const ERROR_META: Record<ErrorCode, ErrorMeta> = {
  NO_OG_TAGS: {
    code: 'NO_OG_TAGS', errorClass: 'permanent', stage: 'parse', category: 'extract',
    retry: NO_RETRY, hardError: false,
    // *SPA 신호 시 헤드리스 승격(§1-1 각주). 승격 후에도 없으면 진짜 permanent.
    clientFacing: 'OG 메타 부재(부분 결과 가능)',
  },
  PARSE_ERROR: {
    code: 'PARSE_ERROR', errorClass: 'permanent', stage: 'parse', category: 'content',
    retry: NO_RETRY, hardError: false, clientFacing: 'HTML 파싱 실패',
  },
  NON_HTML: {
    code: 'NON_HTML', errorClass: 'permanent', stage: 'parse', category: 'content',
    retry: NO_RETRY, hardError: false, clientFacing: '비-HTML 콘텐츠(PDF/이미지 등)',
  },
  EMPTY_BODY: {
    code: 'EMPTY_BODY', errorClass: 'transient', stage: 'fetch', category: 'content',
    retry: { retryable: true, maxRetries: 1, note: '재시도 1회 → force-headless 승격' },
    hardError: false, clientFacing: '빈 응답 본문',
  },
  TOO_LARGE: {
    code: 'TOO_LARGE', errorClass: 'permanent', stage: 'fetch', category: 'resource',
    retry: NO_RETRY, hardError: true, clientFacing: '본문 크기 상한 초과',
  },
  DNS_FAIL: {
    code: 'DNS_FAIL', errorClass: 'permanent', stage: 'resolve', category: 'network',
    // §1-1 확정: permanent/no. (crawl 초안의 yes(백오프)는 ops 확정에 흡수됨)
    retry: { retryable: false, maxRetries: 0, note: '도메인 오타/소멸 — 1회 확인만' },
    hardError: true, clientFacing: '호스트 해석 실패',
  },
  CONN_TIMEOUT: {
    code: 'CONN_TIMEOUT', errorClass: 'transient', stage: 'connect', category: 'network',
    retry: { retryable: true, maxRetries: 2, note: '지수 백오프 + 지터' },
    hardError: true, clientFacing: '연결 타임아웃',
  },
  CONN_REFUSED: {
    code: 'CONN_REFUSED', errorClass: 'transient', stage: 'connect', category: 'network',
    retry: { retryable: true, maxRetries: 2, note: '제한적 재시도 — 반복 시 origin 다운 의심' },
    hardError: true, clientFacing: '연결 거부',
  },
  READ_TIMEOUT: {
    code: 'READ_TIMEOUT', errorClass: 'transient', stage: 'fetch', category: 'network',
    retry: { retryable: true, maxRetries: 2 },
    hardError: false, clientFacing: '본문 수신 타임아웃',
  },
  TLS_ERROR: {
    code: 'TLS_ERROR', errorClass: 'permanent', stage: 'connect', category: 'network',
    retry: NO_RETRY, hardError: true, clientFacing: 'TLS 핸드셰이크/인증서 실패',
  },
  HTTP_403: {
    code: 'HTTP_403', errorClass: 'permanent', stage: 'fetch', category: 'http',
    // permanent→규칙: UA 오버라이드/force-headless 로 성공 전환되는 대표 케이스(플라이휠 타깃).
    retry: { retryable: false, maxRetries: 0, note: '규칙(UA/헤드리스) 후 백필' },
    hardError: false, clientFacing: '접근 차단(403)',
  },
  HTTP_404: {
    code: 'HTTP_404', errorClass: 'permanent', stage: 'fetch', category: 'http',
    retry: NO_RETRY, hardError: false, clientFacing: '페이지 없음(404)',
  },
  HTTP_410: {
    code: 'HTTP_410', errorClass: 'permanent', stage: 'fetch', category: 'http',
    retry: NO_RETRY, hardError: false, clientFacing: '영구 삭제(410)',
  },
  HTTP_429: {
    code: 'HTTP_429', errorClass: 'transient', stage: 'fetch', category: 'http',
    retry: { retryable: true, maxRetries: 3, respectRetryAfter: true, note: 'Retry-After 우선 → rate_limit_rps 규칙' },
    hardError: false, clientFacing: '레이트리밋(429)',
  },
  HTTP_4XX_OTHER: {
    code: 'HTTP_4XX_OTHER', errorClass: 'permanent', stage: 'fetch', category: 'http',
    retry: NO_RETRY, hardError: false, clientFacing: '클라이언트 오류(4xx)',
  },
  HTTP_5XX: {
    code: 'HTTP_5XX', errorClass: 'transient', stage: 'fetch', category: 'http',
    retry: { retryable: true, maxRetries: 3, note: '지수 1s→4s→15s(±지터)' },
    hardError: false, clientFacing: '원본 서버 오류(5xx)',
  },
  TOO_MANY_REDIRECTS: {
    code: 'TOO_MANY_REDIRECTS', errorClass: 'permanent', stage: 'redirect', category: 'redirect',
    retry: NO_RETRY, hardError: true, clientFacing: '리다이렉트 홉 상한 초과',
  },
  REDIRECT_LOOP: {
    code: 'REDIRECT_LOOP', errorClass: 'permanent', stage: 'redirect', category: 'redirect',
    retry: NO_RETRY, hardError: true, clientFacing: '리다이렉트 순환',
  },
  JS_TIMEOUT: {
    code: 'JS_TIMEOUT', errorClass: 'transient', stage: 'render', category: 'headless',
    retry: { retryable: true, maxRetries: 1, note: 'wait_selector/render_timeout_ms 규칙' },
    hardError: false, clientFacing: '헤드리스 렌더 타임아웃',
  },
  RENDER_CRASH: {
    code: 'RENDER_CRASH', errorClass: 'transient', stage: 'render', category: 'headless',
    retry: { retryable: true, maxRetries: 1, note: '다른 워커/컨텍스트로 재시도' },
    hardError: false, clientFacing: '헤드리스 렌더 크래시',
  },
  BOT_CHALLENGE: {
    code: 'BOT_CHALLENGE', errorClass: 'anti-bot', stage: 'fetch', category: 'anti-bot',
    retry: { retryable: false, maxRetries: 1, conditional: true, note: 'allow_headless_on_challenge 정책 gated' },
    hardError: false, clientFacing: '봇 챌린지/인터스티셜',
  },
  OEMBED_FAILED: {
    code: 'OEMBED_FAILED', errorClass: 'transient', stage: 'oembed', category: 'provider',
    retry: { retryable: true, maxRetries: 1, note: '실패 시 헤드리스 낙하' },
    hardError: false, clientFacing: 'oEmbed 공급자 실패',
  },
  SSRF_BLOCKED: {
    code: 'SSRF_BLOCKED', errorClass: 'permanent', stage: 'precheck', category: 'security',
    retry: NO_RETRY, hardError: true, clientFacing: '차단된 대상(사설/메타데이터 IP)',
  },
  SCHEME_BLOCKED: {
    code: 'SCHEME_BLOCKED', errorClass: 'permanent', stage: 'precheck', category: 'security',
    retry: NO_RETRY, hardError: true, clientFacing: '비허용 스킴',
  },
  PORT_BLOCKED: {
    code: 'PORT_BLOCKED', errorClass: 'permanent', stage: 'precheck', category: 'security',
    retry: NO_RETRY, hardError: true, clientFacing: '비허용 포트',
  },
  ROBOTS_DISALLOWED: {
    code: 'ROBOTS_DISALLOWED', errorClass: 'permanent', stage: 'precheck', category: 'policy',
    retry: NO_RETRY, hardError: true, clientFacing: 'robots.txt 정책 위반',
  },
  INVALID_URL: {
    code: 'INVALID_URL', errorClass: 'permanent', stage: 'normalize', category: 'input',
    retry: NO_RETRY, hardError: true, clientFacing: '파싱 불가 URL',
  },
  UNKNOWN: {
    code: 'UNKNOWN', errorClass: 'permanent', stage: 'any', category: 'internal',
    retry: NO_RETRY, hardError: false, clientFacing: '미분류 오류(운영 알림)',
  },
};

/** HTTP status → 확정 에러 코드 (4xx 세분, §1-1). */
export function httpStatusToErrorCode(status: number): ErrorCode {
  if (status === 403) return 'HTTP_403';
  if (status === 404) return 'HTTP_404';
  if (status === 410) return 'HTTP_410';
  if (status === 429) return 'HTTP_429';
  if (status >= 400 && status < 500) return 'HTTP_4XX_OTHER'; // 401 포함
  if (status >= 500 && status < 600) return 'HTTP_5XX';
  return 'UNKNOWN';
}

/** 하드 에러 판정 — 승격(헤드리스)해도 동일 실패(crawl §1.2 우선순위 3). */
export function isHardError(code: ErrorCode): boolean {
  return ERROR_META[code].hardError;
}

export function retryPolicyOf(code: ErrorCode): RetryPolicy {
  return ERROR_META[code].retry;
}

/** taxonomy 위반 방지 — 임의 문자열이 확정 enum에 속하는지 런타임 가드. */
export function isKnownErrorCode(v: string): v is ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(v);
}

/**
 * 도메인 에러(내부 throw)를 확정 코드로 감싸는 표준 예외.
 * safe-fetch/ssrf-guard/extract 는 이 예외로 실패를 표현하고 orchestrator가 error_code로 흡수한다.
 */
export class CrawlError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus?: number;
  readonly cause?: unknown;
  constructor(code: ErrorCode, message?: string, opts?: { httpStatus?: number; cause?: unknown }) {
    super(message ?? ERROR_META[code].clientFacing);
    this.name = 'CrawlError';
    this.code = code;
    this.httpStatus = opts?.httpStatus;
    this.cause = opts?.cause;
  }
}
