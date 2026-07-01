/**
 * rules/domain-rules.ts — per-domain 규칙 (통합 §1-2 [DRIFT 해소] 확정 스키마)
 *
 * 확정 스키마(§1-2): crawl-engine 소비 · platform TTL 소비 · reliability-ops 생산.
 * 세 문서가 갈렸던 필드명을 아래로 통일:
 *   force_headless(엔진 소비, platform 'force_strategy'는 이 값으로 매핑)
 *   extra_headers(구 headers_override 통합)
 *   rate_limit_rps(구 rate_limit{rps,burst}의 rps; burst는 extra_headers로)
 *   ttl_override_sec(platform 캐시 TTL 소비, 구 default_ttl_seconds)
 *
 * hot-reload: crawl 워커는 domain_rules를 인메모리(TTL 30–60s)로 들고 최대 1분 내 반영
 * (reliability-ops §6.2). 여기선 provider 인터페이스 + 인메모리 캐시 스텁.
 *
 * QA 검증 포인트 #2: 3자가 동일 필드명을 쓰는지 — 이 타입이 그 단일 소스.
 */

import type { ErrorCode } from '../errors/taxonomy.js';

/** §1-2 확정 domain_rules 스키마(코드 표현). DB 컬럼과 1:1. */
export interface DomainRule {
  domain: string; // final_url 기준 eTLD+1 (PK)
  force_headless: boolean; // 승격표 4번 — static 건너뛰고 즉시 헤드리스
  is_short_link: boolean; // 단축링크 완전해석 + short_map 캐시
  ua_override: string | null;
  extra_headers: Record<string, string> | null; // 구 headers_override 통합(burst 등도 여기)
  extra_cookies: Record<string, string> | null;
  wait_selector: string | null;
  click_selector: string | null; // 인터스티셜 통과 클릭(lnkd.in 류)
  render_timeout_ms: number | null;
  rate_limit_rps: number | null;
  max_redirects: number | null;
  body_byte_cap: number | null;
  robots_mode: 'respect' | 'ignore';
  allow_headless_on_challenge: boolean;
  oembed_endpoint: string | null;
  ttl_override_sec: number | null; // platform 캐시 TTL 소비
  enabled: boolean;
  version: number; // 변경 시 ++, crawl_attempts.rule_version에 스탬프
}

/** 규칙 미지정 도메인의 기본값(전역 기본으로 낙하). */
export const DEFAULT_DOMAIN_RULE: DomainRule = {
  domain: '*',
  force_headless: false,
  is_short_link: false,
  ua_override: null,
  extra_headers: null,
  extra_cookies: null,
  wait_selector: null,
  click_selector: null,
  render_timeout_ms: null,
  rate_limit_rps: null,
  max_redirects: null,
  body_byte_cap: null,
  robots_mode: 'respect',
  allow_headless_on_challenge: false,
  oembed_endpoint: null,
  ttl_override_sec: null,
  enabled: true,
  version: 0,
};

/** 규칙 원본 저장소 provider — 프로덕션은 Postgres domain_rules 를 읽는다(persistence 스텁). */
export interface DomainRuleProvider {
  /** 전체 규칙 스냅샷 로드(hot-reload 주기 호출). */
  loadAll(): Promise<DomainRule[]>;
}

/**
 * 인메모리 hot-reload 캐시 (reliability-ops §6.2).
 * TTL 만료 시 provider.loadAll()로 재적재. 즉시성이 필요하면 Redis pub/sub 무효화(EXTENSION).
 */
export interface LearnedPatch {
  patch: Partial<DomainRule>;
  reason: string;
  version: number;
}

/** 규칙 학습(자동 제안) 알림 — 감사/메트릭용(reliability-ops A5/§5-3). */
export type RuleLearnSink = (e: {
  domain: string;
  patch: Partial<DomainRule>;
  reason: string;
  version: number;
}) => void;

export class DomainRuleStore {
  private byDomain = new Map<string, DomainRule>();
  /**
   * 런타임 학습 오버레이(봇 차단 회복 등에서 검증된 규칙). provider 재적재로 지워지지 않고
   * resolve() 시 base 위에 병합된다 → "per-domain UA 오버라이드/헤드리스 규칙으로 전환"의
   * 플라이휠 폐곡선(다음 요청부터 처음부터 적용). 프로덕션은 canary→measure 후 Postgres
   * domain_rules 로 승격(reliability-ops §6.3). 여기선 인메모리 즉시 반영.
   */
  private learned = new Map<string, LearnedPatch>();
  private loadedAt = 0;
  private loading: Promise<void> | null = null;

  constructor(
    private provider: DomainRuleProvider,
    private ttlMs = 45_000, // 30–60s 창(§6.2)
    private onLearn?: RuleLearnSink,
  ) {}

