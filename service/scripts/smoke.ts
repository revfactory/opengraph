/**
 * scripts/smoke.ts — 무네트워크 스모크 (핵심 순수 로직 검증)
 *
 * 실행: npm run smoke  (npm install 후)
 * 네트워크/Redis/Postgres 없이 순수·결정적 로직만 검증한다:
 *   - normalize_url 8단계(트래킹 제거·쿼리 정렬·hashbang 보존·기본포트 제거)
 *   - SSRF IP 판정(사설/메타데이터/IPv4-매핑 v6)
 *   - extractOg 폴백·completeness·og:image 절대화
 *   - payload_key_of 우선순위(canonical ?? og:url ?? final)
 *   - 에러 taxonomy 매핑
 */

import assert from 'node:assert';
import { normalizeUrl } from '../src/url/normalize.js';
import { isBlockedIp } from '../src/fetch/ssrf-guard.js';
import { extractOg } from '../src/extract/extract-og.js';
import { payload_key_of, map_key } from '../src/cache/keys.js';
import { httpStatusToErrorCode, ERROR_META } from '../src/errors/taxonomy.js';
import { isBotBlock, recoveryUaCandidates } from '../src/strategy/bot-recovery.js';
import { DomainRuleStore, StaticSeedRuleProvider } from '../src/rules/domain-rules.js';

let passed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
async function acheck(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

console.log('normalize_url:');
check('lowercases scheme/host + strips default port', () => {
  assert.strictEqual(normalizeUrl('HTTP://Example.COM:80/Path'), 'http://example.com/Path');
});
check('removes tracking params + sorts query', () => {
  assert.strictEqual(
    normalizeUrl('https://e.com/a?utm_source=x&b=2&a=1&fbclid=z'),
    'https://e.com/a?a=1&b=2',
  );
});
check('drops fragment but preserves #! hashbang', () => {
  assert.strictEqual(normalizeUrl('https://e.com/p#section'), 'https://e.com/p');
  assert.strictEqual(normalizeUrl('https://e.com/p#!/route'), 'https://e.com/p#!/route');
});
check('collapses duplicate slashes + keeps trailing slash', () => {
  assert.strictEqual(normalizeUrl('https://e.com//a///b/'), 'https://e.com/a/b/');
});
check('IDN → punycode', () => {
  assert.ok(normalizeUrl('https://한글.com/').startsWith('https://xn--'));
});

console.log('ssrf-guard:');
check('blocks private/loopback/metadata IPs', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '169.254.169.254', '::1', 'fd00:ec2::254'])
    assert.ok(isBlockedIp(ip), `${ip} should be blocked`);
});
check('allows public IPs', () => {
  for (const ip of ['1.1.1.1', '93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'])
    assert.ok(!isBlockedIp(ip), `${ip} should be allowed`);
});
check('unmaps IPv4-mapped IPv6 and re-applies v4 rules', () => {
  assert.ok(isBlockedIp('::ffff:127.0.0.1'), 'mapped loopback should be blocked');
});

console.log('extractOg:');
check('extracts OG + completeness + absolutizes relative image', () => {
  const html = `<html><head>
    <meta property="og:title" content="Hello &amp; World">
    <meta property="og:description" content="desc">
    <meta property="og:image" content="/img/a.jpg">
    <link rel="canonical" href="https://cdn.example.com/article">
  </head><body></body></html>`;
  const r = extractOg(html, 'https://example.com/post/1');
  assert.strictEqual(r.og.title, 'Hello & World');
  assert.strictEqual(r.og.image, 'https://example.com/img/a.jpg');
  assert.strictEqual(r.canonical_url, 'https://cdn.example.com/article');
  assert.strictEqual(r.completeness, 1);
});
check('twitter fallback fills OG gaps', () => {
  const html = `<head><meta name="twitter:title" content="T"><meta name="twitter:image" content="https://x.com/i.png"></head>`;
  const r = extractOg(html, 'https://x.com/p');
  assert.strictEqual(r.og.title, 'T');
  assert.strictEqual(r.source_map.title, 'twitter');
  assert.ok(Math.abs(r.completeness - 0.7) < 1e-9); // title .4 + image .3
});

