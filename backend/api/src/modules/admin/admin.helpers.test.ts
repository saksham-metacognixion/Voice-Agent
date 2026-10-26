import { describe, expect, it } from 'vitest';
import type { PricingConfig } from '@portal/schemas';
import { diffConfig, marginsFor } from './admin-pricing.service';
import { AT_RISK_AFTER_MS, CHURNED_AFTER_MS, customerStatusOf, idMatch, phoneQuery } from './admin.helpers';

import { pricingConfig } from '@portal/schemas';

const pack = (id: string, price_cents: number, credits: number, plan_tier: 'starter' | 'growth') => ({
  id, name: id, price_cents, currency: 'USD' as const, credits, plan_tier, concurrency_cap: 2, kb_allowance: 0, max_agents: 1, max_numbers: 1,
});
const base = pricingConfig.parse({
  currency_default: 'USD',
  packs: [pack('starter', 4_900, 150, 'starter'), pack('growth', 14_900, 500, 'growth')],
  rates: { standard_per_min: 1, premium_per_min: 1.5 },
  recurring: { number_rental_credits: 15, extra_kb_credits: 30, release_after_days_at_zero_balance: 30, rental_warning_days: [7, 3, 1] },
  wallet_policy: { trial_credits: 20, trial_validity_days: 14, credit_expiry_months: 12, grace_overdraft_credits: 10, low_balance_thresholds_pct: [20, 5, 0], auto_topup_default_on: true, auto_topup_threshold_pct: 10, max_first_purchase_cents_without_review: 100_000, mfa_required_above_balance: 5_000 },
  trial: { concurrency_cap: 1, kb_allowance: 0, max_agents: 1, max_numbers: 0 },
});
const now = new Date('2026-09-28T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);

describe('customerStatusOf (SA2 "Status")', () => {
  const live = { pausedAt: null, onboardingCompletedAt: ago(30 * 86_400_000), now };
  it('paused wins over everything', () => {
    expect(
      customerStatusOf({
        ...live,
        pausedAt: now,
        balance: 100,
        balanceSince: now,
        lastActivityAt: now,
      }),
    ).toBe('paused');
  });
  it('a wizard that never finished is onboarding', () => {
    expect(
      customerStatusOf({
        pausedAt: null,
        onboardingCompletedAt: null,
        balance: 20,
        balanceSince: null,
        lastActivityAt: null,
        now,
      }),
    ).toBe('onboarding');
  });
  it('an empty wallet is at risk only after three days', () => {
    expect(
      customerStatusOf({
        ...live,
        balance: 0,
        balanceSince: ago(AT_RISK_AFTER_MS - 1000),
        lastActivityAt: now,
      }),
    ).toBe('active');
    expect(
      customerStatusOf({
        ...live,
        balance: -2,
        balanceSince: ago(AT_RISK_AFTER_MS + 1000),
        lastActivityAt: now,
      }),
    ).toBe('at_risk');
  });
  it('silence for sixty days is churned', () => {
    expect(
      customerStatusOf({
        ...live,
        balance: 50,
        balanceSince: ago(CHURNED_AFTER_MS + 1),
        lastActivityAt: ago(CHURNED_AFTER_MS + 1),
      }),
    ).toBe('churned');
    expect(customerStatusOf({ ...live, balance: 50, balanceSince: now, lastActivityAt: now })).toBe(
      'active',
    );
  });
});

describe('idMatch', () => {
  it('matches a full uuid and nothing shorter', () => {
    expect(idMatch('7AED1E2A-DC37-4BC0-A06D-C085B3898F4C')).toEqual([
      { id: '7aed1e2a-dc37-4bc0-a06d-c085b3898f4c' },
    ]);
    expect(idMatch('7aed1e2a')).toEqual([]);
  });
});

describe('phoneQuery (QA-045)', () => {
  it('matches numbers only for a query that is a number', () => {
    expect(phoneQuery('Dental 1')).toBeNull();
    expect(phoneQuery('Room 4567')).toBeNull();
    expect(phoneQuery('123')).toBeNull();
    expect(phoneQuery('+1 (416) 555-0100')).toBe('+14165550100');
    expect(phoneQuery('5550100')).toBe('5550100');
    expect(phoneQuery('555.0100')).toBe('5550100');
  });
});

describe('diffConfig (SA5 preview)', () => {
  it('names changed paths, keys packs by id and ignores order', () => {
    const next: PricingConfig = {
      ...base,
      rates: { ...base.rates, premium_per_min: base.rates.premium_per_min + 0.5 },
      packs: [...base.packs]
        .reverse()
        .map((p) => (p.id === 'growth' ? { ...p, price_cents: 1 } : p)),
    };
    const paths = diffConfig(base, next).map((c) => c.path);
    expect(paths).toEqual(
      expect.arrayContaining(['rates.premium_per_min', 'packs.growth.price_cents']),
    );
    expect(paths.length).toBe(2);
    expect(diffConfig(base, base)).toEqual([]);
  });
});

describe('marginsFor (admin §5.4)', () => {
  it('reports unknown margins without cost inputs and flags a tier under the floor with them', () => {
    const none = marginsFor(base, null);
    expect(none.every((m) => m.margin_pct === null && !m.below_floor)).toBe(true);
    const tight = marginsFor(base, {
      standard_cents_per_min: 1_000,
      premium_cents_per_min: 1_000,
      margin_floor_pct: 50,
    });
    expect(tight.every((m) => m.below_floor)).toBe(true);
    const fine = marginsFor(base, {
      standard_cents_per_min: 1,
      premium_cents_per_min: 1,
      margin_floor_pct: 50,
    });
    expect(fine.every((m) => !m.below_floor && (m.margin_pct ?? 0) > 50)).toBe(true);
  });
});