  /**
   * 검증된 규칙을 학습(즉시 반영). 봇 차단 회복이 특정 UA/헤드리스로 성공했을 때 호출.
   * 다음 요청부터 resolve() 가 이 패치를 base 규칙 위에 병합해 처음부터 적용한다.
   */
  learn(domain: string, patch: Partial<DomainRule>, reason: string): void {
    const d = domain.replace(/\.+$/, '').toLowerCase();
    if (!d) return;
    const prev = this.learned.get(d);
    const merged: Partial<DomainRule> = { ...(prev?.patch ?? {}), ...patch };
    const version = (prev?.version ?? 0) + 1;
    this.learned.set(d, { patch: merged, reason, version });
    this.onLearn?.({ domain: d, patch, reason, version });
  }

  /** 현재 학습된 오버레이(디버깅/감사용). */
  learnedFor(domain: string): LearnedPatch | undefined {
    return this.learned.get(domain.replace(/\.+$/, '').toLowerCase());
  }

  private async ensureFresh(): Promise<void> {
    if (Date.now() - this.loadedAt < this.ttlMs) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const rules = await this.provider.loadAll();
        const next = new Map<string, DomainRule>();
        for (const r of rules) if (r.enabled) next.set(r.domain.toLowerCase(), r);
        this.byDomain = next;
        this.loadedAt = Date.now();
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  /**
   * resolve_domain_rule(host) — crawl §경계면(c): 정확 호스트 → 상위 도메인 → 기본값.
   */
  async resolve(host: string): Promise<DomainRule> {
    await this.ensureFresh();
    const h = host.replace(/\.+$/, '').toLowerCase();

    // base 규칙 선정: 정확 호스트 → 상위 도메인 → 기본값
    let base: DomainRule | undefined = this.byDomain.get(h);
    if (!base) {
      const labels = h.split('.');
      for (let i = 1; i < labels.length - 1; i++) {
        const parent = labels.slice(i).join('.');
        const hit = this.byDomain.get(parent);
        if (hit) {
          base = hit;
          break;
        }
      }
    }
    if (!base) base = { ...DEFAULT_DOMAIN_RULE, domain: h };

    // 학습 오버레이 병합(회복으로 검증된 규칙을 처음부터 적용) — 정확 호스트 → 부모 순.
    const learned = this.learned.get(h) ?? this.learnedForParent(h);
    if (learned) {
      return { ...base, ...learned.patch, version: base.version + learned.version };
    }
    return base;
  }

  private learnedForParent(h: string): LearnedPatch | undefined {
    const labels = h.split('.');
    for (let i = 1; i < labels.length - 1; i++) {
      const parent = labels.slice(i).join('.');
      const hit = this.learned.get(parent);
      if (hit) return hit;
    }
    return undefined;
  }
}

/**
 * 정적 시드 provider (개발/스모크용). 프로덕션은 Postgres provider로 교체.
 * 예시: reliability-ops §6.1 twitter.com 레코드.
 */
export class StaticSeedRuleProvider implements DomainRuleProvider {
  constructor(private seed: Partial<DomainRule>[] = SEED_RULES) {}
  async loadAll(): Promise<DomainRule[]> {
    return this.seed.map((s) => ({ ...DEFAULT_DOMAIN_RULE, ...s })) as DomainRule[];
  }
}

/** 참조 시드(진단 5-2 처방 예시). */
export const SEED_RULES: Partial<DomainRule>[] = [
  {
    domain: 'twitter.com',
    ua_override: 'Mozilla/5.0 (compatible; facebookexternalhit/1.1)',
    extra_headers: { 'Accept-Language': 'en' },
    wait_selector: "meta[property='og:title']",
    rate_limit_rps: 2,
    oembed_endpoint: 'https://publish.twitter.com/oembed',
    ttl_override_sec: 86_400,
    version: 7,
  },
  { domain: 'bit.ly', is_short_link: true, version: 1 },
  { domain: 't.co', is_short_link: true, allow_headless_on_challenge: true, version: 1 },
  { domain: 'lnkd.in', is_short_link: true, click_selector: 'a.external-link', version: 1 },
];

/** 규칙 적용 시 계측용 — 어떤 필드가 실제로 레버로 쓰였는지(og_rule_apply_total). */
export function appliedRuleFields(rule: DomainRule): string[] {
  const fields: string[] = [];
  if (rule.force_headless) fields.push('force_headless');
  if (rule.ua_override) fields.push('ua_override');
  if (rule.extra_headers) fields.push('extra_headers');
  if (rule.wait_selector) fields.push('wait_selector');
  if (rule.rate_limit_rps != null) fields.push('rate_limit_rps');
  if (rule.oembed_endpoint) fields.push('oembed_endpoint');
  if (rule.ttl_override_sec != null) fields.push('ttl_override_sec');
  return fields;
}

/** 에러 코드가 이 규칙으로 고칠 수 있는 레버를 가졌는지(백필 후보 판정, reliability-ops §7.3). */
export function hasLeverFor(_code: ErrorCode): boolean {
  // 참조: 실제 레버 매핑은 reliability-ops §5-2 패턴 사전. 여기선 존재만 표시.
  return true;
}
