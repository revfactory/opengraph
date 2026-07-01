/**
 * fetch/ssrf-guard.ts — SSRF 방어 (crawl §4.1, 협상 불가 항목)
 *
 * 크롤러는 임의 URL을 받는 SSRF의 온상이다. 이 모듈은:
 *   1. 스킴 허용목록(http/https)                                 → SCHEME_BLOCKED
 *   2. 포트 허용목록(80/443/8080/8443)                          → PORT_BLOCKED
 *   3. **DNS 해석 후 실제 IP** 로 사설/메타데이터/링크로컬 차단   → SSRF_BLOCKED
 *   4. 검증에 쓴 IP를 **핀(pin)** 하여 그 IP로 직접 커넥트       → 리바인딩(TOCTOU) 방지
 *   5. 리다이렉트 홉마다 재검증(safe-fetch가 홉마다 호출)        → 가장 흔한 우회 차단
 *
 * v4/v6 CIDR 매칭은 self-contained BigInt 구현(참조성). 프로덕션 하드닝 시
 * `ipaddr.js`/`ip-address` 같은 검증된 라이브러리로 대체 가능(EXTENSION).
 *
 * QA 검증 포인트 #5: DNS 해석 후 + 리다이렉트 홉마다 검증 + IP 핀.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { CONFIG } from '../config.js';
import type { ErrorCode } from '../errors/taxonomy.js';

export interface SsrfVerdict {
  blocked: boolean;
  errorCode?: Extract<ErrorCode, 'SSRF_BLOCKED' | 'SCHEME_BLOCKED' | 'PORT_BLOCKED' | 'DNS_FAIL' | 'INVALID_URL'>;
  /** 검증 통과 시 커넥트에 핀할 IP(리터럴). */
  pinnedIp?: string;
  ipFamily?: 4 | 6;
  host?: string;
  reason?: string;
}

// ── 차단 CIDR 목록 (crawl §4.1) ───────────────────────────────────────────────
const BLOCKED_V4_CIDRS: readonly string[] = [
  '0.0.0.0/8', // 현재 네트워크
  '10.0.0.0/8', // 사설 A
  '100.64.0.0/10', // CGNAT
  '127.0.0.0/8', // 루프백
  '169.254.0.0/16', // 링크로컬(클라우드 메타데이터 포함: 169.254.169.254)
  '172.16.0.0/12', // 사설 B
  '192.0.0.0/24', // IETF 프로토콜 할당
  '192.0.2.0/24', // 문서용 TEST-NET-1
  '192.168.0.0/16', // 사설 C
  '198.18.0.0/15', // 벤치마크
  '198.51.100.0/24', // 문서용 TEST-NET-2
  '203.0.113.0/24', // 문서용 TEST-NET-3
  '224.0.0.0/4', // 멀티캐스트
  '240.0.0.0/4', // 예약(브로드캐스트 255.255.255.255 포함)
];

const BLOCKED_V6_CIDRS: readonly string[] = [
  '::1/128', // 루프백
  '::/128', // 미지정
  '::ffff:0:0/96', // IPv4-매핑 → 언매핑 후 v4 규칙 재적용(아래서 별도 처리)
  '64:ff9b::/96', // NAT64
  '100::/64', // 디스카드
  '2001:db8::/32', // 문서용
  'fc00::/7', // ULA(fd00:ec2::254 AWS IMDS 포함)
  'fe80::/10', // 링크로컬
  'ff00::/8', // 멀티캐스트
];

/** 호스트명 기반 차단(도메인/IP 양쪽 차단, crawl §4.1 클라우드 메타데이터). */
const BLOCKED_HOSTNAMES: ReadonlySet<string> = new Set([
  'metadata.google.internal',
  'metadata.goog',
]);
/** 리터럴 IP 기반 명시 차단(CIDR로도 대부분 잡히지만 방어적 이중화). */
const BLOCKED_IP_LITERALS: ReadonlySet<string> = new Set([
  '169.254.169.254', // AWS/GCP/Azure IMDS
  '100.100.100.200', // Alibaba
  'fd00:ec2::254', // AWS IMDSv2 v6
]);

