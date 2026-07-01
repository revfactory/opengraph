/**
 * orchestrator.ts — fetch_og 오케스트레이터 (crawl §1.1)
 *
 * 비용 순 승격 래더: Stage0(정규화+SSRF) → Stage1(static) → [승격판단] →
 *   Stage2(oEmbed) / Stage3(headless) → 폴백 파싱 → finalize(completeness→status).
 * 모든 단계는 부분 결과라도 보존한다(불변식 1). 실패는 삼키지 않고 error_code로 분류.
 *
 * 계측(§8): crawl 반환 직후 completeness observe + 실패 시 failed_crawls UPSERT.
 *   요청 단위 og_crawl_total{cache} counter 는 cache 레이어가 소유(cache 상태를 알기 때문).
 */

import { CONFIG, isHtmlContentType } from './config.js';
import {
  CrawlError,
  ERROR_META,
  isKnownErrorCode,
  type ErrorCode,
} from './errors/taxonomy.js';
import type { HeadlessRenderer } from './strategy/headless.js';
import { headlessRenderer } from './strategy/headless.js';
import { oembedFetch } from './strategy/oembed.js';
import {
  decideEscalation,
  resolveOembedEndpoint,
  shouldHeadlessAfterOembed,
} from './strategy/fetch-strategy.js';
import { isBotBlock, recoveryUaCandidates } from './strategy/bot-recovery.js';
import { extractOg, scoreCompleteness, scoreRichness } from './extract/extract-og.js';
import { safeFetch } from './fetch/safe-fetch.js';
import { ssrfPrecheck } from './fetch/ssrf-guard.js';
import type { Metrics } from './metrics/instrumentation.js';
import { NoopMetrics, newTrace, type TraceContext } from './metrics/instrumentation.js';
import type { CrawlStore } from './persistence/postgres.js';
import { InMemoryCrawlStore, attemptFromResult } from './persistence/postgres.js';
import {
  DomainRuleStore,
  StaticSeedRuleProvider,
  appliedRuleFields,
  type DomainRule,
} from './rules/domain-rules.js';
import type { FetchResult, OgCard, RedirectHop, SourceMap, StaticFetchResult } from './types.js';
import { domainOf } from './url/domain.js';
import { normalizeUrl } from './url/normalize.js';

export interface OrchestratorDeps {
  rules?: DomainRuleStore;
  renderer?: HeadlessRenderer;
  metrics?: Metrics;
  store?: CrawlStore;
  /** short→final 매핑 조회(캐시 단락, crawl §2.2). null이면 스킵. */
  shortMapGet?: (norm: string) => Promise<string | null>;
  /** static fetch 주입(테스트/회복 래더 검증용). 기본 safeFetch. */
  staticFetch?: typeof safeFetch;
  /** SSRF 사전검증 주입(테스트용). 기본 ssrfPrecheck. */
  precheck?: typeof ssrfPrecheck;
  workerId?: string;
}

const defaults = {
  rules: new DomainRuleStore(new StaticSeedRuleProvider()),
  renderer: headlessRenderer,
  metrics: new NoopMetrics() as Metrics,
  store: new InMemoryCrawlStore() as CrawlStore,
};

function emptyCard(): OgCard {
  return {
    title: null, description: null, image: null, images: [], image_width: null,
    image_height: null, site_name: null, type: null, url: null, locale: null,
  };
}

/** completeness/에러 → status 판정 (crawl §1.1 finalize / §1-4: ok ⟺ ≥0.66). */
function statusOf(completeness: number, fatal: boolean): FetchResult['status'] {
  if (fatal || completeness === 0) return completeness > 0 ? 'partial' : 'failed';
  if (completeness >= CONFIG.COMPLETE_THRESHOLD) return 'ok';
  return 'partial';
}