console.log('cache keys:');
check('payload_key_of prefers canonical then og:url then final', () => {
  assert.strictEqual(payload_key_of('https://c.com/a?utm_x=1', 'https://o.com/b', 'https://f.com/c'), 'https://c.com/a');
  assert.strictEqual(payload_key_of(null, 'https://o.com/b', 'https://f.com/c'), 'https://o.com/b');
  assert.strictEqual(payload_key_of(null, null, 'https://f.com/c'), 'https://f.com/c');
});
check('map_key is stable + versioned', () => {
  assert.ok(map_key('https://e.com/').startsWith('og:map:v1:'));
  assert.strictEqual(map_key('https://e.com/'), map_key('https://e.com/'));
});

console.log('taxonomy:');
check('4xx granular mapping (§1-1)', () => {
  assert.strictEqual(httpStatusToErrorCode(403), 'HTTP_403');
  assert.strictEqual(httpStatusToErrorCode(404), 'HTTP_404');
  assert.strictEqual(httpStatusToErrorCode(410), 'HTTP_410');
  assert.strictEqual(httpStatusToErrorCode(429), 'HTTP_429');
  assert.strictEqual(httpStatusToErrorCode(401), 'HTTP_4XX_OTHER');
  assert.strictEqual(httpStatusToErrorCode(451), 'HTTP_4XX_OTHER');
  assert.strictEqual(httpStatusToErrorCode(503), 'HTTP_5XX');
});
check('REDIRECT_LOOP separated from TOO_MANY_REDIRECTS', () => {
  assert.strictEqual(ERROR_META.REDIRECT_LOOP.stage, 'redirect');
  assert.strictEqual(ERROR_META.TOO_MANY_REDIRECTS.stage, 'redirect');
  assert.notStrictEqual(ERROR_META.REDIRECT_LOOP.code, ERROR_META.TOO_MANY_REDIRECTS.code);
});
check('HTTP_429 retryable w/ Retry-After; HTTP_403 permanent', () => {
  assert.strictEqual(ERROR_META.HTTP_429.retry.retryable, true);
  assert.strictEqual(ERROR_META.HTTP_429.retry.respectRetryAfter, true);
  assert.strictEqual(ERROR_META.HTTP_403.retry.retryable, false);
  assert.strictEqual(ERROR_META.HTTP_403.errorClass, 'permanent');
});

console.log('bot-recovery (403 → per-domain UA/헤드리스 전환):');
check('isBotBlock true only for 403 / BOT_CHALLENGE', () => {
  assert.ok(isBotBlock('HTTP_403'));
  assert.ok(isBotBlock('BOT_CHALLENGE'));
  assert.ok(!isBotBlock('HTTP_404'));
  assert.ok(!isBotBlock('DNS_FAIL'));
});
check('recoveryUaCandidates excludes already-tried UAs', () => {
  const all = recoveryUaCandidates([]);
  assert.ok(all.length >= 1, 'has candidates');
  const first = all[0]!;
  assert.ok(!recoveryUaCandidates([first]).includes(first), 'tried UA excluded');
});

// 규칙 학습(플라이휠 폐곡선): 회복으로 검증된 ua_override 가 다음 resolve 부터 적용된다.
await acheck('DomainRuleStore.learn overlays ua_override on next resolve', async () => {
  const store = new DomainRuleStore(new StaticSeedRuleProvider([]));
  const before = await store.resolve('news.example.com');
  assert.strictEqual(before.ua_override, null, 'no override before learning');
  store.learn('news.example.com', { ua_override: 'facebookexternalhit/1.1' }, '403 회복');
  const after = await store.resolve('news.example.com');
  assert.strictEqual(after.ua_override, 'facebookexternalhit/1.1', 'override applied after learning');
  assert.ok(after.version > before.version, 'version bumped (감사 추적)');
});

console.log(`\n${passed} checks passed.`);
