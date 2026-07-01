/**
 * api/server.ts — Fastify API 티어 (platform §2 / 통합 §2)
 *
 * GET /unfurl?url=&strategy=&refresh=  — 동기 + SWR + 짧은 타임아웃 예산(§2-3).
 *   응답 봉투(platform §2-2): { data, meta, error }.
 *   타임아웃 예산 초과·headless 필요 판정 시 202 + job_id 로 큐 승격(스텁).
 * GET /img, POST /unfurl/batch, GET /unfurl/jobs/{id} — 스텁(인터페이스만).
 *
 * 계측 훅(§8): API 진입에서 trace_id 생성 → 응답 헤더로 전파. 캐시 상태별 카운터는
 *   UnfurlCache 레이어가 emit(cache 상태 소유 지점).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { CONFIG } from '../config.js';
import { newTrace } from '../metrics/instrumentation.js';
import type { UnfurlCache } from '../cache/unfurl-cache.js';
import { toEnvelope, cacheControlFor } from './envelope.js';

export interface ServerDeps {
  cache: UnfurlCache;
}

// ASSUMPTION: 앱은 service/ 디렉토리를 cwd로 실행(npm run dev/start = tsx, Docker WORKDIR /app).
// 따라서 정적 플레이그라운드는 cwd 기준으로 로드한다. 최초 1회 읽어 캐시.
let PLAYGROUND_HTML: string | null = null;
function playgroundHtml(): string {
  if (PLAYGROUND_HTML === null) {
    try {
      PLAYGROUND_HTML = readFileSync(resolve(process.cwd(), 'public/index.html'), 'utf8');
    } catch {
      PLAYGROUND_HTML = '<!doctype html><meta charset=utf-8><title>unfurl</title><p>public/index.html not found';
    }
  }
  return PLAYGROUND_HTML;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: true, disableRequestLogging: false });

  // ── GET / (플레이그라운드 UI) ──
  app.get('/', async (_req, reply) => {
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-cache');
    return playgroundHtml();
  });

  // ── GET /unfurl (동기 경로) ──
  app.get<{ Querystring: { url?: string; strategy?: string; refresh?: string; debug?: string } }>(
    '/unfurl',
    async (req, reply) => {
      const trace = newTrace();
      reply.header('x-trace-id', trace.trace_id);

      const url = req.query.url;
      if (!url || typeof url !== 'string') {
        reply.code(400);
        return { data: null, meta: null, error: { code: 'INVALID_URL', message: 'missing url' } };
      }
      const refresh = req.query.refresh === 'true';
      const debug = req.query.debug === 'true';

      // 타임아웃 예산(§2-3): 예산 초과 시 큐로 승격(202). 여기선 예산 레이스로 표현.
      // 타이머는 unref — 요청 중에는 listen 소켓이 이벤트루프를 잡고 있어 정상 발화하지만,
      // (inject 테스트처럼) 다른 핸들이 없으면 프로세스 종료를 막지 않는다.
      let budgetTimer: ReturnType<typeof setTimeout> | undefined;
      const budget = new Promise<'timeout'>((resolve) => {
        budgetTimer = setTimeout(() => resolve('timeout'), CONFIG.SYNC_BUDGET_MS);
        budgetTimer.unref?.();
      });
      const work = deps.cache.getUnfurl(url, { refresh });

      const outcome = await Promise.race([work, budget]).finally(() => {
        if (budgetTimer) clearTimeout(budgetTimer);
      });
      if (outcome === 'timeout') {
        // 예산 초과 → 비동기 큐 승격(§2-3). 크롤은 백그라운드로 계속(work가 캐시에 기록).
        void work.catch(() => {});
        const jobId = trace.trace_id;
        reply.code(202).header('cache-control', 'no-store');
        return {
          data: null,
          meta: null,
          error: null,
          job_id: jobId,
          poll_url: `/unfurl/jobs/${jobId}`,
        };
      }

      const { result, cache, ttl_sec } = outcome;
      const env = toEnvelope(result, cache, ttl_sec, debug);
      reply.header('cache-control', cacheControlFor(result, cache, ttl_sec));
      reply.header('x-cache', cache);
      // 실패라도 부분 카드 정책상 200 유지 가능하나, 완전 실패는 4xx/5xx 매핑.
      if (result.status === 'failed') {
        reply.code(result.http_status && result.http_status >= 400 ? result.http_status : 502);
      }
      return env;
    },
  );

  // ── POST /unfurl/batch (비동기, 스텁) ──
  app.post<{ Body: { urls?: string[]; webhook_url?: string } }>('/unfurl/batch', async (req, reply) => {
    const urls = req.body?.urls ?? [];
    // TODO(EXTENSION): 큐(Redis Streams/SQS/Kafka)에 enqueue → job_id 배열 반환(platform §2-1).
    const jobs = urls.map((u, i) => ({ url: u, job_id: `${newTrace().trace_id}-${i}` }));
    reply.code(202);
    return { jobs };
  });

  // ── GET /unfurl/jobs/:id (폴링, 스텁) ──
  app.get<{ Params: { id: string } }>('/unfurl/jobs/:id', async (req) => {
    // TODO(EXTENSION): job 상태/결과 조회(큐 백엔드 소비).
    return { job_id: req.params.id, status: 'pending', result: null };
  });

  // ── GET /img (이미지 프록시, 스텁) ──
  app.get('/img', async (_req, reply) => {
    // TODO(EXTENSION): 오브젝트 스토리지(S3/GCS) 프록시·리사이즈 사본 서빙(platform §4-2).
    reply.code(501);
    return { error: 'not implemented (image proxy stub)' };
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  return app;
}
