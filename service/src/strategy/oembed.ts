/**
 * strategy/oembed.ts — Stage 2 oEmbed 페치 (crawl §1.1 / §3.1 순위 3)
 *
 * known provider 도메인은 스크래핑보다 공급자 API가 안정적(렌더 불필요).
 * oEmbed JSON → title/author_name/thumbnail_url 매핑 후 orchestrator가 merge_fill(빈 필드만).
 *
 * 주변부 모듈: 핵심 인터페이스 + 실제 undici 호출. discovery(<link rel=alternate
 * type=application/json+oembed>)는 EXTENSION로 표시.
 */

import { request } from 'undici';
import { CONFIG } from '../config.js';
import { CrawlError } from '../errors/taxonomy.js';

export interface OembedResult {
  ok: boolean;
  title: string | null;
  description: string | null;
  thumbnail_url: string | null;
  author_name: string | null;
  html: string | null;
}

/**
 * oembed_fetch(finalUrl, endpoint) — 공급자 oEmbed JSON 조회.
 * @throws {CrawlError} OEMBED_FAILED — 공급자 오류/비JSON(헤드리스 낙하 트리거).
 */
export async function oembedFetch(finalUrl: string, endpoint: string): Promise<OembedResult> {
  const url = new URL(endpoint);
  url.searchParams.set('url', finalUrl);
  url.searchParams.set('format', 'json');

  try {
    const res = await request(url.toString(), {
      method: 'GET',
      headers: { 'User-Agent': CONFIG.DEFAULT_UA, Accept: 'application/json' },
      headersTimeout: CONFIG.HEADERS_TIMEOUT_MS,
      bodyTimeout: CONFIG.HEADERS_TIMEOUT_MS,
      maxRedirections: 2, // 공급자 엔드포인트는 신뢰(내부 SSRF 재검증은 EXTENSION)
    });
    if (res.statusCode >= 400) {
      res.body.dump().catch(() => {});
      throw new CrawlError('OEMBED_FAILED', `oEmbed HTTP ${res.statusCode}`);
    }
    const json = (await res.body.json()) as Record<string, unknown>;
    return {
      ok: true,
      title: str(json.title),
      description: str(json.description) ?? str(json.author_name),
      thumbnail_url: str(json.thumbnail_url),
      author_name: str(json.author_name),
      html: str(json.html),
    };
  } catch (err) {
    if (err instanceof CrawlError) throw err;
    throw new CrawlError('OEMBED_FAILED', (err as Error)?.message, { cause: err });
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}
