import { pricingConfig } from '@portal/schemas';
import { describe, expect, it } from 'vitest';
import fixture from '../../../test/fixtures/pricing/config-v1.json';
import { killSwitchActive, packForTier, resolveCaps, resolveFlags, rolloutBucket, tierCapsFor } from './config.resolve';

const config = pricingConfig.parse(fixture);
const ws = '11111111-1111-4111-8111-111111111111';

const growthTenant = { id: ws, planTier: 'growth' as const, concurrencyCap: 3, kbAllowance: 1 };
const trialTenant = { id: ws, planTier: 'trial' as const, concurrencyCap: 1, kbAllowance: 0 };

describe('the pricing config fixture', () => {
  it('validates against the schema and fills defaults', () => {
    expect(config.packs.find((p) => p.id === 'starter')?.bonus_credits).toBe(0);
    expect(config.rates.rounding_dp).toBe(2);
  });
});

describe('resolveCaps', () => {
  it('takes concurrency and KB from the tenant row, agents/numbers from the tier pack, grace from policy', () => {
    const caps = resolveCaps(config, 7, growthTenant, null);
    expect(caps).toEqual({
      plan_tier: 'growth',
      concurrency_cap: 3,
      kb_allowance: 1,
      max_agents: 3,
      max_numbers: 3,
      grace_overdraft_credits: 10,
      config_version: 7,
    });
  });

  it('keeps a grandfathered tenant cap even when the config for that tier changed', () => {
    // The tenant bought Growth when it came with concurrency 3; the config now says 4.
    const changed = { ...config, packs: config.packs.map((p) => (p.id === 'growth' ? { ...p, concurrency_cap: 4 } : p)) };
    expect(resolveCaps(changed, 8, growthTenant, null).concurrency_cap).toBe(3);
  });

  it('applies tenant overrides field by field', () => {
    const caps = resolveCaps(config, 1, growthTenant, {
      concurrencyCap: 6,
      kbAllowance: null,
      maxAgents: null,
      maxNumbers: 9,
      gatesJson: null,
      flagsJson: null,
    });
    expect(caps.concurrency_cap).toBe(6);
    expect(caps.kb_allowance).toBe(1);
    expect(caps.max_agents).toBe(3);
    expect(caps.max_numbers).toBe(9);
  });

  it('uses the trial caps when nothing has been bought', () => {
    const caps = resolveCaps(config, 1, trialTenant, null);
    expect(caps.max_numbers).toBe(0);
    expect(caps.max_agents).toBe(1);
  });

  it('picks the largest pack of a tier when several share it', () => {
    // ca_only is also growth (300 cr); growth (500 cr) must win.
    expect(packForTier(config, 'growth')?.id).toBe('growth');
  });

  it('falls down the tier ladder, not to the trial caps, when a tier has no pack', () => {
    // Volume is negotiated, so the seeded config has no volume pack at all (seed.ts).
    const noVolume = { ...config, packs: config.packs.filter((p) => p.plan_tier !== 'volume') };
    const volumeTenant = { id: ws, planTier: 'volume' as const, concurrencyCap: 40, kbAllowance: 20 };
    expect(packForTier(noVolume, 'volume')).toBeUndefined();
    expect(tierCapsFor(noVolume, 'volume').max_agents).toBe(25); // pro, not trial's 1
    const caps = resolveCaps(noVolume, 1, volumeTenant, null);
    expect(caps).toMatchObject({ plan_tier: 'volume', concurrency_cap: 40, kb_allowance: 20, max_agents: 25, max_numbers: 25 });
  });

  it('keeps the trial caps for the trial tier even though starter sits above it', () => {
    expect(tierCapsFor(config, 'trial')).toBe(config.trial);
  });
});

