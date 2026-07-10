/**
 * fetch/safe-fetch.ts — SSRF-safe static fetch (crawl §2.1 / §4)
 *
 * 수동 리다이렉트 추적을 원칙으로 한다(라이브러리 자동 추적 off). 이유: 홉마다
 *   1) SSRF 재검증(DNS 해석 IP 검사)  2) IP 핀(리바인딩 방지)  3) 체인 기록
 * 이 필요하기 때문. 추가로 본문 크기 상한·타임아웃·압축 해제·charset 디코드를 내장.
 *
 * 라이브러리: undici (runtime-strategist §(b) 확정 — 커넥션 풀·keep-alive·수동 리다이렉트·
 *   타임아웃 세분화). IP 핀은 undici Agent의 커스텀 connect.lookup 으로 구현한다.
 *
 * QA 검증 포인트 #5: DNS 해석 후 + 홉마다 검증 + IP 핀 → 이 파일이 근거.
 */

import { Agent, request } from 'undici';
import { createGunzip, createBrotliDecompress, createInflate, createInflateRaw } from 'node:zlib';
import { Readable, type Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import iconv from 'iconv-lite';
import contentType from 'content-type';
import { CONFIG } from '../config.js';
import { CrawlError, httpStatusToErrorCode, type ErrorCode } from '../errors/taxonomy.js';
import type { DomainRule } from '../rules/domain-rules.js';
import type { RedirectHop, StaticFetchResult } from '../types.js';
import { absolutize, canonicalizeForLoopCheck } from '../url/normalize.js';
import { ssrfPrecheck } from './ssrf-guard.js';
import {
  detectJsRedirect,
  looksLikeRedirectShell,
  parseMetaRefresh,
} from '../strategy/spa-signals.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** IP 핀 lookup — undici가 hostname을 재해석하지 않고 검증된 IP로만 커넥트하게 강제. */
function pinnedLookup(ip: string, family: 4 | 6) {
  return (_hostname: string, options: unknown, callback: unknown): void => {
    let cb = callback as (err: Error | null, address?: unknown, family?: number) => void;
    let opts = options as { all?: boolean };
    if (typeof options === 'function') {
      cb = options as typeof cb;
      opts = {};
    }
    if (opts && opts.all) {
      (cb as unknown as (e: Error | null, a: { address: string; family: number }[]) => void)(null, [
        { address: ip, family },
      ]);
    } else {
      cb(null, ip, family);
    }
  };
}

/** undici/네트워크 예외 → 확정 에러 코드. */
function classifyFetchError(err: unknown): ErrorCode {
  const e = err as { code?: string; name?: string; message?: string };
  const code = e.code ?? '';
  const name = e.name ?? '';
  if (code === 'UND_ERR_CONNECT_TIMEOUT') return 'CONN_TIMEOUT';
  if (code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') return 'READ_TIMEOUT';
  if (name === 'AbortError' || code === 'UND_ERR_ABORTED') return 'READ_TIMEOUT';
  if (code === 'ECONNREFUSED') return 'CONN_REFUSED';
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'READ_TIMEOUT';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'DNS_FAIL';
  if (
    code.startsWith('ERR_TLS') ||
    code.startsWith('ERR_SSL') ||
    code === 'CERT_HAS_EXPIRED' ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN'
  )
    return 'TLS_ERROR';
  return 'UNKNOWN';
}

/** 요청 헤더 조립 (crawl §4.2 + per-domain override). */
function buildHeaders(rule: DomainRule): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': rule.ua_override ?? CONFIG.DEFAULT_UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': CONFIG.DEFAULT_ACCEPT_LANGUAGE,
    'Accept-Encoding': 'gzip, br, deflate',
  };
  if (rule.extra_headers) Object.assign(headers, rule.extra_headers);
  if (rule.extra_cookies) {
    const cookie = Object.entries(rule.extra_cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    if (cookie) headers['Cookie'] = cookie;
  }
  return headers;
}

/**
 * Content-Encoding 해제 — 스트리밍 + **해제 후** 바이트 재-cap (zip bomb 방어).
 *
 * readCapped 는 압축 바이트만 제한하므로 소량의 압축 본문이 수 GB로 팽창하는 폭탄을 못 막는다.
 * 이 함수는 청크 단위로 해제하며 누적 바이트가 cap 을 넘는 순간 스트림을 파괴하고 즉시 TOO_LARGE —
 * 메모리가 실제로 폭발하기 전에 차단한다. 동기 gunzipSync 대비 이벤트루프 블로킹도 완화한다.
 * cap 초과가 아닌 손상/부분 압축은 여태 해제된 만큼 보존한다(부분 결과 보존 원칙).
 */
export async function decompressCapped(
  buf: Buffer,
  encoding: string | undefined,
  cap: number,
): Promise<Buffer> {
  if (!encoding) return buf; // 비압축 — 이미 readCapped(압축=원본 cap) 통과분
  const enc = encoding.toLowerCase();

  // 스트림에 buf 를 흘려 해제하되, 누적이 cap 을 넘으면 TOO_LARGE, 아무것도 못 해제하면(총 0) reject.
  // pipeline 이 소스·transform 정리를 자동 보장(누수/부유 error 방지). 3분기 동작은 consumer가 유지.
  const run = async (stream: Transform): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      await pipeline(Readable.from(buf), stream, async (source) => {
        for await (const c of source as AsyncIterable<Buffer>) {
          total += c.length;
          if (total > cap) {
            throw new CrawlError('TOO_LARGE', `decompressed body exceeded cap ${cap}`);
          }
          chunks.push(c);
        }
      });
      return Buffer.concat(chunks, total);
    } catch (err) {
      if (err instanceof CrawlError) throw err; // cap 초과 전파
      if (total === 0) throw err; // 아무것도 못 해제 → 폴백/실패 판단으로
      return Buffer.concat(chunks, total); // 부분 해제분 보존
    }
  };

  const makeStream = (): Transform | null => {
    if (enc === 'gzip' || enc === 'x-gzip') return createGunzip();
    if (enc === 'br') return createBrotliDecompress();
    if (enc === 'deflate') return createInflate();
    return null;
  };

  const stream = makeStream();
  if (!stream) return buf; // 미지원 인코딩 — 원본 반환(기존 동작)

  try {
    return await run(stream);
  } catch (err) {
    if (err instanceof CrawlError) throw err; // TOO_LARGE 는 상위로
    // deflate: zlib 헤더 없는 raw deflate 1회 폴백
    if (enc === 'deflate') {
      try {
        return await run(createInflateRaw());
      } catch (err2) {
        if (err2 instanceof CrawlError) throw err2;
        return buf;
      }
    }
    return buf; // 해제 불가 — 원본 보존(기존 동작)
  }
}

