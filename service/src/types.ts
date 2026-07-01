/**
 * types.ts — 팀 간 단일 진실 스키마 (crawl-engine §5 / §경계면(b))
 *
 * 이 타입들은 언어중립 계약(runtime-strategist §격리)을 TypeScript로 표현한 것이다.
 * - FetchResult: 크롤/추출 마이크로서비스의 표준 반환 스키마. platform(캐시 key)·reliability-ops(추적) 소비.
 * - 필드 이름/의미는 crawl-engine §5·§경계면(b) 그대로. 변경 제안은 그 문서로 역류.
 */

import type { ErrorCode } from './errors/taxonomy.js';

/** 공유 enum (§1-1). */
export type CrawlStatus = 'ok' | 'partial' | 'failed';
export type FetchStrategy = 'static' | 'oembed' | 'headless';
export type CacheState = 'hit' | 'miss' | 'stale' | 'negative';
export type HopType = 'http' | 'meta_refresh' | 'js' | 'cached';
export type SourceKind = 'og' | 'twitter' | 'oembed' | 'jsonld' | 'html';

export interface RedirectHop {
  url: string;
  status: number;
  location: string;
  hop_type: HopType;
}

/** 정규화된 OG 카드 (crawl §5 `og`). */
export interface OgCard {
  title: string | null;
  description: string | null;
  /** 대표 이미지(절대 URL, final_url 기준 절대화). */
  image: string | null;
  /** 다중 og:image 보존(대표=[0]). */
  images: string[];
  image_width: number | null;
  image_height: number | null;
  site_name: string | null;
  type: string | null;
  /** og:url (payload_key 2순위). */
  url: string | null;
  locale: string | null;
}

/** 필드별 출처(품질 디버깅/운영 분석용, crawl §5 source_map). */
export type SourceMap = Partial<Record<'title' | 'description' | 'image', SourceKind>>;

/**
 * 표준 페치 결과 스키마 (crawl §5 / §경계면(b)).
 * - normalized_url/final_url/canonical_url → 캐시 key 근거(platform).
 * - error_code/fetch_strategy/latency_ms/redirect_chain → 운영 메트릭 입력(reliability-ops).
 */
export interface FetchResult {
  input_url: string;
  /** §2.4/§3-1 정규화 결과(캐시 1차 key). 공유 순수 함수 산출. */
  normalized_url: string;
  /** 리다이렉트 종점 = 진실의 원천(파싱·SSRF 기준). */
  final_url: string;
  /** rel=canonical → og:url → final_url. */
  canonical_url: string;
  redirect_chain: RedirectHop[];
  fetch_strategy: FetchStrategy;
  status: CrawlStatus;
  error_code: ErrorCode | null;
  http_status: number | null;
  content_type: string | null;
  /** 0.40·title + 0.30·desc + 0.30·image (§3.2). */
  completeness: number;
  /** site_name/type 부가(계약 안정성 위해 completeness와 분리). */
  richness: number;
  og: OgCard;
  source_map: SourceMap;
  fetched_at: string; // ISO-8601
  latency_ms: number;
  cache: { short_link_cached: boolean };
  /** 헤드리스 실패 등 비치명 노트(부분 결과 보존 시 원인 코드). */
  note?: ErrorCode;
  /**
   * 봇 차단(403/challenge) 회복이 일어난 경우의 전환 기록.
   * via: 'ua_override'(프리뷰-봇 UA로 성공) | 'headless'(실브라우저 렌더로 성공).
   * learned: 이 도메인 규칙으로 학습되어 다음 요청부터 처음부터 적용되는지.
   */
  recovery?: { via: 'ua_override' | 'headless'; ua?: string; learned: boolean } | null;
}

/** static_fetch 원시 결과(safe-fetch → orchestrator 내부 전달). */
export interface StaticFetchResult {
  final_url: string;
  redirect_chain: RedirectHop[];
  http_status: number;
  content_type: string | null;
  charset: string | null;
  /** 디코드된 HTML/텍스트 본문. */
  body: string;
  /** raw 바이트 수(계측/디버깅). */
  body_bytes: number;
  /** §2.3 JS 리다이렉트 셸 신호. */
  js_redirect_signal: boolean;
  /** 핀된 IP(디버깅/감사). */
  pinned_ip: string;
  /** meta-refresh 소프트 리다이렉트를 이미 따라갔는지. */
  followed_meta_refresh: boolean;
}

/** extract-og 결과. */
export interface OgExtraction {
  og: OgCard;
  canonical_url: string | null;
  source_map: SourceMap;
  completeness: number;
  richness: number;
  /** HTML에 OG/폴백 메타가 하나라도 있었는지(NO_OG_TAGS 판정). */
  has_meta: boolean;
  /** SPA 셸/JS 리다이렉트 등 승격 신호(strategy 입력). */
  content_is_html: boolean;
}

/** API 동기 응답 봉투(platform §2-2). */
export interface UnfurlEnvelope {
  data: {
    title: string | null;
    description: string | null;
    image: string | null;
    site_name: string | null;
    type: string | null;
    url: string | null;
  } | null;
  meta: {
    cache: CacheState;
    completeness: 'full' | 'partial';
    fetch_strategy: FetchStrategy;
    final_url: string;
    canonical_url: string;
    fetched_at: string;
    ttl_seconds: number;
  } | null;
  error: { code: ErrorCode; message: string } | null;
  /**
   * `?debug=true` 일 때만 채워지는 진단/플레이그라운드용 원시 필드.
   * 프로덕션 기본 응답에는 미포함(계약 안정성). 실패/성공 모두에 대해 채운다.
   */
  debug?: {
    status: CrawlStatus;
    completeness_score: number;
    richness: number;
    latency_ms: number;
    http_status: number | null;
    content_type: string | null;
    redirect_chain: RedirectHop[];
    source_map: SourceMap;
    error_code: ErrorCode | null;
    note: ErrorCode | null;
    short_link_cached: boolean;
    images: string[];
    input_url: string;
    normalized_url: string;
    recovery: { via: 'ua_override' | 'headless'; ua?: string; learned: boolean } | null;
  } | null;
}
