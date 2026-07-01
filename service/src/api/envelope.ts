/**
 * api/envelope.ts — 응답 봉투 변환 (platform §2-2)
 *
 * FetchResult → UnfurlEnvelope 변환과 캐시 헤더 계산을 한 곳에 둔다.
 * Fastify 서버(server.ts)와 서버리스 함수(netlify)가 동일 로직을 공유(경계면 정합성).
 */

import { CONFIG } from '../config.js';
import type { CacheState, FetchResult, UnfurlEnvelope } from '../types.js';

/** `?debug=true` 진단 필드(성공/실패 공통). 프로덕션 기본 응답엔 미포함. */
export function debugOf(result: FetchResult): NonNullable<UnfurlEnvelope['debug']> {
  return {
    status: result.status,
    completeness_score: result.completeness,
    richness: result.richness,
    latency_ms: result.latency_ms,
    http_status: result.http_status,
    content_type: result.content_type,
    redirect_chain: result.redirect_chain,
    source_map: result.source_map,
    error_code: result.error_code,
    note: result.note ?? null,
    short_link_cached: result.cache.short_link_cached,
    images: result.og.images,
    input_url: result.input_url,
    normalized_url: result.normalized_url,
    recovery: result.recovery ?? null,
  };
}

/** FetchResult + cache 상태 → 동기 응답 봉투(platform §2-2). */
export function toEnvelope(
  result: FetchResult,
  cache: CacheState,
  ttlSec: number,
  debug = false,
): UnfurlEnvelope {
  const dbg = debug ? debugOf(result) : undefined;
  if (result.status === 'failed') {
    return {
      data: null,
      meta: null,
      error: {
        code: result.error_code ?? 'UNKNOWN',
        message: result.error_code ?? 'unknown error',
      },
      ...(dbg ? { debug: dbg } : {}),
    };
  }
  return {
    data: {
      title: result.og.title,
      description: result.og.description,
      image: result.og.image, // EXTENSION: /img 프록시 URL로 치환(platform §2-2)
      site_name: result.og.site_name,
      type: result.og.type,
      url: result.canonical_url,
    },
    meta: {
      cache,
      completeness: result.completeness >= CONFIG.COMPLETE_THRESHOLD ? 'full' : 'partial',
      fetch_strategy: result.fetch_strategy,
      final_url: result.final_url,
      canonical_url: result.canonical_url,
      fetched_at: result.fetched_at,
      ttl_seconds: ttlSec,
    },
    error: null,
    ...(dbg ? { debug: dbg } : {}),
  };
}

/** HTTP 캐싱 헤더(platform §2-3): 공개·성공 → CDN/브라우저 캐싱 유도. */
export function cacheControlFor(result: FetchResult, cache: CacheState, ttlSec: number): string {
  if (result.status === 'failed' || cache === 'negative') return 'no-store';
  const swr = Math.ceil(ttlSec * CONFIG.SWR_WINDOW_RATIO);
  return `public, max-age=${ttlSec}, stale-while-revalidate=${swr}`;
}

/** 실패 FetchResult → HTTP 상태 코드(부분 카드 정책: 성공/부분은 200). */
export function httpStatusFor(result: FetchResult): number {
  if (result.status !== 'failed') return 200;
  return result.http_status && result.http_status >= 400 ? result.http_status : 502;
}