describe('resolveFlags', () => {
  const featureFlags = [
    { key: 'new_wizard', defaultOn: false, rolloutPct: 0, tenantOverridesJson: null },
    { key: 'fr_ca', defaultOn: true, rolloutPct: 0, tenantOverridesJson: null },
    { key: 'beta_kb', defaultOn: false, rolloutPct: 0, tenantOverridesJson: { [ws]: true } },
    { key: 'ramp', defaultOn: false, rolloutPct: 50, tenantOverridesJson: null },
  ];

  it('composes tier gates, tenant overrides, flags and kill switches', () => {
    const out = resolveFlags({
      config,
      configVersion: 3,
      tenant: growthTenant,
      override: {
        concurrencyCap: null,
        kbAllowance: null,
        maxAgents: null,
        maxNumbers: null,
        gatesJson: { premium_voices: true, knowledge_base: false },
        flagsJson: { new_wizard: true },
      },
      featureFlags,
      killSwitches: [
        { key: 'pause_purchases', on: true, expiresAt: null },
        { key: 'reject_inbound', on: true, expiresAt: new Date(Date.now() - 1000) },
        { key: 'not_a_real_switch', on: true, expiresAt: null },
      ],
    });

    expect(out.config_version).toBe(3);
    expect(out.plan_tier).toBe('growth');
    // Tier says knowledge_base on and premium_voices off; the override flips both.
    expect(out.gates.knowledge_base).toBe(false);
    expect(out.gates.premium_voices).toBe(true);
    expect(out.gates.call_my_phone).toBe(true);
    expect(out.gates.sip_import).toBe(false);
    // Flags: tenant override, default, per-tenant map.
    expect(out.flags).toMatchObject({ new_wizard: true, fr_ca: true, beta_kb: true });
    expect(typeof out.flags.ramp).toBe('boolean');
    // Kill switches: expired one is off, unknown one is ignored, every known key present.
    expect(out.kill_switches).toEqual({
      reject_inbound: false,
      pause_web_tests: false,
      pause_purchases: true,
      pause_generation: false,
    });
    expect(out.caps).toEqual({ concurrency_cap: 3, kb_allowance: 1, max_agents: 3, max_numbers: 3 });
  });

  it('gives a tier with no pack of its own the gates of the tier below, not the trial gates', () => {
    const noVolume = { ...config, packs: config.packs.filter((p) => p.plan_tier !== 'volume') };
    const out = resolveFlags({
      config: noVolume,
      configVersion: 1,
      tenant: { id: ws, planTier: 'volume', concurrencyCap: 40, kbAllowance: 20 },
      override: null,
      featureFlags: [],
      killSwitches: [],
    });
    expect(out.gates.knowledge_base).toBe(true);
    expect(out.gates.sip_import).toBe(true);
    expect(out.caps).toEqual({ concurrency_cap: 40, kb_allowance: 20, max_agents: 25, max_numbers: 25 });
  });

  it('rolls out by a stable per-workspace bucket', () => {
    const a = rolloutBucket('ramp', ws);
    expect(rolloutBucket('ramp', ws)).toBe(a);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(100);
    const on = resolveFlags({ config, configVersion: 1, tenant: growthTenant, override: null, featureFlags, killSwitches: [] }).flags.ramp;
    expect(on).toBe(a < 50);
    // At 100 % everyone is in; at 0 % nobody.
    const all = resolveFlags({ config, configVersion: 1, tenant: growthTenant, override: null, featureFlags: [{ ...featureFlags[3]!, rolloutPct: 100 }], killSwitches: [] });
    expect(all.flags.ramp).toBe(true);
  });

  it('treats a kill switch as off once its auto-expiry passes', () => {
    const now = new Date('2026-09-15T12:00:00Z');
    expect(killSwitchActive({ key: 'x', on: true, expiresAt: '2026-09-15T12:00:01Z' }, now)).toBe(true);
    expect(killSwitchActive({ key: 'x', on: true, expiresAt: '2026-09-15T11:59:59Z' }, now)).toBe(false);
    expect(killSwitchActive({ key: 'x', on: false, expiresAt: null }, now)).toBe(false);
  });
});
