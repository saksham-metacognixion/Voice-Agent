import { describe, expect, it } from 'vitest';
import { probeAction, scrubDetail } from './admin-system.service';

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

describe('probeAction — the health strip never waits on a provider it has an answer for (QA-072)', () => {
  const ok = { signal: 'ok' as const, detail: null, latency_ms: 120 };
  const now = 1_800_000_000_000;

  it('probes only when nothing is cached', () => {
    expect(probeAction(null, now)).toBe('probe');
  });

  it('answers from a fresh entry without probing', () => {
    expect(probeAction({ ...ok, checked_at: now - 59_000 }, now)).toBe('use');
  });

  it('answers from a stale entry and refreshes it behind the response', () => {
    expect(probeAction({ ...ok, checked_at: now - 60_000 }, now)).toBe('use_and_refresh');
    // An entry written before checked_at existed, or by a clock ahead of ours, is refreshed too.
    expect(probeAction(ok, now)).toBe('use_and_refresh');
    expect(probeAction({ ...ok, checked_at: now + 5_000 }, now)).toBe('use_and_refresh');
  });
});
