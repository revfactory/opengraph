/**
 * url/tracking-params.ts — 트래킹 파라미터 차단리스트 (데이터로 관리, platform §3-1 3단계)
 *
 * platform §3-1: "허용리스트가 아닌 **차단리스트** 운영". 코드 배포 없이 갱신하려면
 * 실제 배포에선 이 목록을 domain_rules/config 스토어에서 hot-reload 하도록 승격한다(EXTENSION).
 * 여기선 참조용 시드 목록을 상수로 제공한다.
 */

/** 정확 일치 차단 키. */
export const TRACKING_PARAMS_EXACT: ReadonlySet<string> = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'igshid',
  'igsh',
  'ref',
  'ref_src',
  'ref_url',
  'mc_eid',
  'mc_cid',
  '_hsenc',
  '_hsmi',
  'hsctatracking',
  'spm',
  'yclid',
  'ysclid',
  'twclid',
  'ttclid',
  'oly_anon_id',
  'oly_enc_id',
  '_openstat',
  'wickedid',
  'scid',
  's_cid',
  'vero_id',
  'vero_conv',
]);

/** 접두사 차단 패턴(예: utm_*). */
export const TRACKING_PARAMS_PREFIX: readonly string[] = [
  'utm_', // utm_source/medium/campaign/term/content/id ...
  'pk_', // matomo/piwik
  'mtm_', // matomo
  'hsa_', // hubspot ads
  'gad_', // google ads
];

/** 키가 트래킹 파라미터인지 판정(대소문자 무시). */
export function isTrackingParam(key: string): boolean {
  const k = key.toLowerCase();
  if (TRACKING_PARAMS_EXACT.has(k)) return true;
  return TRACKING_PARAMS_PREFIX.some((p) => k.startsWith(p));
}