/** 실패 FetchResult 생성 + failed_crawls UPSERT. */
async function fail(
  inputUrl: string,
  norm: string,
  code: ErrorCode,
  ctx: { trace: TraceContext; deps: Required<Pick<OrchestratorDeps, 'metrics' | 'store'>>; workerId: string },
  extra: Partial<FetchResult> = {},
): Promise<FetchResult> {
  const finalUrl = extra.final_url ?? norm;
  const meta = ERROR_META[code];
  const result: FetchResult = {
    input_url: inputUrl,
    normalized_url: norm,
    final_url: finalUrl,
    canonical_url: extra.canonical_url ?? finalUrl,
    redirect_chain: extra.redirect_chain ?? [],
    fetch_strategy: extra.fetch_strategy ?? 'static',
    status: statusOf(extra.completeness ?? 0, true),
    error_code: code,
    http_status: extra.http_status ?? null,
    content_type: extra.content_type ?? null,
    completeness: extra.completeness ?? 0,
    richness: extra.richness ?? 0,
    og: extra.og ?? emptyCard(),
    source_map: extra.source_map ?? {},
    fetched_at: new Date().toISOString(),
    latency_ms: Date.now() - ctx.trace.started_at,
    cache: { short_link_cached: false },
  };

  // ★ 정본 append: 실패 시도도 crawl_attempts에 1행(통합 §3-bis 단일 writeAttempt 경로).
  await ctx.deps.store.writeAttempt(
    attemptFromResult(result, {
      trace_id: ctx.trace.trace_id,
      cache: 'miss', // 실제 크롤 시도(캐시 서브 아님)
      worker_id: ctx.workerId,
      rule_version: 0,
    }),
  );
  // 파생: failed_crawls UPSERT (롤업 top-N 뷰, §5-1)
  await ctx.deps.store.upsertFailedCrawl({
    trace_id: ctx.trace.trace_id,
    domain: domainOf(finalUrl) || domainOf(norm),
    input_domain: domainOf(inputUrl),
    error_code: code,
    error_class: meta.errorClass,
    stage: meta.stage,
    http_status: result.http_status,
    fetch_strategy: result.fetch_strategy,
    final_url: finalUrl,
    attempt_no: 1,
    rule_version: 0,
    worker_id: ctx.workerId,
  });
  ctx.deps.metrics.completeness(result.completeness, { strategy: result.fetch_strategy });
  return result;
}

/** 비-HTML 최소 카드 (crawl §3.3 조기 종료). */
function nonHtmlCard(finalUrl: string, contentType: string): { og: OgCard; completeness: number } {
  const og = emptyCard();
  const ct = contentType.toLowerCase();
  const filename = (() => {
    try {
      return decodeURIComponent(new URL(finalUrl).pathname.split('/').pop() || '') || finalUrl;
    } catch {
      return finalUrl;
    }
  })();
  if (ct.startsWith('image/')) {
    og.image = finalUrl;
    og.images = [finalUrl];
    og.title = filename;
    og.type = 'image';
    return { og, completeness: scoreCompleteness(og) };
  }
  if (ct.includes('application/pdf')) {
    og.title = filename;
    og.type = 'pdf';
    return { og, completeness: scoreCompleteness(og) };
  }
  if (ct.startsWith('video/') || ct.startsWith('audio/')) {
    og.title = filename;
    og.type = ct.startsWith('video/') ? 'video' : 'audio';
    return { og, completeness: scoreCompleteness(og) };
  }
  og.title = filename;
  return { og, completeness: scoreCompleteness(og) };
}

/**
 * fetchOg(inputUrl) — crawl §1.1 오케스트레이터 전개.
 * 항상 FetchResult 를 반환한다(throw하지 않음). 치명 실패도 error_code로 담아 반환.
 */
