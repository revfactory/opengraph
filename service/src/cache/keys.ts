/**
 * cache/keys.ts — 캐시 key 함수 (platform §3-2·§(c) 명세 그대로, 통합 §3)
 *
 * 공유 유틸(단일 구현) — API 티어·크롤 워커·crawl-engine이 동일하게 사용.
 * 2단계 키(통합 §0 ④):
 *   매핑 캐시   og:map:v1:{sha(norm)}       → payload_key   (긴 TTL)
 *   payload 캐시 og:pl:v1:{sha(payload_key)}  → OG payload
 *   payload_key = normalize(canonical_url ?? og_url ?? final_url)
 *
 * 해시: sha256 앞 128비트 hex(32자) 고정 길이. 원본 norm 은 Postgres 컬럼 보존.
 * 버전 규약: 정규화/키 스킴 변경 시 v1→v2 접두사만 올려 무중단 점진 이행.
 *
 * QA 검증 포인트 #4: payload_key = normalize(canonical ?? og:url ?? final) 이 코드에 정확 반영.
 */

import { createHash } from 'node:crypto';
import { CONFIG } from '../config.js';
import { normalizeUrl } from '../url/normalize.js';

const V = CONFIG.KEY_SCHEME_VERSION; // 'v1'

/** sha256 앞 128비트 hex(32자). key 길이 고정. */
export function sha256_128(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 32);
}

/** 1차 매핑 key: norm → payload_key 저장 위치. */
export function map_key(norm: string): string {
  return `og:map:${V}:${sha256_128(norm)}`;
}

/**
 * payload_key 결정 — 페이지가 선언한 정체성이 최우선(platform §3-2).
 * canonical_url ?? og_url ?? final_url 를 normalize 한 값.
 */
export function payload_key_of(
  canonicalUrl: string | null | undefined,
  ogUrl: string | null | undefined,
  finalUrl: string,
): string {
  const chosen = canonicalUrl || ogUrl || finalUrl;
  try {
    return normalizeUrl(chosen);
  } catch {
    // canonical/og:url이 비정상이면 final_url로 폴백.
    return normalizeUrl(finalUrl);
  }
}

/** payload 캐시 key: payload_key(정규화 문자열) → 저장 위치. */
export function payload_key(pk: string): string {
  return `og:pl:${V}:${sha256_128(pk)}`;
}

/** negative 캐시 key(실패). */
export function neg_key(norm: string): string {
  return `og:neg:${V}:${sha256_128(norm)}`;
}

/** single-flight 락 key. */
export function lock_key(norm: string): string {
  return `og:lock:${V}:${sha256_128(norm)}`;
}

/** 단축링크 short→final 매핑 key(긴 TTL, platform §3-3 / crawl §2.2). */
export function short_map_key(norm: string): string {
  return `og:short:${V}:${sha256_128(norm)}`;
}
