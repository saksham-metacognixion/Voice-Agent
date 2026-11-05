import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * D16: a host a customer named (a SIP trunk, a webhook file URL) must never reach our own
 * network. DNS is replaced so the resolution rules are exercised without a resolver.
 */

const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: dns.lookup }));

import { NonPublicHostError, isPublicAddress, resolvePublicAddress } from './public-address';

beforeEach(() => {
  dns.lookup.mockReset();
});

describe('isPublicAddress', () => {
  it.each(['8.8.8.8', '1.1.1.1', '203.0.114.1', '100.63.255.255', '100.128.0.1', '172.15.0.1', '172.32.0.1', '192.169.0.1', '2606:4700::1111', '2001:4860:4860::8888'])(
    '%s is public',
    (ip) => {
      expect(isPublicAddress(ip)).toBe(true);
    },
  );

  it.each([
    ['0.0.0.0', 'this network'],
    ['10.1.2.3', 'RFC 1918'],
    ['127.0.0.1', 'loopback'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['169.254.169.254', 'the instance metadata service'],
    ['172.16.0.1', 'RFC 1918'],
    ['172.31.255.255', 'RFC 1918'],
    ['192.168.1.1', 'RFC 1918'],
    ['192.0.2.1', 'documentation'],
    ['198.18.0.1', 'benchmarking'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['::ffff:10.0.0.1', 'IPv4-mapped private'],
    ['::ffff:169.254.169.254', 'IPv4-mapped metadata'],
    ['fd00::1', 'unique local'],
    ['fe80::1', 'link local'],
    ['ff02::1', 'multicast'],
    ['64:ff9b::1', 'NAT64'],
    ['2001:db8::1', 'documentation'],
  ])('%s is not public (%s)', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each(['', 'localhost', 'example.com', '999.1.1.1', '10.0.0'])('%j is not an address at all', (value) => {
    expect(isPublicAddress(value)).toBe(false);
  });

  it('an IPv4-mapped public address is public', () => {
    expect(isPublicAddress('::ffff:8.8.8.8')).toBe(true);
  });
});

describe('resolvePublicAddress', () => {
  it('answers an IP literal without DNS, bracketed IPv6 included', async () => {
    await expect(resolvePublicAddress('8.8.8.8')).resolves.toEqual({ address: '8.8.8.8', family: 4 });
    await expect(resolvePublicAddress('[2606:4700::1111]')).resolves.toEqual({ address: '2606:4700::1111', family: 6 });
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it('refuses a private IP literal', async () => {
    await expect(resolvePublicAddress('169.254.169.254')).rejects.toBeInstanceOf(NonPublicHostError);
  });

  it('answers the first address of a name that resolves only to public addresses', async () => {
    dns.lookup.mockResolvedValue([
      { address: '2606:4700::1', family: 6 },
      { address: '1.1.1.1', family: 4 },
    ]);
    await expect(resolvePublicAddress('sip.example.com')).resolves.toEqual({ address: '2606:4700::1', family: 6 });
    expect(dns.lookup).toHaveBeenCalledWith('sip.example.com', { all: true, verbatim: true });
  });

  it('refuses a name with one private answer among public ones (DNS rebinding)', async () => {
    dns.lookup.mockResolvedValue([
      { address: '1.1.1.1', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]);
    await expect(resolvePublicAddress('rebind.example.com')).rejects.toMatchObject({ host: 'rebind.example.com' });
  });

  it('refuses a name with no answers', async () => {
    dns.lookup.mockResolvedValue([]);
    await expect(resolvePublicAddress('empty.example.com')).rejects.toBeInstanceOf(NonPublicHostError);
  });

  it('passes the DNS error through when the name does not resolve', async () => {
    dns.lookup.mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));
    await expect(resolvePublicAddress('nope.invalid')).rejects.toMatchObject({ code: 'ENOTFOUND' });
  });

  it('gives up with ETIMEOUT when DNS does not answer in time', async () => {
    dns.lookup.mockReturnValue(new Promise(() => {}));
    await expect(resolvePublicAddress('slow.example.com', 20)).rejects.toMatchObject({ code: 'ETIMEOUT' });
  });
});
