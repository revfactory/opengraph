/**
 * test/integration.test.ts — 최소 e2e 통합 테스트 (node:test)
 *
 * 실행: npm run test:integration   (tsx test/integration.test.ts)
 *
 * 검증 시나리오:
 *   1. 백엔드 선택 로그 — REDIS_URL/DATABASE_URL 유무로 redis/pg vs 인메모리(항상 성립).
 *   2. SSRF 차단 — http://169.254.169.254 → error.code=SSRF_BLOCKED (네트워크 불필요, 항상 실행).
 *   3. 정상 추출 — 실제 URL 에서 카드 반환(네트워크 필요 → 오프라인이면 skip).
 *   4. 캐시 히트 — 같은 URL 2회 → 2번째 x-cache=hit (네트워크 필요 → skip 가능).
 *   5. 단축링크/리다이렉트 해석 — http→https 리다이렉트 추적 후 final_url=https (네트워크 필요 → skip).
 *
 * "실 의존성 없으면 skip": Redis/Postgres 는 팩토리가 인메모리로 graceful fallback 하고,
 *   외부 네트워크가 필요한 케이스만 probe 결과에 따라 skip 한다. 실 의존성이 있으면 실제로 관통한다.
 *
 * env(config.ts 는 import 시점에 읽으므로 앱 모듈은 전부 동적 import 로 로드해 아래 값이 반영되게 함):
 */
process.env.OG_SYNC_BUDGET_MS ??= '20000'; // 동기 예산 넉넉히(네트워크 왕복 202 승격 방지)
process.env.OG_TOTAL_TIMEOUT_MS ??= '15000';
process.env.OG_HEADERS_TIMEOUT_MS ??= '12000';
process.env.OG_CONNECT_TIMEOUT_MS ??= '5000';

import { after, before, describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';

const NORMAL_URL = process.env.INTEGRATION_TARGET_URL ?? 'https://example.com/';
// http→https 301 리다이렉트가 안정적인 대상(단축링크와 동일한 redirect+final-URL 기계를 관통).
const REDIRECT_URL = process.env.INTEGRATION_REDIRECT_URL ?? 'http://github.com/';

/** 네트워크 계층 에러(대상 도달 실패) — 이 코드면 테스트 실패가 아니라 skip 로 처리. */
const NETWORK_ERRORS = new Set(['DNS_FAIL', 'CONN_TIMEOUT', 'CONN_REFUSED', 'READ_TIMEOUT', 'TLS_ERROR', 'UNKNOWN']);

async function probeNet(): Promise<boolean> {
  if (process.env.INTEGRATION_SKIP_NET === '1') return false; // CI/오프라인 강제 skip 훅
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 4000);
    const res = await fetch('https://example.com/', { method: 'HEAD', signal: ac.signal });
    clearTimeout(t);
    return res.status < 500;
  } catch {
    return false;
  }
}

interface Ctx {
  app: Awaited<ReturnType<typeof import('../src/api/server.js')['buildServer']>>;
  cache: import('../src/cache/unfurl-cache.js').UnfurlCache;
  cacheKind: string;
  persistenceKind: string;
  close(): Promise<void>;
}

async function buildCtx(): Promise<Ctx> {
  const { buildServer } = await import('../src/api/server.js');
  const { UnfurlCache } = await import('../src/cache/unfurl-cache.js');
  const { createCacheClient } = await import('../src/cache/redis-store.js');
  const { createPersistence } = await import('../src/persistence/pg-store.js');
  const { NoopMetrics } = await import('../src/metrics/instrumentation.js');
  const { DomainRuleStore } = await import('../src/rules/domain-rules.js');
  const { headlessRenderer } = await import('../src/strategy/headless.js');

  const cacheHandle = await createCacheClient();
  const persistence = await createPersistence();
  const cache = new UnfurlCache({
    redis: cacheHandle.client,
    metrics: new NoopMetrics(),
    store: persistence.store,
    rules: new DomainRuleStore(persistence.ruleProvider),
    renderer: headlessRenderer,
    workerId: 'w-int-test',
  });
  const app = buildServer({ cache });
  await app.ready();
  return {
    app,
    cache,
    cacheKind: cacheHandle.kind,
    persistenceKind: persistence.kind,
    close: async () => {
      await app.close().catch(() => {});
      await headlessRenderer.close().catch(() => {});
      await cacheHandle.close().catch(() => {});
      await persistence.close().catch(() => {});
    },
  };
}