// ── CIDR 매칭 (BigInt) ────────────────────────────────────────────────────────
/** IPv4 리터럴 → 32bit BigInt. 유효하지 않으면 null. */
function ipv4ToBig(ip: string): bigint | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let v = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    v = (v << 8n) | BigInt(n);
  }
  return v;
}

/** IPv6 리터럴 → 128bit BigInt. `::` 축약 및 임베디드 IPv4(::ffff:1.2.3.4) 처리. */
function ipv6ToBig(ip: string): bigint | null {
  let s = ip;
  // zone id(%eth0) 제거
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct);

  // 임베디드 IPv4 → 두 개의 16비트 그룹으로 변환
  const lastColon = s.lastIndexOf(':');
  if (s.includes('.') && lastColon >= 0) {
    const v4 = s.slice(lastColon + 1);
    const b = ipv4ToBig(v4);
    if (b === null) return null;
    const hi = (b >> 16n) & 0xffffn;
    const lo = b & 0xffffn;
    s = s.slice(0, lastColon + 1) + hi.toString(16) + ':' + lo.toString(16);
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - (head.length + tail.length);
  if (halves.length === 1) {
    if (head.length !== 8) return null;
  } else if (missing < 0) {
    return null;
  }
  const groups: string[] = [
    ...head,
    ...Array<string>(halves.length === 2 ? missing : 0).fill('0'),
    ...tail,
  ];
  if (groups.length !== 8) return null;
  let v = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    v = (v << 16n) | BigInt(parseInt(g, 16));
  }
  return v;
}

interface ParsedCidr {
  network: bigint;
  prefix: number;
  bits: 32 | 128;
}
function parseCidr(cidr: string): ParsedCidr | null {
  const [addr, lenStr] = cidr.split('/');
  if (!addr || lenStr === undefined) return null;
  const prefix = Number(lenStr);
  if (addr.includes(':')) {
    const network = ipv6ToBig(addr);
    if (network === null || prefix < 0 || prefix > 128) return null;
    return { network, prefix, bits: 128 };
  }
  const network = ipv4ToBig(addr);
  if (network === null || prefix < 0 || prefix > 32) return null;
  return { network, prefix, bits: 32 };
}

function inCidr(ipBig: bigint, cidr: ParsedCidr): boolean {
  const hostBits = BigInt(cidr.bits - cidr.prefix);
  if (hostBits < 0n) return false;
  // mask = all-ones << hostBits, 폭 제한
  const full = (1n << BigInt(cidr.bits)) - 1n;
  const mask = (full << hostBits) & full;
  return (ipBig & mask) === (cidr.network & mask);
}

const PARSED_V4 = BLOCKED_V4_CIDRS.map(parseCidr).filter((c): c is ParsedCidr => c !== null);
const PARSED_V6 = BLOCKED_V6_CIDRS.map(parseCidr).filter((c): c is ParsedCidr => c !== null);

/** IPv4-매핑 v6(::ffff:a.b.c.d)에서 v4 부분 추출. 매핑이 아니면 null. */
function unmapV4(v6: bigint): bigint | null {
  // ::ffff:0:0/96 → 상위 80비트 0, 다음 16비트 0xffff
  const top80 = v6 >> 48n;
  if (top80 === 0xffffn) {
    return v6 & 0xffffffffn; // 하위 32비트 = v4
  }
  return null;
}

/**
 * 리터럴 IP가 차단 대역인지 판정. 호스트명이 아니라 **해석된 IP** 를 받는다.
 * @param family net.isIP 결과(4|6). 0이면 리터럴 아님 → 호출부 오류.
 */
