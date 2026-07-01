/**
 * metrics/instrumentation.ts — 계측 (reliability-ops §3 카탈로그 / §8 계측 지점)
 *
 * 모든 크롤 경로에 error_code 분류 + 메트릭 훅을 남긴다. 벤더 중립(OpenTelemetry→Prometheus).
 * 여기선 Metrics 인터페이스 + 콘솔/노옵 구현. 실제 배포는 prom-client/otel로 교체(EXTENSION).
 *
 * 카디널리티 규율(§3): og_crawl_total 에 domain 라벨 **금지**. 도메인별 성공률은
 *   failed_crawls(SQL) 또는 recording rule top-N 으로만.
 *
 * §8 계측 지점:
 *   - 경계 1개 span/요청: trace_id 생성 → 모든 레코드/로그/메트릭에 전파.
 *   - crawl 반환 직후: 시도 이벤트 1건 emit(성공 포함 전량) + og_crawl_total + latency observe.
 *   - 실패 시: failed_crawls UPSERT.  재시도 시: og_retry_total.  규칙 적용 시: og_rule_apply_total.
 */

import { randomUUID } from 'node:crypto';
import type { CacheState, CrawlStatus, FetchStrategy } from '../types.js';
import type { ErrorCode } from '../errors/taxonomy.js';

export interface Metrics {
  /** og_crawl_total{status,error_code,strategy,cache} counter. domain 라벨 금지(§3). */
  crawlTotal(labels: {
    status: CrawlStatus;
    error_code: ErrorCode | 'none';
    strategy: FetchStrategy;
    cache: CacheState;
  }): void;
  /** og_crawl_latency_seconds{strategy,cache} histogram. */
  crawlLatency(seconds: number, labels: { strategy: FetchStrategy; cache: CacheState }): void;
  /** og_crawl_completeness{strategy} histogram. */
  completeness(value: number, labels: { strategy: FetchStrategy }): void;
  /** og_retry_total{error_code,outcome} counter. */
  retryTotal(labels: { error_code: ErrorCode; outcome: 'recovered' | 'exhausted' }): void;
  /** og_rule_apply_total{domain_bucket,field} counter. */
  ruleApply(labels: { domain_bucket: string; field: string }): void;
  /** og_dlq_depth{error_class} gauge. */
  dlqDepth(value: number, labels: { error_class: string }): void;
}

/** 콘솔 계측 — 개발/스모크용. 구조적 JSON 한 줄=한 이벤트(§8 로그 규약). */
export class ConsoleMetrics implements Metrics {
  constructor(private enabled = true) {}
  private emit(metric: string, value: number, labels: Record<string, string>): void {
    if (!this.enabled) return;
    process.stdout.write(JSON.stringify({ metric, value, labels, ts: Date.now() }) + '\n');
  }
  crawlTotal(l: Parameters<Metrics['crawlTotal']>[0]): void {
    this.emit('og_crawl_total', 1, l as unknown as Record<string, string>);
  }
  crawlLatency(s: number, l: { strategy: FetchStrategy; cache: CacheState }): void {
    this.emit('og_crawl_latency_seconds', s, l as unknown as Record<string, string>);
  }
  completeness(v: number, l: { strategy: FetchStrategy }): void {
    this.emit('og_crawl_completeness', v, l as unknown as Record<string, string>);
  }
  retryTotal(l: { error_code: ErrorCode; outcome: 'recovered' | 'exhausted' }): void {
    this.emit('og_retry_total', 1, l as unknown as Record<string, string>);
  }
  ruleApply(l: { domain_bucket: string; field: string }): void {
    this.emit('og_rule_apply_total', 1, l);
  }
  dlqDepth(v: number, l: { error_class: string }): void {
    this.emit('og_dlq_depth', v, l);
  }
}

export class NoopMetrics implements Metrics {
  crawlTotal(): void {}
  crawlLatency(): void {}
  completeness(): void {}
  retryTotal(): void {}
  ruleApply(): void {}
  dlqDepth(): void {}
}

/** 요청 상관관계 컨텍스트 — 경계 1개 span/요청(§8). */
export interface TraceContext {
  trace_id: string;
  started_at: number;
}
export function newTrace(): TraceContext {
  return { trace_id: randomUUID(), started_at: Date.now() };
}

/** 도메인 → 저카디널리티 버킷(규칙 적용 계측용, §3 카디널리티 규율). */
export function domainBucket(domain: string): string {
  // ASSUMPTION: top-N 도메인만 raw, 나머지는 'other'. 여기선 참조로 eTLD+1 첫 라벨 해시 버킷.
  const known = ['twitter.com', 'x.com', 'youtube.com', 'facebook.com', 'instagram.com'];
  return known.includes(domain) ? domain : 'other';
}
