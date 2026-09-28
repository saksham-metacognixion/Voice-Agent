import { describe, expect, it } from 'vitest';
import type { PricingConfig } from '@portal/schemas';
import { lookupKey, planPriceSync, supersededPriceRows, type PriceMapRow } from './stripe-price-sync.service';

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
const rowsFor = (config: PricingConfig, version: number): PriceMapRow[] =>
  config.packs
    .filter((p) => p.active)
    .map((p) => ({
      packId: p.id,
      currency: p.currency,
      stripeProductId: `prod_${p.id}`,
      stripePriceId: `price_${p.id}_v${version}`,
      active: true,
    }));

describe('planPriceSync (admin §5.2 step 3)', () => {
  it('creates a Product and a Price for every pack when nothing exists yet', () => {
    const plan = planPriceSync(base, null, []);
    expect(plan.every((a) => a.action === 'create')).toBe(true);
    expect(plan.length).toBe(base.packs.filter((p) => p.active).length);
    expect(plan.find((a) => a.action === 'create' && a.packId === 'growth')).toMatchObject({
      productId: null,
      archive: null,
    });
  });

  it('reuses unchanged prices, creates a new Price for a re-priced pack and names the old one for archiving', () => {
    const next: PricingConfig = {
      ...base,
      packs: base.packs.map((p) =>
        p.id === 'growth' ? { ...p, price_cents: p.price_cents + 1_000 } : p,
      ),
    };
    const plan = planPriceSync(next, base, rowsFor(base, 1));
    const growth = plan.find((a) => a.packId === 'growth');
    expect(growth?.action).toBe('create');
    expect(growth && growth.action === 'create' ? growth.archive?.stripePriceId : null).toBe(
      'price_growth_v1',
    );
    expect(growth && growth.action === 'create' ? growth.productId : null).toBe('prod_growth');
    expect(plan.filter((a) => a.action === 'reuse').length).toBe(
      base.packs.filter((p) => p.active).length - 1,
    );
  });

  it('names the Price of a pack that left the config for archiving and ignores inactive packs', () => {
    const next: PricingConfig = {
      ...base,
      packs: base.packs.map((p) => (p.id === 'starter' ? { ...p, active: false } : p)),
    };
    const plan = planPriceSync(next, base, rowsFor(base, 1));
    expect(plan.find((a) => a.packId === 'starter')).toMatchObject({ action: 'archive' });
    expect(plan.some((a) => a.action === 'create')).toBe(false);
  });

  it('keys lookups by environment, pack, currency and version', () => {
    expect(lookupKey('staging', 'growth', 'USD', 7)).toBe('staging_pack_growth_usd_v7');
    expect(lookupKey('dev', 'growth', 'USD', 7)).not.toBe(lookupKey('staging', 'growth', 'USD', 7));
  });

  it('review 28 Sep: a rollback planned against the current rows re-creates what the current version re-priced', () => {
    // v1 sold growth at 14 900; v2 re-priced it and archived v1's Price. Rolling back to v1's
    // config must not copy `price_growth_v1`: it is archived on Stripe and checkout would fail.
    const v2: PricingConfig = {
      ...base,
      packs: base.packs.map((p) => (p.id === 'growth' ? { ...p, price_cents: p.price_cents + 1_000 } : p)),
    };
    const plan = planPriceSync(base, v2, rowsFor(v2, 2));
    expect(plan.find((a) => a.packId === 'growth')?.action).toBe('create');
    expect(plan.find((a) => a.packId === 'starter')).toMatchObject({ action: 'reuse', row: { stripePriceId: 'price_starter_v2' } });
  });
});

describe('supersededPriceRows (archived only once the new version is in effect)', () => {
  it('archives an earlier version’s Price only when the current version does not sell it', () => {
    const current = rowsFor(base, 3).map((r) => (r.packId === 'starter' ? { ...r, stripePriceId: 'price_starter_v1' } : r));
    const older = [
      ...rowsFor(base, 1).map((r) => ({ ...r, version: 1 })),
      ...rowsFor(base, 2).map((r) => ({ ...r, version: 2 })),
      { packId: 'legacy', currency: 'USD', stripeProductId: 'prod_legacy', stripePriceId: 'price_legacy_v1', active: false, version: 1 },
    ];
    const gone = supersededPriceRows(current, older).map((r) => r.stripePriceId).sort();
    // starter's v1 Price is reused by v3 (shared id) and stays; the already-inactive row is skipped.
    expect(gone).toEqual(['price_growth_v1', 'price_growth_v2', 'price_starter_v2']);
  });
});