export function isBlockedIp(ip: string): boolean {
  if (BLOCKED_IP_LITERALS.has(ip.toLowerCase())) return true;
  const fam = isIP(ip);
  if (fam === 4) {
    const b = ipv4ToBig(ip);
    if (b === null) return true; // 파싱 실패 → 보수적 차단
    return PARSED_V4.some((c) => inCidr(b, c));
  }
  if (fam === 6) {
    const b = ipv6ToBig(ip);
    if (b === null) return true;
    // IPv4-매핑이면 언매핑해 v4 규칙 재적용(crawl §4.1)
    const v4 = unmapV4(b);
    if (v4 !== null && PARSED_V4.some((c) => inCidr(v4, c))) return true;
    return PARSED_V6.some((c) => inCidr(b, c));
  }
  return true; // 알 수 없는 형식 → 차단
}

/**
 * ssrf_precheck(url) — crawl §4.1/§0. 스킴·포트 검사 → DNS 해석 → IP 차단 검사 → IP 핀.
 * 리다이렉트 홉마다 safe-fetch가 이 함수를 호출한다.
 */
export async function ssrfPrecheck(rawUrl: string): Promise<SsrfVerdict> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { blocked: true, errorCode: 'INVALID_URL', reason: 'unparseable' };
  }

  const scheme = u.protocol.replace(/:$/, '').toLowerCase();
  if (!CONFIG.ALLOWED_SCHEMES.includes(scheme)) {
    return { blocked: true, errorCode: 'SCHEME_BLOCKED', reason: `scheme ${scheme}` };
  }

  const host = u.hostname.replace(/\.+$/, '').toLowerCase();

  // 포트 허용목록 (기본 포트는 스킴별로 환산)
  const port = u.port ? Number(u.port) : scheme === 'https' ? 443 : 80;
  if (!CONFIG.ALLOWED_PORTS.includes(port)) {
    return { blocked: true, errorCode: 'PORT_BLOCKED', host, reason: `port ${port}` };
  }

  // 호스트명 기반 메타데이터 차단(해석 전 1차)
  if (BLOCKED_HOSTNAMES.has(host)) {
    return { blocked: true, errorCode: 'SSRF_BLOCKED', host, reason: 'metadata hostname' };
  }

  // 리터럴 IP 입력이면 즉시 검증(해석 불필요) + 핀
  const litFam = isIP(host);
  if (litFam !== 0) {
    if (isBlockedIp(host)) {
      return { blocked: true, errorCode: 'SSRF_BLOCKED', host, reason: 'blocked ip literal' };
    }
    return { blocked: false, pinnedIp: host, ipFamily: litFam as 4 | 6, host };
  }

  // ── DNS 해석 후 실제 IP 검증 (호스트명 문자열 검사만으로 불충분) ──
  let addrs: { address: string; family: number }[];
  try {
    addrs = await dnsLookup(host, { all: true });
  } catch {
    return { blocked: true, errorCode: 'DNS_FAIL', host, reason: 'resolution failed' };
  }
  if (addrs.length === 0) {
    return { blocked: true, errorCode: 'DNS_FAIL', host, reason: 'no records' };
  }

  // 해석된 **모든** IP를 검사 — 하나라도 차단 대역이면 SSRF_BLOCKED(라운드로빈 우회 방지).
  for (const a of addrs) {
    if (isBlockedIp(a.address)) {
      return { blocked: true, errorCode: 'SSRF_BLOCKED', host, reason: `resolved ${a.address}` };
    }
  }

  // 통과: 검증에 사용한 첫 IP를 핀. safe-fetch는 이 IP로 직접 커넥트한다(리바인딩 방지).
  const first = addrs[0]!;
  return {
    blocked: false,
    pinnedIp: first.address,
    ipFamily: (isIP(first.address) as 4 | 6) || 4,
    host,
  };
}

/** 테스트/재검증 헬퍼 — 리터럴 IP 배열이 전부 안전한지. */
export function allIpsSafe(ips: string[]): boolean {
  return ips.every((ip) => !isBlockedIp(ip));
}