export async function fetchOg(inputUrl: string, depsIn: OrchestratorDeps = {}): Promise<FetchResult> {
  const trace = newTrace();
  const rules = depsIn.rules ?? defaults.rules;
  const renderer = depsIn.renderer ?? defaults.renderer;
  const metrics = depsIn.metrics ?? defaults.metrics;
  const store = depsIn.store ?? defaults.store;
  const workerId = depsIn.workerId ?? 'w-local';
  const ctx = { trace, deps: { metrics, store }, workerId };

  // ── Stage 0: 정규화 + SSRF 사전검증 ──
  let norm: string;
  try {
    norm = normalizeUrl(inputUrl);
  } catch (e) {
    return fail(inputUrl, inputUrl, 'INVALID_URL', ctx);
  }

  let rule: DomainRule;
  try {
    rule = await rules.resolve(new URL(norm).hostname);
  } catch {
    rule = await rules.resolve('');
  }

  // 단축링크 캐시 단락 (crawl §1.1 / §2.2)
  let effectiveNorm = norm;
  const preChain: RedirectHop[] = [];
  let shortLinkCached = false;
  if (rule.is_short_link && depsIn.shortMapGet) {
    const cachedFinal = await depsIn.shortMapGet(norm).catch(() => null);
    if (cachedFinal) {
      preChain.push({ url: inputUrl, status: 0, location: cachedFinal, hop_type: 'cached' });
      effectiveNorm = cachedFinal;
      shortLinkCached = true;
    }
  }

  const precheck = depsIn.precheck ?? ssrfPrecheck;
  const guard = await precheck(effectiveNorm);
  if (guard.blocked) {
    return fail(inputUrl, norm, guard.errorCode ?? 'SSRF_BLOCKED', ctx);
  }

  // ── Stage 1: Static fetch (+ 봇 차단 회복 래더, crawl §1.2.2 + reliability-ops §5) ──
  const staticFetch = depsIn.staticFetch ?? safeFetch;
  let recovery: FetchResult['recovery'] = null;

  const getStatic = async (): Promise<{ staticRes: StaticFetchResult } | { done: FetchResult }> => {
    try {
      return { staticRes: await staticFetch(effectiveNorm, rule, guard.pinnedIp!, guard.ipFamily ?? 4) };
    } catch (e) {
      const code = e instanceof CrawlError && isKnownErrorCode(e.code) ? e.code : 'UNKNOWN';
      const httpStatus = e instanceof CrawlError ? (e.httpStatus ?? null) : null;

      // 봇 차단(403/challenge)이 아니거나 회복 비활성 → 즉시 실패
      if (!(CONFIG.BOT_RECOVERY_ENABLED && isBotBlock(code))) {
        return { done: await fail(inputUrl, norm, code, ctx, { redirect_chain: preChain, http_status: httpStatus }) };
      }

      const domain = domainOf(effectiveNorm);

      // ① per-domain UA 오버라이드 전환 — 프리뷰-봇 UA 순차 재시도
      for (const ua of recoveryUaCandidates([CONFIG.DEFAULT_UA, rule.ua_override])) {
        try {
          const r = await staticFetch(
            effectiveNorm,
            { ...rule, ua_override: ua },
            guard.pinnedIp!,
            guard.ipFamily ?? 4,
          );
          rule = { ...rule, ua_override: ua }; // 이후 승격도 이 UA 유지
          metrics.ruleApply({ domain_bucket: domain, field: 'ua_override(recovered)' });
          rules.learn(domain, { ua_override: ua }, '403 회복: ua_override 로 통과');
          recovery = { via: 'ua_override', ua, learned: true };
          return { staticRes: r };
        } catch (e2) {
          const c2 = e2 instanceof CrawlError && isKnownErrorCode(e2.code) ? e2.code : 'UNKNOWN';
          if (!isBotBlock(c2)) break; // 다른 실패(타임아웃 등) → UA 문제 아님, 회복 중단
          // 여전히 봇 차단 → 다음 UA 후보
        }
      }

      // ② 헤드리스 전환 — 실브라우저 렌더로 통과 시도
      try {
        const hl = await renderer.render(effectiveNorm, { ...rule, force_headless: true });
        if (hl.ok) {
          const hlParsed = extractOg(hl.dom_html, hl.final_url);
          rules.learn(domain, { force_headless: true }, '403 회복: 헤드리스로 통과');
          recovery = { via: 'headless', learned: true };
          const synthetic: StaticFetchResult = {
            final_url: hl.final_url, redirect_chain: [], http_status: 200,
            content_type: 'text/html', charset: 'utf-8', body: hl.dom_html,
            body_bytes: hl.dom_html.length, js_redirect_signal: false,
            pinned_ip: '', followed_meta_refresh: false,
          };
          const note: ErrorCode | undefined = hlParsed.has_meta ? undefined : 'NO_OG_TAGS';
          return {
            done: finalize(
              inputUrl, norm, synthetic, preChain,
              { og: hlParsed.og, canonical_url: hlParsed.canonical_url, source_map: hlParsed.source_map, completeness: hlParsed.completeness, richness: hlParsed.richness },
              'headless', shortLinkCached, ctx, note, recovery,
            ),
          };
        }
      } catch {
        /* 헤드리스도 실패 → 최종 실패로 낙하 */
      }

      // ③ 회복 실패 → force_headless 규칙 제안(다음 요청부터 헤드리스) + 실패 보고
      rules.learn(domain, { allow_headless_on_challenge: true }, '403 회복 실패: 헤드리스 승격 제안(canary)');
      return { done: await fail(inputUrl, norm, code, ctx, { redirect_chain: preChain, http_status: httpStatus }) };
    }
  };

  const s = await getStatic();
  if ('done' in s) return s.done;
  const staticRes = s.staticRes;
  const redirectChain = [...preChain, ...staticRes.redirect_chain];

  // 규칙 적용 계측(§8 규칙 적용 시)
  for (const field of appliedRuleFields(rule)) {
    metrics.ruleApply({ domain_bucket: domainOf(staticRes.final_url), field });
  }

  // 비-HTML 조기 종료 (§3.3)
  if (!isHtmlContentType(staticRes.content_type)) {
    const { og, completeness } = nonHtmlCard(staticRes.final_url, staticRes.content_type ?? '');
    if (completeness === 0) {
      return fail(inputUrl, norm, 'NON_HTML', ctx, {
        final_url: staticRes.final_url,
        redirect_chain: redirectChain,
        http_status: staticRes.http_status,
        content_type: staticRes.content_type,
      });
    }
    return finalize(inputUrl, norm, staticRes, redirectChain, {
      og, canonical_url: staticRes.final_url, source_map: {}, completeness, richness: 0,
    }, 'static', shortLinkCached, ctx, 'NON_HTML', recovery);
  }

  // ── 폴백 파싱 ──
  let parsed;
  try {
    parsed = extractOg(staticRes.body, staticRes.final_url);
  } catch (e) {
    return fail(inputUrl, norm, 'PARSE_ERROR', ctx, {
      final_url: staticRes.final_url,
      redirect_chain: redirectChain,
      http_status: staticRes.http_status,
      content_type: staticRes.content_type,
    });
  }

  // ── 승격 판단 (§1.2) ──
  const decision = decideEscalation({
    completeness: parsed.completeness,
    contentIsHtml: true,
    hasMeta: parsed.has_meta,
    staticResult: staticRes,
    rule,
  });

  if (decision.decision === 'DONE') {
    const note: ErrorCode | undefined = parsed.has_meta ? undefined : 'NO_OG_TAGS';
    return finalize(inputUrl, norm, staticRes, redirectChain, parsed, 'static', shortLinkCached, ctx, note, recovery);
  }

  // ── Stage 2: oEmbed ──
  if (decision.decision === 'OEMBED') {
    const endpoint = decision.oembedEndpoint ?? resolveOembedEndpoint(staticRes.final_url, rule);
    if (endpoint) {
      try {
        const oe = await oembedFetch(staticRes.final_url, endpoint);
        if (oe.ok) {
          // merge_fill: 빈 필드만 채움
          if (!parsed.og.title && oe.title) { parsed.og.title = oe.title; parsed.source_map.title = 'oembed'; }
          if (!parsed.og.description && oe.description) { parsed.og.description = oe.description; parsed.source_map.description = 'oembed'; }
          if (!parsed.og.image && oe.thumbnail_url) {
            parsed.og.image = oe.thumbnail_url; parsed.og.images.push(oe.thumbnail_url); parsed.source_map.image = 'oembed';
          }
          parsed.completeness = scoreCompleteness(parsed.og);
          parsed.richness = scoreRichness(parsed.og);
          return finalize(inputUrl, norm, staticRes, redirectChain, parsed, 'oembed', shortLinkCached, ctx, undefined, recovery);
        }
      } catch {
        /* oEmbed 실패 → 헤드리스 재평가로 낙하 */
      }
    }
    // oEmbed 실패 후 헤드리스 승격 재평가
    if (!shouldHeadlessAfterOembed(parsed.completeness, rule)) {
      return finalize(inputUrl, norm, staticRes, redirectChain, parsed, 'static', shortLinkCached, ctx, undefined, recovery);
    }
  }

  // ── Stage 3: Headless ──
  try {
    const hl = await renderer.render(staticRes.final_url, rule);
    if (hl.ok) {
      const hlParsed = extractOg(hl.dom_html, hl.final_url);
      // merge_fill: static 부분결과 위에 빈 필드 우선 덮기
      const merged: SourceMap = { ...hlParsed.source_map, ...parsed.source_map };
      const card = mergeFill(parsed.og, hlParsed.og);
      const completeness = scoreCompleteness(card);
      const richness = scoreRichness(card);
      const finalStatic: StaticFetchResult = { ...staticRes, final_url: hl.final_url };
      const hasMeta = parsed.has_meta || hlParsed.has_meta;
      const note: ErrorCode | undefined = hasMeta ? undefined : 'NO_OG_TAGS';
      return finalize(
        inputUrl, norm, finalStatic, redirectChain,
        { og: card, canonical_url: hlParsed.canonical_url ?? parsed.canonical_url, source_map: merged, completeness, richness },
        'headless', shortLinkCached, ctx, note, recovery,
      );
    }
  } catch (e) {
    // 헤드리스 실패해도 static 부분결과 보존, 완성도 낮게(§1.3 결과 보존)
    const note = e instanceof CrawlError && isKnownErrorCode(e.code) ? e.code : 'RENDER_CRASH';
    const doneNote: ErrorCode | undefined = parsed.has_meta ? note : 'NO_OG_TAGS';
    return finalize(inputUrl, norm, staticRes, redirectChain, parsed, 'static', shortLinkCached, ctx, doneNote, recovery);
  }

  const note: ErrorCode | undefined = parsed.has_meta ? undefined : 'NO_OG_TAGS';
  return finalize(inputUrl, norm, staticRes, redirectChain, parsed, 'static', shortLinkCached, ctx, note, recovery);
}

