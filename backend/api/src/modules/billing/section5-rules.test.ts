import { describe, expect, it } from 'vitest';
import { rateForTier } from '@portal/schemas';
import { PRICING_V1 } from '../../../../db/prisma/seed-data/pricing-v1';
import { computeCharge } from '../calls/metering';
import { decideLowBalance } from '../notifications/low-balance.decide';
import { decideRental } from '../numbers/number-rental.service';
import { CURATED_VOICES } from '../voices/curated-voices';
import { toRow } from '../voices/voices.service';

/*
 * Spec §5 as agreed, pinned in one place (ADR 0049 §9). Two currencies change what a pack
 * costs and nothing about what it is: these are the figures that must read the same before
 * and after, taken from the seeded pricing config and the pure rules that apply it.
 */

const pack = (id: string) => PRICING_V1.packs.find((p) => p.id === id)!;
const MIN = 60_000;
const call = (ms: number) => ({ call_status: 'ended', start_timestamp: 1_000_000, end_timestamp: 1_000_000 + ms });

describe('§5.2 packs', () => {
  it.each([
    ['starter', 4_900, 150],
    ['growth', 14_900, 500],
    ['scale', 39_900, 1_500],
    ['pro', 99_900, 4_500],
  ])('%s is $%i cents for %i credits, published in USD', (id, cents, credits) => {
    expect(pack(id)).toMatchObject({ price_cents: cents, credits, currency: 'USD', active: true });
  });

  it('sells exactly those four: no Volume pack, no promotional bonus', () => {
    expect(PRICING_V1.packs.map((p) => p.id)).toEqual(['starter', 'growth', 'scale', 'pro']);
    expect(PRICING_V1.packs.every((p) => p.bonus_credits === 0)).toBe(true);
    expect(PRICING_V1.currency_default).toBe('USD');
  });
});

describe('§5.1 rates, metered per second', () => {
  const standard = rateForTier(PRICING_V1.rates, 'standard');
  const premium = rateForTier(PRICING_V1.rates, 'premium');

  it('Standard is 1 credit a minute and Premium 1.5', () => {
    expect(standard).toBe(1);
    expect(premium).toBe(1.5);
    expect(PRICING_V1.rates.rounding_dp).toBe(2);
  });

  it('bills the second, pro-rated: the spec’s 2 min 30 s Standard is 2.50 credits', () => {
    expect(computeCharge(call(2.5 * MIN), standard)).toMatchObject({ billable: true, duration_s: 150, credits: 2.5 });
    expect(computeCharge(call(1_000), standard).credits).toBe(0.02); // one second = 1/60, to 2 dp
    expect(computeCharge(call(61_000), standard).credits).toBe(1.02); // not rounded up to 2 minutes
    expect(computeCharge(call(10 * MIN), standard).credits).toBe(10);
  });

  it('bills Premium at 1.5× for the same seconds', () => {
    expect(computeCharge(call(2.5 * MIN), premium).credits).toBe(3.75);
    expect(computeCharge(call(1 * MIN), premium).credits).toBe(1.5);
    expect(computeCharge(call(40_000), premium).credits).toBe(1); // 40 s × 1.5/60
  });

  it('charges nothing for a call that never connected, and never a negative amount', () => {
    expect(computeCharge({ call_status: 'not_connected' }, standard)).toMatchObject({ billable: false, credits: 0 });
    expect(computeCharge({ ...call(30_000), disconnection_reason: 'dial_no_answer' }, premium)).toMatchObject({ billable: false, credits: 0 });
    expect(computeCharge(call(0), standard).credits).toBe(0);
    expect(computeCharge(call(-5_000), standard).credits).toBe(0);
  });

  it('a transferred leg is 0.25 credit a minute', () => {
    expect(PRICING_V1.rates.transferred_leg_per_min).toBe(0.25);
  });

  it('Alexandre, Adam, Mathieu and Jeanne are Premium voices', () => {
    const quebec = CURATED_VOICES.filter((v) => v.accent === 'Canadian French');
    expect(quebec.map((v) => v.name.split(' ')[0]).sort()).toEqual(['Adam', 'Alexandre', 'Jeanne', 'Mathieu']);
    for (const voice of quebec) {
      expect(voice.provider).toBe('elevenlabs');
      expect(toRow({ voice_id: 'custom_voice_x', voice_name: voice.platformName, provider: 'elevenlabs' })?.tier).toBe('premium');
    }
  });
});

describe('§5.3 recurring', () => {
  it('a bought number is 15 credits a month; a SIP number is charged nothing', () => {
    expect(PRICING_V1.recurring.number_rental_credits).toBe(15);
    const { grace_overdraft_credits: grace } = PRICING_V1.wallet_policy;
    expect(decideRental({ balance: 15, rental: 15, grace })).toBe('charge');
    expect(decideRental({ balance: -50, rental: 0, grace })).toBe('charge'); // a rental of 0 never goes overdue
  });

  it('a rental never takes the balance past the grace', () => {
    const { grace_overdraft_credits: grace } = PRICING_V1.wallet_policy;
    expect(decideRental({ balance: 5, rental: 15, grace })).toBe('charge'); // → −10
    expect(decideRental({ balance: 4.99, rental: 15, grace })).toBe('overdue'); // → −10.01
  });
});

describe('§5.4 wallet', () => {
  const policy = PRICING_V1.wallet_policy;

  it('credits expire after 12 months, the trial is 20 credits, the grace is 10', () => {
    expect(policy.credit_expiry_months).toBe(12);
    expect(policy.trial_credits).toBe(20);
    expect(policy.trial_channel).toBe('web');
    expect(policy.grace_overdraft_credits).toBe(10);
  });

  it('the trial needs no card: it grants no phone number and unlocks no plan gate', () => {
    expect(PRICING_V1.trial).toMatchObject({ max_numbers: 0, feature_gates: [] });
  });

  it('alerts at 20 %, 5 % and 0 of the last pack', () => {
    expect(policy.low_balance_thresholds_pct).toEqual([20, 5, 0]);
    const none = new Set<number>();
    const at = (balance: number) => decideLowBalance({ balance, baseCredits: 500, thresholdsPct: policy.low_balance_thresholds_pct, openPct: none }).open.map((o) => o.pct);
    expect(at(101)).toEqual([]);
    expect(at(100)).toEqual([20]);
    expect(at(25)).toEqual([20, 5]);
    expect(at(0)).toEqual([20, 5, 0]);
  });

  it('auto top-up is opt-in: the gate is on a paid plan and the config only suggests a threshold', () => {
    expect(PRICING_V1.packs.every((p) => p.feature_gates.includes('auto_topup'))).toBe(true);
    expect(PRICING_V1.trial.feature_gates).not.toContain('auto_topup');
    expect(policy.auto_topup_threshold_pct).toBe(10);
  });

  it('the review limit and the MFA threshold are a USD figure and a credit figure', () => {
    expect(policy.max_first_purchase_cents_without_review).toBe(100_000);
    expect(policy.mfa_required_above_balance).toBe(1_000);
  });
});
