import { describe, expect, it } from 'vitest';
import { mfaReasons, mfaRequiredFor, purchaseNeedsReview, termsAcceptanceRequired, TERMS_VERSION } from './security.js';

describe('mfaRequiredFor (§6.2, ADR 0036)', () => {
  const calm = { balance: 500, autoTopupEnabled: false, threshold: 1000 };

  it('binds nobody while no money is at risk', () => {
    for (const role of ['owner', 'admin', 'editor', 'viewer'] as const) expect(mfaRequiredFor(role, calm)).toBe(false);
    expect(mfaReasons(calm)).toEqual([]);
  });

  it('auto top-up alone binds owners and admins', () => {
    const state = { ...calm, autoTopupEnabled: true };
    expect(mfaRequiredFor('owner', state)).toBe(true);
    expect(mfaRequiredFor('admin', state)).toBe(true);
    expect(mfaReasons(state)).toEqual(['auto_topup']);
  });

  it('a balance strictly over the threshold alone binds owners and admins', () => {
    expect(mfaRequiredFor('owner', { ...calm, balance: 1000 })).toBe(false);
    expect(mfaRequiredFor('owner', { ...calm, balance: 1000.01 })).toBe(true);
    expect(mfaReasons({ ...calm, balance: 4500 })).toEqual(['balance']);
  });

  it('both together give both reasons', () => {
    expect(mfaReasons({ balance: 5000, autoTopupEnabled: true, threshold: 1000 })).toEqual(['auto_topup', 'balance']);
  });

  it('never binds editors or viewers, whatever the money', () => {
    const risky = { balance: 99_999, autoTopupEnabled: true, threshold: 1000 };
    expect(mfaRequiredFor('editor', risky)).toBe(false);
    expect(mfaRequiredFor('viewer', risky)).toBe(false);
  });

  it('an unreadable balance is not "over" anything', () => {
    expect(mfaReasons({ ...calm, balance: Number.NaN })).toEqual([]);
  });
});

describe('purchaseNeedsReview (§17)', () => {
  const limit = 100_000;
  it('reviews a first purchase strictly over $1,000 only', () => {
    expect(purchaseNeedsReview({ hasPaidBefore: false, amountCents: 99_999, limitCents: limit })).toBe(false);
    expect(purchaseNeedsReview({ hasPaidBefore: false, amountCents: 100_000, limitCents: limit })).toBe(false);
    expect(purchaseNeedsReview({ hasPaidBefore: false, amountCents: 100_001, limitCents: limit })).toBe(true);
  });
  it('never reviews a later purchase', () => {
    expect(purchaseNeedsReview({ hasPaidBefore: true, amountCents: 5_000_000, limitCents: limit })).toBe(false);
  });
});

describe('termsAcceptanceRequired (§6.3 A1)', () => {
  it('asks until the current version is accepted, and again when it changes', () => {
    expect(termsAcceptanceRequired(null)).toBe(true);
    expect(termsAcceptanceRequired(TERMS_VERSION)).toBe(false);
    expect(termsAcceptanceRequired('2026-01-01')).toBe(true);
    expect(termsAcceptanceRequired(TERMS_VERSION, '2027-01-01')).toBe(true);
  });
});