describe('OG unfurl — 통합 e2e', () => {
  let ctx: Ctx;
  let liveNet = false;

  before(async () => {
    liveNet = await probeNet();
    ctx = await buildCtx();
    // eslint-disable-next-line no-console
    console.log(
      `[integration] backends: cache=${ctx.cacheKind}, persistence=${ctx.persistenceKind}, liveNet=${liveNet}`,
    );
  });

  after(async () => {
    if (ctx) await ctx.close();
  });

  it('백엔드 선택이 결정됨(redis|memory / postgres|memory)', () => {
    assert.ok(['redis', 'memory'].includes(ctx.cacheKind));
    assert.ok(['postgres', 'memory'].includes(ctx.persistenceKind));
  });

  it('SSRF 차단: http://169.254.169.254 → SSRF_BLOCKED', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/unfurl',
      query: { url: 'http://169.254.169.254/latest/meta-data/' },
    });
    const body = res.json() as { data: unknown; error: { code: string } | null };
    assert.equal(body.data, null);
    assert.equal(body.error?.code, 'SSRF_BLOCKED');
  });

  it('정상 추출: 실제 URL 에서 카드 반환', async (t: TestContext) => {
    if (!liveNet) return t.skip('오프라인 — 네트워크 케이스 skip');
    const res = await ctx.app.inject({ method: 'GET', url: '/unfurl', query: { url: NORMAL_URL } });
    const body = res.json() as { data: { title: string | null } | null; meta: unknown; error: { code: string } | null };
    if (body.error && NETWORK_ERRORS.has(body.error.code)) return t.skip(`일시 네트워크: ${body.error.code}`);
    assert.equal(res.statusCode, 200);
    assert.ok(body.data, 'data 존재');
    assert.ok(body.data.title, 'title 존재');
    assert.ok(body.meta, 'meta 존재');
  });

  it('캐시 히트: 동일 URL 2회 → 2번째 x-cache=hit', async (t: TestContext) => {
    if (!liveNet) return t.skip('오프라인 — 네트워크 케이스 skip');
    const first = await ctx.app.inject({ method: 'GET', url: '/unfurl', query: { url: NORMAL_URL } });
    const fb = first.json() as { error: { code: string } | null };
    if (fb.error && NETWORK_ERRORS.has(fb.error.code)) return t.skip(`일시 네트워크: ${fb.error.code}`);
    const second = await ctx.app.inject({ method: 'GET', url: '/unfurl', query: { url: NORMAL_URL } });
    const sb = second.json() as { meta: { cache: string } | null };
    assert.equal(second.headers['x-cache'], 'hit');
    assert.equal(sb.meta?.cache, 'hit');
  });

  it('리다이렉트/단축링크 해석: http→https 추적 후 final_url=https', async (t: TestContext) => {
    if (!liveNet) return t.skip('오프라인 — 네트워크 케이스 skip');
    // 봇 챌린지/404 등으로 status=failed 여도 redirect_chain·final_url 은 이미 확정되므로
    // 엔벨로프 대신 FetchResult 를 직접 검사(리다이렉트 기계 자체를 검증).
    const { result } = await ctx.cache.getUnfurl(REDIRECT_URL, { refresh: true });
    if (result.error_code && NETWORK_ERRORS.has(result.error_code)) return t.skip(`일시 네트워크: ${result.error_code}`);
    assert.ok(result.redirect_chain.length >= 1, '리다이렉트 홉 1개 이상 기록');
    assert.match(result.final_url, /^https:\/\//, 'final_url 은 https 종점');
    assert.notEqual(result.final_url, REDIRECT_URL, 'final_url 이 입력과 달라짐(리다이렉트 해석됨)');
  });
});

