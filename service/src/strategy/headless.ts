/**
 * strategy/headless.ts — Stage 3 헤드리스 렌더 (crawl §1.3)
 *
 * SPA 셸/JS 리다이렉트/force_headless/(정책)챌린지 신호일 때만 진입(§1.2). 그 외 금지.
 * 브라우저 프로세스 1개 상주 + 요청당 ephemeral context(격리), 리소스 차단, 세마포어 동시성 상한.
 *
 * 런타임 계약: Playwright(Chromium) — runtime-strategist §(b) 확정. 별도 워커 풀로 격리 권고.
 * 여기선 동적 import + graceful fallback: playwright 미설치 시 RENDER_CRASH를 던져
 *   orchestrator가 static 부분 결과를 보존(실패를 삼키지 않음, §1.3 결과 보존).
 *
 * 주변부 모듈이지만 렌더 파이프라인·대기 전략·풀 관리 골격은 실제 구현으로 제시.
 * EXTENSION: 서버리스/경량 런타임이면 원격 브라우저(browserless)로 분리(§경계면 d).
 */

import { CONFIG } from '../config.js';
import { CrawlError } from '../errors/taxonomy.js';
import type { DomainRule } from '../rules/domain-rules.js';

export interface HeadlessResult {
  ok: boolean;
  dom_html: string;
  final_url: string;
}

/** 동시성 세마포어 (crawl §1.3 MAX_HEADLESS_CONCURRENCY). */
class Semaphore {
  private permits: number;
  private queue: Array<() => void> = [];
  constructor(n: number) {
    this.permits = n;
  }
  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }
  release(): void {
    this.permits += 1;
    const next = this.queue.shift();
    if (next) {
      this.permits -= 1;
      next();
    }
  }
}

// 차단할 리소스 타입(DOM만 필요 → 페이지 로드 2–5배 가속, 대역폭 절감).
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font', 'stylesheet']);

/**
 * 브라우저 웜풀 래퍼. 프로세스 1개 상주, 요청마다 new context.
 * playwright 타입에 직접 의존하지 않도록 동적 import(선택 의존성).
 */
export class HeadlessRenderer {
  private browser: unknown = null;
  private launching: Promise<unknown> | null = null;
  private sem = new Semaphore(CONFIG.MAX_HEADLESS_CONCURRENCY);
  private available: boolean | null = null;

  /** playwright 가용성 1회 확인. */
  async isAvailable(): Promise<boolean> {
    if (this.available !== null) return this.available;
    try {
      await import('playwright');
      this.available = true;
    } catch {
      this.available = false;
    }
    return this.available;
  }

  private async ensureBrowser(): Promise<unknown> {
    if (this.browser) return this.browser;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      const pw = (await import('playwright')) as {
        chromium: { launch: (o: unknown) => Promise<unknown> };
      };
      this.browser = await pw.chromium.launch({ headless: true, args: ['--no-sandbox'] });
      this.launching = null;
      return this.browser;
    })();
    return this.launching;
  }

  /**
   * headless_render(url, rule) — crawl §1.3 렌더 파이프라인.
   * @throws {CrawlError} JS_TIMEOUT | RENDER_CRASH
   */
  async render(url: string, rule: DomainRule): Promise<HeadlessResult> {
    if (!(await this.isAvailable())) {
      // graceful fallback — 설치 안 됨. orchestrator가 static 부분결과 보존.
      throw new CrawlError('RENDER_CRASH', 'playwright not installed (optional dep)');
    }
    await this.sem.acquire();
    const navTimeout = rule.render_timeout_ms ?? CONFIG.HEADLESS_NAV_TIMEOUT_MS;
    let context: any = null;
    let page: any = null;
    try {
      const browser = (await this.ensureBrowser()) as any;
      context = await browser.newContext({
        userAgent: rule.ua_override ?? CONFIG.DEFAULT_UA,
        extraHTTPHeaders: rule.extra_headers ?? undefined,
      });
      page = await context.newPage();

      // 리소스 차단(DOM만 필요)
      await page.route('**/*', (route: any) => {
        const type = route.request().resourceType();
        if (BLOCKED_RESOURCE_TYPES.has(type)) return route.abort();
        return route.continue();
      });

      await page.goto(url, { waitUntil: 'commit', timeout: navTimeout });

      // 대기 전략(§1.3): wait_selector → og:title 출현 → domcontentloaded + settle
      if (rule.wait_selector) {
        await page.waitForSelector(rule.wait_selector, { timeout: navTimeout }).catch(() => {});
      } else {
        await page
          .waitForSelector('meta[property^="og:"]', { timeout: Math.min(3000, navTimeout) })
          .catch(() => {});
        await page.waitForTimeout(CONFIG.HEADLESS_SETTLE_MS);
      }

      // 인터스티셜 통과 클릭(선택)
      if (rule.click_selector) {
        await page.click(rule.click_selector, { timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(CONFIG.HEADLESS_SETTLE_MS);
      }

      const dom = await page.content();
      const finalUrl = page.url();
      return { ok: true, dom_html: dom, final_url: finalUrl };
    } catch (err) {
      const e = err as { name?: string; message?: string };
      if (e.name === 'TimeoutError' || (e.message ?? '').toLowerCase().includes('timeout')) {
        throw new CrawlError('JS_TIMEOUT', e.message, { cause: err });
      }
      throw new CrawlError('RENDER_CRASH', e.message, { cause: err });
    } finally {
      // context 파기(메모리 누수 방지) — 요청당 격리 파기.
      if (page) await page.close().catch(() => {});
      if (context) await context.close().catch(() => {});
      this.sem.release();
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await (this.browser as any).close().catch(() => {});
      this.browser = null;
    }
  }
}

/** 프로세스 단위 싱글턴(웜풀). */
export const headlessRenderer = new HeadlessRenderer();