/** 빈 필드 우선 병합(static 부분결과 위에 headless 결과 덮기). */
function mergeFill(base: OgCard, over: OgCard): OgCard {
  const out: OgCard = { ...base };
  (['title', 'description', 'image', 'site_name', 'type', 'url', 'locale'] as const).forEach((k) => {
    if (!out[k] && over[k]) (out[k] as unknown) = over[k];
  });
  if (out.image_width == null && over.image_width != null) out.image_width = over.image_width;
  if (out.image_height == null && over.image_height != null) out.image_height = over.image_height;
  if (out.images.length === 0) out.images = over.images;
  return out;
}

/** finalize — FetchResult 조립 + completeness observe(§8). */
function finalize(
  inputUrl: string,
  norm: string,
  staticRes: StaticFetchResult,
  redirectChain: RedirectHop[],
  parsed: { og: OgCard; canonical_url: string | null; source_map: SourceMap; completeness: number; richness: number },
  strategy: FetchResult['fetch_strategy'],
  shortLinkCached: boolean,
  ctx: { trace: TraceContext; deps: { metrics: Metrics; store: CrawlStore } },
  note?: ErrorCode,
  recovery?: FetchResult['recovery'],
): FetchResult {
  const fatal = false;
  const status = statusOf(parsed.completeness, fatal);
  const result: FetchResult = {
    input_url: inputUrl,
    normalized_url: norm,
    final_url: staticRes.final_url,
    canonical_url: parsed.canonical_url ?? staticRes.final_url,
    redirect_chain: redirectChain,
    fetch_strategy: strategy,
    status,
    error_code: note ?? null,
    http_status: staticRes.http_status,
    content_type: staticRes.content_type,
    completeness: parsed.completeness,
    richness: parsed.richness,
    og: parsed.og,
    source_map: parsed.source_map,
    fetched_at: new Date().toISOString(),
    latency_ms: Date.now() - ctx.trace.started_at,
    cache: { short_link_cached: shortLinkCached },
    ...(note ? { note } : {}),
    ...(recovery ? { recovery } : {}),
  };
  ctx.deps.metrics.completeness(result.completeness, { strategy });
  return result;
}