/**
 * 봇 차단(HTTP_403) 회복 래더 — 네트워크 불필요(staticFetch/precheck 주입으로 결정적).
 * 원본이 기본 UA를 403으로 막고 프리뷰-봇 UA만 허용하는 상황을 모사한다.
 */
describe('봇 차단 회복: per-domain UA 오버라이드 전환 + 규칙 학습', () => {
  it('403 → 프리뷰-봇 UA 재시도로 통과 + recovery.via=ua_override + 도메인 규칙 학습', async () => {
    const { fetchOg } = await import('../src/orchestrator.js');
    const { DomainRuleStore, StaticSeedRuleProvider } = await import('../src/rules/domain-rules.js');
    const { CrawlError } = await import('../src/errors/taxonomy.js');
    const { CONFIG } = await import('../src/config.js');
    const OG_HTML =
      '<html><head><meta property="og:title" content="Unblocked"><meta property="og:description" content="d"><meta property="og:image" content="https://cdn.x/i.png"></head></html>';

    // 기본/미지정 UA → 403, 회복 UA(RECOVERY_UAS) → 200.
    let botBlockedAttempts = 0;
    const fakeStaticFetch = (async (url: string, rule: { ua_override: string | null }) => {
      const ua = rule.ua_override ?? CONFIG.DEFAULT_UA;
      if (CONFIG.RECOVERY_UAS.includes(ua)) {
        return {
          final_url: url, redirect_chain: [], http_status: 200, content_type: 'text/html',
          charset: 'utf-8', body: OG_HTML, body_bytes: OG_HTML.length,
          js_redirect_signal: false, pinned_ip: '93.184.216.34', followed_meta_refresh: false,
        };
      }
      botBlockedAttempts += 1;
      throw new CrawlError('HTTP_403', 'blocked bot UA', { httpStatus: 403 });
    }) as unknown as typeof import('../src/fetch/safe-fetch.js')['safeFetch'];

    const fakePrecheck = (async () => ({ blocked: false, pinnedIp: '93.184.216.34', ipFamily: 4 as const })) as unknown as typeof import('../src/fetch/ssrf-guard.js')['ssrfPrecheck'];

    const rules = new DomainRuleStore(new StaticSeedRuleProvider([]));

    // 1차: 403 → UA 오버라이드 회복
    const r1 = await fetchOg('https://walled.example.com/post', {
      rules, staticFetch: fakeStaticFetch, precheck: fakePrecheck,
    });
    assert.equal(r1.status, 'ok', 'UA 회복으로 성공');
    assert.equal(r1.og.title, 'Unblocked');
    assert.ok(r1.recovery, 'recovery 기록 존재');
    assert.equal(r1.recovery?.via, 'ua_override');
    assert.ok(CONFIG.RECOVERY_UAS.includes(r1.recovery!.ua!), '회복 UA가 프리뷰-봇 UA');
    assert.equal(r1.recovery?.learned, true, '규칙 학습됨');
    assert.ok(botBlockedAttempts >= 1, '기본 UA 최소 1회 차단됨');

    // 규칙이 학습되어 다음 resolve 부터 ua_override 가 처음부터 적용된다(플라이휠 폐곡선).
    const learned = await rules.resolve('walled.example.com');
    assert.ok(CONFIG.RECOVERY_UAS.includes(learned.ua_override ?? ''), '학습된 ua_override 적용');

    // 2차: 학습된 규칙으로 처음부터 회복 UA 사용 → 차단 카운트 증가 없이 성공.
    const before = botBlockedAttempts;
    const r2 = await fetchOg('https://walled.example.com/post2', {
      rules, staticFetch: fakeStaticFetch, precheck: fakePrecheck,
    });
    assert.equal(r2.status, 'ok');
    assert.equal(r2.recovery, undefined, '2차는 회복 불필요(처음부터 규칙 적용)');
    assert.equal(botBlockedAttempts, before, '2차엔 기본 UA 차단이 발생하지 않음');
  });
});
