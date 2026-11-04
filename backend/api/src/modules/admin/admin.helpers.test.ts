import { describe, expect, it } from 'vitest';
import type { PricingConfig } from '@portal/schemas';
import { AGENT_STACK_V1_TIERS } from '../../../../db/prisma/seed-data/agent-stack-v1';
import { AGENT_STACK_V2_TIERS } from '../../../../db/prisma/seed-data/agent-stack-v2';
import { PRICING_V1 } from '../../../../db/prisma/seed-data/pricing-v1';
import { RETELL_COSTS_V1 } from '../../../../db/prisma/seed-data/retell-costs-v1';
import { agentStackTiers } from '../retell';
import { diffConfig, marginBlockers, marginsFor, tierCostPerMin } from './admin-pricing.service';
import { AT_RISK_AFTER_MS, CHURNED_AFTER_MS, customerStatusOf, idMatch, median, phoneQuery } from './admin.helpers';

import { pricingConfig, retellCostInputs } from '@portal/schemas';

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

describe('median (SA1 "Time to live", BUG-022)', () => {
  it('takes the middle of an odd sample, unsorted input', () => {
    expect(median([30, 10, 20])).toBe(20);
  });
  it('averages the two middle values of an even sample', () => {
    expect(median([10, 40])).toBe(25);
    expect(median([60, 10, 30, 20])).toBe(25);
  });
  it('is null for an empty sample and leaves the input alone', () => {
    expect(median([])).toBeNull();
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
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

/*
 * Admin §5.4 / SA5 margin check on the itemised cost inputs (ADR 0038). Priced from what
 * `pnpm db:seed` writes — the 4 Nov price list and the v2 tier stack — so a fresh
 * environment's numbers are the ones under test.
 */
describe('marginsFor (admin §5.4, ADR 0038)', () => {
  const costs = retellCostInputs.parse(RETELL_COSTS_V1);
  const tiers = agentStackTiers.parse(AGENT_STACK_V2_TIERS);
  const catalogue = pricingConfig.parse(PRICING_V1);
  const row = (m: ReturnType<typeof marginsFor>, pack: string, tier: string) => m.find((r) => r.pack_id === pack && r.tier === tier)!;

  it('prices a minute of each tier from its stack: voice engine, voice, model, dearest telephony, knowledge base', () => {
    // 5.5 + Cartesia 1.5 + GPT-4.1 mini 1.28 + Canada 3.0 + KB 0.5
    expect(tierCostPerMin(costs, tiers.standard)).toEqual({ cents: 11.78, missing: [] });
    // 5.5 + ElevenLabs Multilingual v2 6.0 + GPT-4.1 mini 1.28 + 3.0 + 0.5 (Premium stays on GPT-4.1 mini, ADR 0038)
    expect(tierCostPerMin(costs, tiers.premium)).toEqual({ cents: 16.28, missing: [] });
  });

  it('checks every priced active pack, both tiers — a positive margin on the seeded catalogue', () => {
    const margins = marginsFor(catalogue, costs, tiers);
    expect(new Set(margins.map((m) => m.pack_id))).toEqual(new Set(['starter', 'growth', 'scale', 'pro']));
    expect(row(margins, 'pro', 'standard')).toMatchObject({ revenue_cents_per_min: 22.2, cost_cents_per_min: 11.78, margin_pct: 46.9, floor_pct: 35, below_floor: false });
    expect(row(margins, 'pro', 'premium')).toMatchObject({ revenue_cents_per_min: 33.3, cost_cents_per_min: 16.28, margin_pct: 51.1, below_floor: false });
    expect(row(margins, 'starter', 'standard').margin_pct).toBe(63.9);
    expect(marginBlockers(margins, costs, tiers)).toEqual([]);
  });

  it('a low margin binds on the cheapest credit, not the dearest (AS-224)', () => {
    const tight = { ...costs, margin_floor_pct: 50 };
    const margins = marginsFor(catalogue, tight, tiers);
    const under = margins.filter((m) => m.below_floor).map((m) => `${m.pack_id}/${m.tier}`);
    // Starter's Standard minute clears 50 %; Pro's does not, and the old one-row check never looked at Pro.
    expect(under).toContain('pro/standard');
    expect(under).not.toContain('starter/standard');
    const blockers = marginBlockers(margins, tight, tiers);
    expect(blockers.some((b) => b.includes('standard margin on pro is 46.9%'))).toBe(true);
  });

  it('zero and negative margins are below any floor', () => {
    const dear = { ...costs, voice_engine_cents_per_min: 22.2 - (11.78 - 5.5) };
    const zero = row(marginsFor(catalogue, dear, tiers), 'pro', 'standard');
    expect(zero.margin_pct).toBe(0);
    expect(zero.below_floor).toBe(true);
    const loss = row(marginsFor(catalogue, { ...costs, voice_engine_cents_per_min: 40 }, tiers), 'pro', 'standard');
    expect(loss.margin_pct).toBeLessThan(0);
    expect(loss.below_floor).toBe(true);
  });

  it('a missing input makes the margin unknown and blocks — never a cheaper guess', () => {
    // Premium's voice model has no price: it is not priced as plain ElevenLabs (Flash) instead.
    const { 'elevenlabs:eleven_multilingual_v2': _dropped, ...tts } = costs.tts_cents_per_min;
    const partial = { ...costs, tts_cents_per_min: tts };
    const margins = marginsFor(catalogue, partial, tiers);
    expect(row(margins, 'pro', 'premium')).toMatchObject({ cost_cents_per_min: null, margin_pct: null, below_floor: false, missing: ['tts:elevenlabs:eleven_multilingual_v2'] });
    expect(row(margins, 'pro', 'standard').margin_pct).toBe(46.9);
    expect(marginBlockers(margins, partial, tiers)).toEqual([expect.stringContaining('cannot price tts:elevenlabs:eleven_multilingual_v2')]);
    const { 'gpt-4.1-mini': _model, ...llm } = costs.llm_cents_per_min;
    expect(tierCostPerMin({ ...costs, llm_cents_per_min: llm }, tiers.standard)).toEqual({ cents: null, missing: ['llm:gpt-4.1-mini'] });
    expect(tierCostPerMin({ ...costs, telephony_cents_per_min: {} }, tiers.standard).missing).toEqual(['telephony']);
  });

  it('no cost inputs, or no readable stack, blocks publish instead of passing silently', () => {
    const none = marginsFor(catalogue, null, tiers);
    expect(none.every((m) => m.margin_pct === null && !m.below_floor)).toBe(true);
    expect(marginBlockers(none, null, tiers)[0]).toMatch(/no voice platform cost inputs/i);
    expect(marginBlockers(marginsFor(catalogue, costs, null), costs, null)[0]).toMatch(/agent stack has no readable tiers/);
  });

  it('follows the stack: v1 (GPT-5 mini, ElevenLabs Flash on Standard) prices differently from v2', () => {
    const v1 = agentStackTiers.parse(AGENT_STACK_V1_TIERS);
    // 5.5 + Flash 4.0 + GPT-5 mini 0.8 + 3.0 + 0.5
    expect(tierCostPerMin(costs, v1.standard).cents).toBe(13.8);
    expect(tierCostPerMin(costs, v1.standard).cents).toBeGreaterThan(tierCostPerMin(costs, tiers.standard).cents!);
  });

  it('accepts the seeded inputs as written', () => {
    expect(retellCostInputs.safeParse(RETELL_COSTS_V1).success).toBe(true);
    expect(retellCostInputs.safeParse({ standard_cents_per_min: 5, premium_cents_per_min: 9, margin_floor_pct: 40 }).success).toBe(false);
  });
});
