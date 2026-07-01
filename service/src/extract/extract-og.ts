/**
 * extract/extract-og.ts — 폴백 추출 + 완성도 점수 (crawl §3)
 *
 * 우선순위(위에서부터 채우고, 이미 채워졌으면 덮지 않음):
 *   1 Open Graph  2 Twitter Card  3 oEmbed(Stage2에서 merge_fill)  4 JSON-LD  5 HTML 기본
 *
 * 규약:
 *   - 필드별 독립 채움(title은 OG, image는 Twitter 혼합 허용) — 각 필드 첫 유효값.
 *   - og:image 등 상대/프로토콜-상대 URL은 **final_url 기준 절대화**. 다중 og:image 배열 보존(대표=[0]).
 *   - canonical_url = <link rel=canonical> → og:url → final_url.
 *   - completeness = 0.40·title + 0.30·desc + 0.30·image (§3.2, §1-4: ok ⟺ ≥0.66).
 *   - richness = site_name/type 각 +0.05 (completeness와 분리해 계약 안정성 확보).
 *
 * 라이브러리: cheerio(runtime-strategist §(b) 확정 — htmlparser2 엔진, 관대한 파싱 + 셀렉터).
 * (metascraper 룰 엔진을 이 위에 얹어 폴백 커버리지를 확장할 수 있음 — ADR/EXTENSION 참조.)
 */

import * as cheerio from 'cheerio';
import { CONFIG } from '../config.js';
import { CrawlError } from '../errors/taxonomy.js';
import type { OgCard, OgExtraction, SourceKind, SourceMap } from '../types.js';
import { absolutize } from '../url/normalize.js';

function emptyCard(): OgCard {
  return {
    title: null,
    description: null,
    image: null,
    images: [],
    image_width: null,
    image_height: null,
    site_name: null,
    type: null,
    url: null,
    locale: null,
  };
}

/** 공백 정리 + 엔티티는 파서가 이미 디코드. */
function clean(v: string | undefined | null, max?: number): string | null {
  if (v == null) return null;
  const t = v.replace(/\s+/g, ' ').trim();
  if (t === '') return null;
  if (max && t.length > max) return t.slice(0, max);
  return t;
}

/** 유효 값 판정(플레이스홀더/공백 제외). */
function has(v: string | null): boolean {
  return v != null && v.trim() !== '';
}

