import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/*
 * Outbound connections to a host someone else named — a SIP trunk the customer typed in
 * (D16 re-verify), a file URL a webhook carried (D16 knowledge use). Both must never reach
 * our own network: the VPC, the instance metadata service, loopback. The hostname check in
 * the knowledge module refuses obvious names; this checks the address the name resolves
 * to, and callers connect to that address, so a name that resolves somewhere private is
 * refused rather than followed.
 */

/** True for a unicast address on the public internet. */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPublicV4(ip);
  if (family === 6) {
    const lower = ip.toLowerCase();
    // IPv4-mapped (::ffff:10.0.0.1) is the v4 address in disguise.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPublicV4(mapped[1]!);
    if (lower === '::' || lower === '::1') return false;
    const head = parseInt(lower.split(':')[0] || '0', 16);
    if ((head & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
    if ((head & 0xffc0) === 0xfe80) return false; // fe80::/10 link local
    if ((head & 0xff00) === 0xff00) return false; // ff00::/8 multicast
    if (lower.startsWith('64:ff9b:') || lower.startsWith('2001:db8:')) return false; // NAT64, documentation
    return true;
  }
  return false;
}

function isPublicV4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link local, the metadata service
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0) return false; // 192.0.0.0/24, 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

export class NonPublicHostError extends Error {
  constructor(readonly host: string) {
    super(`${host} does not resolve to a public address`);
  }
}

/**
 * The first public address `host` resolves to. Throws `NonPublicHostError` when any
 * address it resolves to is not public — a name with one private answer among public ones
 * is refused too, since the connection could land on either — and the DNS error as it came
 * when the name does not resolve at all.
 */
export async function resolvePublicAddress(host: string, timeoutMs = 3_000): Promise<{ address: string; family: 4 | 6 }> {
  const bare = host.replace(/^\[|\]$/g, '');
  if (isIP(bare)) {
    if (!isPublicAddress(bare)) throw new NonPublicHostError(host);
    return { address: bare, family: isIP(bare) as 4 | 6 };
  }
  let timer: NodeJS.Timeout | undefined;
  const answers = await Promise.race([
    lookup(bare, { all: true, verbatim: true }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`DNS lookup of ${host} timed out`), { code: 'ETIMEOUT' })), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
  if (!answers.length || answers.some((a) => !isPublicAddress(a.address))) throw new NonPublicHostError(host);
  const first = answers[0]!;
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}
