/**
 * test/decompress.test.ts — decompressCapped zip bomb 방어 단위 테스트 (node:test)
 *
 * 실행: npm run test:decompress   (tsx test/decompress.test.ts)
 *
 * 네트워크 불필요 — 순수 로직. 검증:
 *   1. gzip/br 압축 폭탄(작은 압축 → 대용량 팽창) → TOO_LARGE 로 차단.
 *   2. gzip/br/deflate/deflate-raw 정상 왕복 일치.
 *   3. encoding 미지정 → 입력 그대로 반환.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, brotliCompressSync, deflateSync, deflateRawSync } from 'node:zlib';
import { decompressCapped } from '../src/fetch/safe-fetch.js';
import { CrawlError } from '../src/errors/taxonomy.js';

const CAP = 2 * 1024 * 1024; // 2MB (CONFIG.MAX_BODY_BYTES 기본과 동일)

const isTooLarge = (e: unknown): e is CrawlError => e instanceof CrawlError && e.code === 'TOO_LARGE';

test('gzip zip bomb (8MB→작게 압축) → TOO_LARGE 차단', async () => {
  const bomb = gzipSync(Buffer.alloc(8 * 1024 * 1024, 0x41)); // 8MB 'A' → 수 KB
  assert.ok(bomb.length < CAP, '압축 본문은 cap 미만(압축 cap 통과함)');
  await assert.rejects(() => decompressCapped(bomb, 'gzip', CAP), isTooLarge);
});

test('brotli zip bomb → TOO_LARGE 차단', async () => {
  const bomb = brotliCompressSync(Buffer.alloc(8 * 1024 * 1024, 0x41));
  assert.ok(bomb.length < CAP, '압축 본문은 cap 미만');
  await assert.rejects(() => decompressCapped(bomb, 'br', CAP), isTooLarge);
});

test('gzip 정상 왕복', async () => {
  const html = '<html><head><meta property="og:title" content="X"></head></html>';
  const out = await decompressCapped(gzipSync(Buffer.from(html, 'utf-8')), 'gzip', CAP);
  assert.equal(out.toString('utf-8'), html);
});

test('brotli 정상 왕복', async () => {
  const out = await decompressCapped(brotliCompressSync(Buffer.from('hello brotli', 'utf-8')), 'br', CAP);
  assert.equal(out.toString('utf-8'), 'hello brotli');
});

test('deflate(zlib 헤더) 정상 왕복', async () => {
  const out = await decompressCapped(deflateSync(Buffer.from('hello deflate', 'utf-8')), 'deflate', CAP);
  assert.equal(out.toString('utf-8'), 'hello deflate');
});

test('deflate raw(headerless) 폴백 해제', async () => {
  const out = await decompressCapped(deflateRawSync(Buffer.from('hello raw deflate', 'utf-8')), 'deflate', CAP);
  assert.equal(out.toString('utf-8'), 'hello raw deflate');
});

test('encoding 미지정 → 입력 buffer 그대로', async () => {
  const raw = Buffer.from('plain body', 'utf-8');
  const out = await decompressCapped(raw, undefined, CAP);
  assert.equal(out, raw);
});

test('x-gzip 별칭도 해제', async () => {
  const out = await decompressCapped(gzipSync(Buffer.from('alias', 'utf-8')), 'x-gzip', CAP);
  assert.equal(out.toString('utf-8'), 'alias');
});
