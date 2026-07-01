/**
 * netlify/functions/api.mts — Netlify Function(v2) 로 /unfurl · /healthz 서빙
 *
 * Netlify Functions 는 AWS Lambda(=진짜 Node.js) 위에서 돌므로 Fastify 서버와 "동일한
 * 서비스 코드"를 재사용한다(undici IP핀 SSRF·cheerio·zlib 그대로 동작). 정적 콘솔
 * (public/index.html)은 Netlify CDN 이 직접 서빙하고, 이 함수는 API 만 담당한다.
 *
 * 컴파일된 dist/* 를 import(tsc build 산출물) — 번들러의 .js↔.ts 해석 이슈 회피.
 * 서버리스에는 Redis/Postgres 를 붙이지 않고 인메모리 구현으로 조립한다(콜드 스타트마다
 *   초기화 — 데모/프리뷰용. 영속 캐시가 필요하면 Upstash/Neon 어댑터를 주입). 이렇게 하면
 *   ioredis/pg 가 번들 그래프에서 빠져 서버리스 번들이 가벼워진다.
 * playwright(헤드리스)는 orchestrator 기본 renderer 로 그래프에 남지만 external 처리 →
 *   Lambda 에 미설치라 런타임 동적 import 실패 시 graceful fallback(static/oEmbed 동작).
 */

import { UnfurlCache, InMemoryCacheClient } from '../../dist/src/cache/unfurl-cache.js';
import { InMemoryCrawlStore } from '../../dist/src/persistence/postgres.js';
import { NoopMetrics } from '../../dist/src/metrics/instrumentation.js';
import { DomainRuleStore, StaticSeedRuleProvider } from '../../dist/src/rules/domain-rules.js';
import { toEnvelope, httpStatusFor } from '../../dist/src/api/envelope.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

// 워ーム스타트 간 재사용(모듈 스코프 1회 조립). 인메모리 = 외부 의존 0.
const cache = new UnfurlCache({
  redis: new InMemoryCacheClient(),
  metrics: new NoopMetrics(),
  store: new InMemoryCrawlStore(),
  rules: new DomainRuleStore(new StaticSeedRuleProvider()),
  workerId: 'netlify-fn',
});

export default async (req: Request): Promise<Response> => {
  const u = new URL(req.url);

  // 헬스체크
  if (u.pathname.endsWith('/healthz')) {
    return new Response(JSON.stringify({ status: 'ok', runtime: 'netlify-function' }), {
      headers: { ...JSON_HEADERS, 'cache-control': 'no-store' },
    });
  }

  const url = u.searchParams.get('url');
  const debug = u.searchParams.get('debug') === 'true';
  const refresh = u.searchParams.get('refresh') === 'true';

  if (!url) {
    return new Response(
      JSON.stringify({ data: null, meta: null, error: { code: 'INVALID_URL', message: 'missing url' } }),
      { status: 400, headers: JSON_HEADERS },
    );
  }

  try {
    const { result, cache: cacheState, ttl_sec } = await cache.getUnfurl(url, { refresh });
    const env = toEnvelope(result, cacheState, ttl_sec, debug);
    return new Response(JSON.stringify(env), {
      status: httpStatusFor(result),
      headers: {
        ...JSON_HEADERS,
        'x-cache': cacheState,
        'cache-control':
          result.status === 'failed' ? 'no-store' : 'public, max-age=300, stale-while-revalidate=60',
      },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ data: null, meta: null, error: { code: 'UNKNOWN', message: (e as Error)?.message ?? 'error' } }),
      { status: 500, headers: JSON_HEADERS },
    );
  }
};

export const config = {
  path: ['/unfurl', '/healthz'],
};
