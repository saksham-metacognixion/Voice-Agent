import { describe, expect, it } from 'vitest';
import { LEDGER_REASONS, autoTopupBody, balanceTone, expiringSoon, ledgerLink, ledgerReasonParam, usageSummary } from './wallet-view';

describe('balanceTone (§7.2)', () => {
  it('is amber under 20 % of the last pack and red at or below zero', () => {
    expect(balanceTone(120, 500)).toBe('ok');
    expect(balanceTone(99.99, 500)).toBe('warning');
    expect(balanceTone(0, 500)).toBe('danger');
    expect(balanceTone(-4, 500)).toBe('danger');
  });

  it('falls back to 20 credits before the first pack', () => {
    expect(balanceTone(20, null)).toBe('ok');
    expect(balanceTone(19.5, null)).toBe('warning');
  });
});

describe('expiringSoon', () => {
  const now = new Date('2026-09-25T12:00:00Z');
  const lot = (id: string, expires: string, remaining = 10) => ({ id, purchase_id: null, credits_total: 100, credits_remaining: remaining, expires_at: expires, created_at: '2025-10-01T00:00:00Z' });

  it('keeps open lots expiring within 60 days, soonest first', () => {
    const out = expiringSoon([lot('late', '2026-11-20T00:00:00Z'), lot('soon', '2026-10-01T00:00:00Z'), lot('far', '2027-03-01T00:00:00Z'), lot('spent', '2026-10-02T00:00:00Z', 0), lot('past', '2026-09-01T00:00:00Z')], now);
    expect(out.map((l) => l.id)).toEqual(['soon', 'late']);
  });
});

describe('usageSummary', () => {
  it('totals the credits and averages per day of the window', () => {
    const points = [0, 3, 0, 1.2].map((credits, i) => ({ date: `2026-09-0${i + 1}`, calls: 0, missed: 0, minutes: 0, credits }));
    expect(usageSummary(points)).toEqual({ total: 4.2, perDay: 1.1 });
    expect(usageSummary([])).toEqual({ total: 0, perDay: 0 });
  });
});

describe('ledgerReasonParam (QA-080)', () => {
  it('reads every reason the filter offers', () => {
    for (const reason of LEDGER_REASONS) expect(ledgerReasonParam(reason)).toBe(reason);
  });
  it('reads anything else as everything', () => {
    expect(ledgerReasonParam(null)).toBeNull();
    expect(ledgerReasonParam('')).toBeNull();
    expect(ledgerReasonParam('all')).toBeNull();
    expect(ledgerReasonParam('CALL')).toBeNull();
    expect(ledgerReasonParam('constructor')).toBeNull();
  });
});

describe('ledgerLink', () => {
  it('links a call debit to its D2 detail and nothing else', () => {
    expect(ledgerLink({ reason: 'call', ref_id: 'call_abc' })).toBe('/app/calls/?call=call_abc');
    expect(ledgerLink({ reason: 'transfer', ref_id: 'call_abc' })).toBe('/app/calls/?call=call_abc');
    expect(ledgerLink({ reason: 'rental', ref_id: 'n1:2026-09-01' })).toBeNull();
    expect(ledgerLink({ reason: 'call', ref_id: null })).toBeNull();
  });
});

describe('autoTopupBody', () => {
  it('turns off with nothing else', () => {
    expect(autoTopupBody({ enabled: false, packId: null, threshold: '' })).toEqual({ ok: true, body: { enabled: false } });
  });

  it('needs a pack and a threshold of at least 10 to turn on', () => {
    expect(autoTopupBody({ enabled: true, packId: null, threshold: '50' })).toEqual({ ok: false, field: 'pack' });
    expect(autoTopupBody({ enabled: true, packId: 'growth', threshold: '9' })).toEqual({ ok: false, field: 'threshold' });
    expect(autoTopupBody({ enabled: true, packId: 'growth', threshold: 'abc' })).toEqual({ ok: false, field: 'threshold' });
    expect(autoTopupBody({ enabled: true, packId: 'growth', threshold: ' ' })).toEqual({ ok: false, field: 'threshold' });
    expect(autoTopupBody({ enabled: true, packId: 'growth', threshold: '50' })).toEqual({ ok: true, body: { enabled: true, pack_id: 'growth', threshold: 50 } });
  });
});
