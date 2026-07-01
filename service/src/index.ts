/**
 * index.ts — 부트스트랩 (조립 지점)
 *
 * 통합 §2 데이터 흐름을 실제 객체 그래프로 조립한다:
 *   API 티어(Fastify) → UnfurlCache(Redis 2단계+SWR+single-flight) → fetchOg 오케스트레이터
 *   → safeFetch/extractOg/decideEscalation/oembed/headless → 계측/영속.
 *
 * 어댑터 선택은 팩토리에 위임(코어 로직 불변):
 *   - createCacheClient():  REDIS_URL 있으면 ioredis, 없으면 인메모리(외부 의존 0 dev).
 *   - createPersistence(): DATABASE_URL 있으면 pg(crawl_attempts/failed_crawls/domain_rules), 없으면 인메모리.
 *   접속 실패 시 두 팩토리 모두 인메모리로 graceful fallback → 서비스는 항상 기동한다.
 */

import { buildServer } from './api/server.js';
import { CONFIG } from './config.js';
import { UnfurlCache } from './cache/unfurl-cache.js';
import { createCacheClient } from './cache/redis-store.js';
import { createPersistence } from './persistence/pg-store.js';
import { ConsoleMetrics } from './metrics/instrumentation.js';
import { DomainRuleStore } from './rules/domain-rules.js';
import { headlessRenderer } from './strategy/headless.js';

async function main(): Promise<void> {
  const metrics = new ConsoleMetrics(CONFIG.METRICS_ENABLED);

  // 어댑터 선택(env 기반 · 접속 실패 시 인메모리 강등).
  const cacheHandle = await createCacheClient();
  const persistence = await createPersistence();
  const rules = new DomainRuleStore(persistence.ruleProvider);

  const cache = new UnfurlCache({
    redis: cacheHandle.client,
    metrics,
    store: persistence.store,
    rules,
    renderer: headlessRenderer,
    workerId: `w-${process.pid}`,
  });

  const app = buildServer({ cache });

  try {
    await app.listen({ port: CONFIG.PORT, host: '0.0.0.0' });
    app.log.info(
      `OG unfurl service on :${CONFIG.PORT} — cache=${cacheHandle.kind} persistence=${persistence.kind}`,
    );
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = async (): Promise<void> => {
    await app.close().catch(() => {});
    await headlessRenderer.close().catch(() => {});
    await cacheHandle.close().catch(() => {});
    await persistence.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// ESM 엔트리포인트 가드
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
