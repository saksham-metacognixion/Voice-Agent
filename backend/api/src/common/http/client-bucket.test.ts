import { describe, expect, it } from 'vitest';
import { clientBucket } from './client-bucket';

describe('clientBucket', () => {
  it('keeps an IPv4 address, and reads an IPv4-mapped address as its IPv4', () => {
    expect(clientBucket('203.0.113.7')).toBe('203.0.113.7');
    expect(clientBucket('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('counts every address of one IPv6 /64 as one client', () => {
    const a = clientBucket('2001:db8:85a3:12::1');
    expect(a).toBe('2001:db8:85a3:12::/64');
    expect(clientBucket('2001:0db8:85a3:0012:ffff:abcd:1234:5678')).toBe(a);
    expect(clientBucket('2001:db8:85a3:12:dead:beef::%eth0')).toBe(a);
    expect(clientBucket('2001:db8:85a3:13::1')).not.toBe(a);
  });

  it('expands the short forms', () => {
    expect(clientBucket('::1')).toBe('0:0:0:0::/64');
    expect(clientBucket('fe80::')).toBe('fe80:0:0:0::/64');
    expect(clientBucket('64:ff9b::192.0.2.33')).toBe('64:ff9b:0:0::/64');
  });

  it('returns anything that is not an address as it is', () => {
    expect(clientBucket('unknown')).toBe('unknown');
  });
});
