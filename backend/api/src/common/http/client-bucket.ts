import { isIPv4, isIPv6 } from 'node:net';

/**
 * The client a per-address budget counts against: an IPv4 address as it is, an IPv6
 * address by its /64. One IPv6 host is handed a whole /64 and picks a fresh address from
 * it at will, so keyed on the full address every request could start a new window. An
 * IPv4-mapped IPv6 address (`::ffff:203.0.113.7`) is its IPv4 address. Anything that is
 * not an address is returned as it is.
 */
export function clientBucket(ip: string): string {
  const bare = ip.trim().replace(/%.*$/, '');
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare);
  if (mapped && isIPv4(mapped[1]!)) return mapped[1]!;
  if (!isIPv6(bare)) return ip;
  const groups = expandIPv6(bare);
  return groups ? `${groups.slice(0, 4).join(':')}::/64` : ip;
}

/** Eight lower-case hextets without leading zeros, or null for a shape `isIPv6` let through that this does not read. */
function expandIPv6(address: string): string[] | null {
  let text = address.toLowerCase();
  // A dotted IPv4 tail is the last two hextets.
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (tail) {
    const [a, b, c, d] = tail[1]!.split('.').map(Number) as [number, number, number, number];
    text = `${text.slice(0, -tail[1]!.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = text.split('::') as [string, string | undefined];
  const left = head ? head.split(':') : [];
  const right = rest === undefined ? [] : rest ? rest.split(':') : [];
  const missing = 8 - left.length - right.length;
  if (rest === undefined ? missing !== 0 : missing < 1) return null;
  const groups = [...left, ...Array<string>(rest === undefined ? 0 : missing).fill('0'), ...right];
  return groups.map((g) => Number.parseInt(g, 16).toString(16));
}
