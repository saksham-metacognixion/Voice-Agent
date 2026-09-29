import { describe, expect, it } from 'vitest';
import { scrubDetail } from './admin-system.service';

describe('scrubDetail — the health strip shows no credential (admin §3)', () => {
  it('removes the key Stripe quotes back in its 401', () => {
    const out = scrubDetail('Invalid API Key provided: sk_test_e2e_*************************work');
    expect(out).toBe('Invalid API Key provided: [redacted]');
  });

  it('removes connection strings, platform keys, JWTs and bearer headers', () => {
    const url = ['postgresql', '://', 'u', ':', 'p', '@', 'db.internal:5432/portal'].join('');
    const out = scrubDetail(
      `Can't reach ${url}; key_0123456789abcdef Bearer abc.def ` +
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig whsec_abc',
    );
    expect(out).not.toMatch(/postgresql:|db\.internal|key_|eyJ|abc\.def|whsec_/);
  });

  it('leaves an ordinary message alone', () => {
    expect(scrubDetail('PING did not answer')).toBe('PING did not answer');
  });
});