/** 이미지 URL 검증 — http/https + 명백한 비이미지 배제(crawl §3.2). */
function looksLikeImage(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    // 명백한 비이미지 확장자 배제(확장자 없으면 통과 — content-type 검증은 옵션)
    if (/\.(html?|json|xml|pdf|js|css)$/i.test(u.pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

/** 첫 유효값만 채우고 source 기록. */
function fill(
  card: OgCard,
  smap: SourceMap,
  field: 'title' | 'description' | 'image',
  value: string | null,
  source: SourceKind,
): void {
  if (has(card[field] as string | null)) return;
  const c = clean(value, field === 'title' ? CONFIG.TITLE_MAX : field === 'description' ? CONFIG.DESC_MAX : undefined);
  if (!has(c)) return;
  (card[field] as string | null) = c;
  smap[field] = source;
}

/**
 * extractMetadata(html, finalUrl) — 폴백 파서.
 * @param finalUrl 리다이렉트 종점(진실의 원천). 상대 URL 절대화·canonical 폴백 기준.
 * @throws {CrawlError} PARSE_ERROR — 파서가 처리 불가한 입력.
 */
export function extractOg(html: string, finalUrl: string): OgExtraction {
  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(html);
  } catch (err) {
    throw new CrawlError('PARSE_ERROR', (err as Error)?.message, { cause: err });
  }

  const card = emptyCard();
  const smap: SourceMap = {};
  let sawMeta = false;

  const meta = (sel: string): string | null => {
    const el = $(sel).first();
    if (el.length === 0) return null;
    return el.attr('content') ?? null;
  };
  const metaAll = (sel: string): string[] =>
    $(sel)
      .map((_, el) => $(el).attr('content'))
      .get()
      .filter((v): v is string => typeof v === 'string' && v.trim() !== '');

  // ── 1) Open Graph ──
  const ogTitle = meta('meta[property="og:title"]');
  const ogDesc = meta('meta[property="og:description"]');
  const ogImages = metaAll('meta[property="og:image"], meta[property="og:image:url"], meta[property="og:image:secure_url"]');
  const ogUrl = meta('meta[property="og:url"]');
  const ogType = meta('meta[property="og:type"]');
  const ogSite = meta('meta[property="og:site_name"]');
  const ogLocale = meta('meta[property="og:locale"]');
  const ogW = meta('meta[property="og:image:width"]');
  const ogH = meta('meta[property="og:image:height"]');
  if (ogTitle || ogDesc || ogImages.length || ogUrl || ogType || ogSite) sawMeta = true;

  fill(card, smap, 'title', ogTitle, 'og');
  fill(card, smap, 'description', ogDesc, 'og');
  card.url = clean(ogUrl);
  card.type = clean(ogType);
  card.site_name = clean(ogSite);
  card.locale = clean(ogLocale);
  if (ogW && Number.isFinite(Number(ogW))) card.image_width = Number(ogW);
  if (ogH && Number.isFinite(Number(ogH))) card.image_height = Number(ogH);
  // 다중 og:image 절대화 + 검증 → images 배열, 대표=[0]
  for (const img of ogImages) {
    const abs = absolutize(img.trim(), finalUrl);
    if (looksLikeImage(abs) && !card.images.includes(abs)) card.images.push(abs);
  }
  if (card.images.length && !has(card.image)) {
    card.image = card.images[0]!;
    smap.image = 'og';
  }

  // ── 2) Twitter Card (OG 공백 보완) ──
  const twTitle = meta('meta[name="twitter:title"]');
  const twDesc = meta('meta[name="twitter:description"]');
  const twImage =
    meta('meta[name="twitter:image"]') ?? meta('meta[name="twitter:image:src"]');
  const twSite = meta('meta[name="twitter:site"]');
  if (twTitle || twDesc || twImage) sawMeta = true;

  fill(card, smap, 'title', twTitle, 'twitter');
  fill(card, smap, 'description', twDesc, 'twitter');
  if (!has(card.image) && twImage) {
    const abs = absolutize(twImage.trim(), finalUrl);
    if (looksLikeImage(abs)) {
      card.image = abs;
      card.images.push(abs);
      smap.image = 'twitter';
    }
  }
  if (!card.site_name) card.site_name = clean(twSite);

  // ── 4) JSON-LD / microdata (schema.org) ──
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    if (!raw.trim()) return;
    try {
      const json = JSON.parse(raw);
      const nodes = flattenJsonLd(json);
      for (const node of nodes) {
        if (typeof node !== 'object' || node === null) continue;
        sawMeta = true;
        const n = node as Record<string, unknown>;
        fill(card, smap, 'title', asStr(n.headline) ?? asStr(n.name), 'jsonld');
        fill(card, smap, 'description', asStr(n.description), 'jsonld');
        const img = jsonLdImage(n.image);
        if (img && !has(card.image)) {
          const abs = absolutize(img, finalUrl);
          if (looksLikeImage(abs)) {
            card.image = abs;
            card.images.push(abs);
            smap.image = 'jsonld';
          }
        }
      }
    } catch {
      /* 개별 JSON-LD 블록 파싱 실패는 무시(다른 소스로 폴백) */
    }
  });

  // ── 5) HTML 기본 (최후 폴백) ──
  fill(card, smap, 'title', $('title').first().text(), 'html');
  fill(card, smap, 'description', meta('meta[name="description"]'), 'html');
  if (!has(card.image)) {
    // 본문 대표 이미지 후보(면적 힌트 없으면 첫 유효 이미지) + apple-touch-icon 폴백
    const candidate =
      $('article img, main img, img').first().attr('src') ??
      $('link[rel="apple-touch-icon"]').first().attr('href') ??
      $('link[rel="icon"]').first().attr('href');
    if (candidate) {
      const abs = absolutize(candidate.trim(), finalUrl);
      if (looksLikeImage(abs)) {
        card.image = abs;
        card.images.push(abs);
        smap.image = 'html';
      }
    }
  }

  // canonical_url = rel=canonical → og:url → final_url
  const relCanonical = $('link[rel="canonical"]').first().attr('href');
  const canonical =
    (relCanonical && absolutize(relCanonical.trim(), finalUrl)) ||
    (card.url && absolutize(card.url, finalUrl)) ||
    finalUrl;

  // <html lang> 폴백(표시 품질용)
  if (!card.locale) card.locale = clean($('html').attr('lang'));

  const completeness = scoreCompleteness(card);
  const richness = scoreRichness(card);

  return {
    og: card,
    canonical_url: canonical,
    source_map: smap,
    completeness,
    richness,
    has_meta: sawMeta,
    content_is_html: true,
  };
}

/** completeness = 0.40·title + 0.30·desc + 0.30·image (§3.2). */
export function scoreCompleteness(card: OgCard): number {
  let s = 0;
  if (has(card.title)) s += 0.4;
  if (has(card.description)) s += 0.3;
  if (has(card.image)) s += 0.3;
  return Math.round(s * 100) / 100;
}

/** richness = site_name/type 각 +0.05 (캡 없이 별도 보고). */
export function scoreRichness(card: OgCard): number {
  let s = 0;
  if (has(card.site_name)) s += 0.05;
  if (has(card.type)) s += 0.05;
  return Math.round(s * 100) / 100;
}

// ── JSON-LD 헬퍼 ──
function flattenJsonLd(json: unknown): unknown[] {
  if (Array.isArray(json)) return json.flatMap(flattenJsonLd);
  if (json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    if (Array.isArray(o['@graph'])) return (o['@graph'] as unknown[]).flatMap(flattenJsonLd);
    return [json];
  }
  return [];
}
function asStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function jsonLdImage(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.length) return jsonLdImage(v[0]);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return asStr(o.url) ?? asStr(o['@id']);
  }
  return null;
}