/** charset 결정: Content-Type → <meta charset> → BOM → utf-8 (crawl §4.2). */
function decodeBody(buf: Buffer, ctHeader: string | null): { text: string; charset: string } {
  let charset: string | null = null;

  // 1) Content-Type 헤더
  if (ctHeader) {
    try {
      const parsed = contentType.parse(ctHeader);
      if (parsed.parameters.charset) charset = parsed.parameters.charset;
    } catch {
      /* ignore */
    }
  }
  // 2) BOM
  if (!charset) {
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) charset = 'utf-8';
    else if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) charset = 'utf-16le';
    else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) charset = 'utf-16be';
  }
  // 3) <meta charset> (앞 2KB만 ASCII로 훑음)
  if (!charset) {
    const head = buf.subarray(0, 2048).toString('latin1');
    const m =
      head.match(/<meta[^>]+charset=["']?\s*([\w-]+)/i) ??
      head.match(/charset=["']?\s*([\w-]+)/i);
    if (m && m[1]) charset = m[1];
  }
  // 4) 폴백
  if (!charset) charset = 'utf-8';

  const normalized = charset.toLowerCase();
  try {
    if (normalized === 'utf-8' || normalized === 'utf8' || normalized === 'ascii' || normalized === 'us-ascii') {
      return { text: buf.toString('utf-8'), charset: 'utf-8' };
    }
    if (iconv.encodingExists(normalized)) {
      return { text: iconv.decode(buf, normalized), charset: normalized };
    }
  } catch {
    /* fall through */
  }
  return { text: buf.toString('utf-8'), charset: 'utf-8' }; // 잘못된 charset → UTF-8 폴백
}

/** capped 스트림 읽기 — cap 초과 시 TOO_LARGE. */
async function readCapped(
  body: AsyncIterable<Buffer>,
  cap: number,
): Promise<{ buf: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const c = chunk as Buffer;
    total += c.length;
    if (total > cap) {
      // 남은 스트림은 GC/소켓 정리에 맡김. 초과는 즉시 실패로 표기.
      throw new CrawlError('TOO_LARGE', `body exceeded cap ${cap}`);
    }
    chunks.push(c);
  }
  return { buf: Buffer.concat(chunks, total), truncated: false };
}

export interface SafeFetchDeps {
  /** SSRF 사전검증(홉마다) — 기본 실제 구현. 테스트에서 주입 가능. */
  precheck?: typeof ssrfPrecheck;
}

/**
 * static_fetch(url, rule, pinned_ip) — crawl §2.1 오케스트레이터.
 * 수동으로 3xx / meta-refresh 소프트 리다이렉트를 홉마다 SSRF 재검증하며 따라가 최종 URL 확정.
 *
 * @param startUrl 이미 Stage0에서 1차 SSRF 통과한 URL(정규화됨)
 * @param pinnedIp Stage0에서 핀된 첫 홉 IP
 * @throws {CrawlError} 하드 실패(TOO_MANY_REDIRECTS/REDIRECT_LOOP/SSRF_BLOCKED/타임아웃 등)
 */
export async function safeFetch(
  startUrl: string,
  rule: DomainRule,
  pinnedIp: string,
  ipFamily: 4 | 6,
  deps: SafeFetchDeps = {},
): Promise<StaticFetchResult> {
  const precheck = deps.precheck ?? ssrfPrecheck;
  const maxHops = rule.max_redirects ?? CONFIG.MAX_REDIRECT_HOPS;
  const bodyCap = rule.body_byte_cap ?? CONFIG.MAX_BODY_BYTES;
  const headers = buildHeaders(rule);

  const visited = new Set<string>();
  const chain: RedirectHop[] = [];
  let cur = startUrl;
  let curIp = pinnedIp;
  let curFamily = ipFamily;
  let hops = 0;
  let followedMetaRefresh = false;

  // 전체 데드라인(total timeout) — 홉을 관통.
  const deadline = Date.now() + CONFIG.TOTAL_TIMEOUT_MS;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (hops > maxHops) throw new CrawlError('TOO_MANY_REDIRECTS', `>${maxHops} hops`);
    const loopKey = canonicalizeForLoopCheck(cur);
    if (visited.has(loopKey)) throw new CrawlError('REDIRECT_LOOP', `loop at ${loopKey}`);
    visited.add(loopKey);

    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new CrawlError('READ_TIMEOUT', 'total deadline exceeded');

    // IP 핀 dispatcher — 이 홉의 검증된 IP로만 커넥트(리바인딩 방지).
    const agent = new Agent({
      connect: {
        timeout: CONFIG.CONNECT_TIMEOUT_MS,
        lookup: pinnedLookup(curIp, curFamily) as never,
      },
      headersTimeout: Math.min(CONFIG.HEADERS_TIMEOUT_MS, remaining),
      bodyTimeout: Math.min(CONFIG.TOTAL_TIMEOUT_MS, remaining),
    });

    let res: Awaited<ReturnType<typeof request>>;
    try {
      res = await request(cur, {
        dispatcher: agent,
        method: 'GET',
        headers,
        maxRedirections: 0, // ★ 자동 추적 off — 수동 제어
      });
    } catch (err) {
      await agent.close().catch(() => {});
      if (err instanceof CrawlError) throw err;
      throw new CrawlError(classifyFetchError(err), (err as Error)?.message, { cause: err });
    }

    const status = res.statusCode;
    const locHeader = res.headers['location'];

    // ── 3xx: 리다이렉트 ──
    if (REDIRECT_STATUSES.has(status)) {
      // 본문 폐기(리다이렉트 응답 본문 무시)
      res.body.dump().catch(() => {});
      await agent.close().catch(() => {});
      const locRaw = Array.isArray(locHeader) ? locHeader[0] : locHeader;
      if (!locRaw) throw new CrawlError('UNKNOWN', `3xx without Location (${status})`);
      const loc = absolutize(String(locRaw).split('\n')[0]!.trim(), cur); // 개행 삽입 방어
      chain.push({ url: cur, status, location: loc, hop_type: 'http' });

      const g = await precheck(loc); // ★ 홉마다 재검증
      if (g.blocked) throw new CrawlError(g.errorCode ?? 'SSRF_BLOCKED', g.reason);
      cur = loc;
      curIp = g.pinnedIp!;
      curFamily = g.ipFamily ?? 4;
      hops += 1;
      continue;
    }

    // ── 4xx/5xx: HTTP 에러(본문 폐기 후 코드화) ──
    if (status >= 400) {
      res.body.dump().catch(() => {});
      await agent.close().catch(() => {});
      throw new CrawlError(httpStatusToErrorCode(status), `HTTP ${status}`, { httpStatus: status });
    }

    // ── 2xx: 본문 수신(스트리밍 + 크기 상한) ──
    let raw: Buffer;
    try {
      const capped = await readCapped(res.body as AsyncIterable<Buffer>, bodyCap);
      raw = capped.buf;
    } catch (err) {
      await agent.close().catch(() => {});
      if (err instanceof CrawlError) throw err;
      throw new CrawlError(classifyFetchError(err), (err as Error)?.message, { cause: err });
    }
    await agent.close().catch(() => {});

    const ctHeaderRaw = res.headers['content-type'];
    const ctHeader = Array.isArray(ctHeaderRaw) ? (ctHeaderRaw[0] ?? null) : (ctHeaderRaw ?? null);
    const encRaw = res.headers['content-encoding'];
    const encoding = Array.isArray(encRaw) ? encRaw[0] : encRaw;
    const serverRaw = res.headers['server'];
    const server = Array.isArray(serverRaw) ? (serverRaw[0] ?? null) : (serverRaw ?? null);

    // ★ 해제 후 재-cap: 압축 폭탄(팽창)을 여기서 차단. TOO_LARGE 는 agent 정리 후 상위로 전파됨.
    const decompressed = await decompressCapped(raw, encoding, bodyCap);
    if (decompressed.length === 0) {
      throw new CrawlError('EMPTY_BODY', '200 with empty body', { httpStatus: status });
    }
    const { text, charset } = decodeBody(decompressed, ctHeader);

    // ── meta-refresh 소프트 리다이렉트 ──
    const mr = parseMetaRefresh(text);
    if (mr && mr.delay <= CONFIG.META_REFRESH_MAX_DELAY && looksLikeRedirectShell(text)) {
      const loc = absolutize(mr.url, cur);
      chain.push({ url: cur, status: 200, location: loc, hop_type: 'meta_refresh' });
      const g = await precheck(loc); // ★ meta-refresh 종점도 재검증
      if (g.blocked) throw new CrawlError(g.errorCode ?? 'SSRF_BLOCKED', g.reason);
      cur = loc;
      curIp = g.pinnedIp!;
      curFamily = g.ipFamily ?? 4;
      hops += 1;
      followedMetaRefresh = true;
      continue;
    }

    // ── 최종 페이지 도달 ──
    return {
      final_url: cur,
      redirect_chain: chain,
      http_status: status,
      content_type: ctHeader,
      charset,
      body: text,
      body_bytes: raw.length,
      js_redirect_signal: detectJsRedirect(text),
      pinned_ip: curIp,
      followed_meta_refresh: followedMetaRefresh,
    };
  }
}
