import { createHash } from 'node:crypto';
import {
  type FeatureGate,
  type FlagsResponse,
  type KillSwitchKey,
  type PlanTier,
  type PricingConfig,
  type PricingPack,
  type WorkspaceCaps,
  featureGate,
  killSwitchKey,
  planTier as planTierEnum,
} from '@portal/schemas';

/*
 * Pure resolution of "what applies to this workspace" from the rows that hold the answer.
 * No I/O here, so the composition rules (admin §5.3: tier defaults ∘ tenant overrides ∘
 * feature flags) are unit-tested without a database, and the service is only plumbing.
 */

export interface TenantForConfig {
  id: string;
  planTier: PlanTier;
  /** Denormalised at purchase time, so a later pricing publish does not re-cap an existing
   *  customer until their next purchase (admin §5.2 step 6, default grandfathering). */
  concurrencyCap: number;
  kbAllowance: number;
}

export interface TenantOverrideForConfig {
  concurrencyCap: number | null;
  kbAllowance: number | null;
  maxAgents: number | null;
  maxNumbers: number | null;
  /** Record<FeatureGate, boolean> */
  gatesJson: unknown;
  /** Record<flag key, boolean> */
  flagsJson: unknown;
}

export interface FeatureFlagRow {
  key: string;
  defaultOn: boolean;
  rolloutPct: number;
  /** Record<tenantId, boolean> */
  tenantOverridesJson: unknown;
}

export interface KillSwitchRow {
  key: string;
  on: boolean;
  expiresAt: Date | string | null;
}

/**
 * The pack whose caps define a plan tier: the largest active pack carrying that tier.
 * Trial has no pack; its caps are `config.trial`.
 */
export function packForTier(config: PricingConfig, tier: PlanTier): PricingPack | undefined {
  return config.packs
    .filter((p) => p.plan_tier === tier)
    .sort((a, b) => b.credits - a.credits)[0];
}

/** The per-tier half of a workspace's caps — whatever the tier's pack would have said. */
export type TierCaps = Pick<PricingPack, 'max_agents' | 'max_numbers' | 'feature_gates'>;

/**
 * The caps and gates a plan tier carries.
 *
 * Not every tier has a pack. Volume is negotiated per customer, so it is a `custom_deals`
 * row and deliberately not in `config.packs` (see `seed.ts`); a pack retired from a later
 * pricing version leaves the same hole for tenants still on that tier. Falling back to
 * `config.trial` there would hand a Volume customer `max_agents: 1`, `max_numbers: 0` and
 * every feature gate off, so instead we walk *down* the §5.2 ladder to the nearest tier
 * that does have a pack (volume → pro). The tenant's own concurrency and KB caps are
 * denormalised on the tenant row and a negotiated deal lands in `tenant_overrides`, so
 * both still win over whatever this returns.
 */
export function tierCapsFor(config: PricingConfig, tier: PlanTier): TierCaps {
  if (tier === 'trial') return config.trial;
  const ladder = planTierEnum.options;
  for (let i = ladder.indexOf(tier); i > 0; i--) {
    const rung = ladder[i];
    const pack = rung && packForTier(config, rung);
    if (pack) return pack;
  }
  return config.trial;
}

export function resolveCaps(
  config: PricingConfig,
  configVersion: number,
  tenant: TenantForConfig,
  override: TenantOverrideForConfig | null,
): WorkspaceCaps {
  const tierCaps = tierCapsFor(config, tenant.planTier);
  return {
    plan_tier: tenant.planTier,
    concurrency_cap: override?.concurrencyCap ?? tenant.concurrencyCap,
    kb_allowance: override?.kbAllowance ?? tenant.kbAllowance,
    max_agents: override?.maxAgents ?? tierCaps.max_agents,
    max_numbers: override?.maxNumbers ?? tierCaps.max_numbers,
    grace_overdraft_credits: config.wallet_policy.grace_overdraft_credits,
    config_version: configVersion,
  };
}

/** Deterministic 0–99 bucket for percentage rollouts: the same workspace always lands the same side. */
export function rolloutBucket(flagKey: string, workspaceId: string): number {
  const digest = createHash('sha256').update(`${flagKey}:${workspaceId}`).digest();
  return digest.readUInt32BE(0) % 100;
}

export function resolveFlags(input: {
  config: PricingConfig;
  configVersion: number;
  tenant: TenantForConfig;
  override: TenantOverrideForConfig | null;
  featureFlags: FeatureFlagRow[];
  killSwitches: KillSwitchRow[];
  now?: Date;
}): FlagsResponse {
  const { config, configVersion, tenant, override, featureFlags, killSwitches } = input;
  const now = input.now ?? new Date();
  const caps = resolveCaps(config, configVersion, tenant, override);

  // Plan gates: the tier's list, then per-tenant overrides on top (either direction).
  const tierGates = new Set<FeatureGate>(tierCapsFor(config, tenant.planTier).feature_gates);
  const gateOverrides = booleanRecord(override?.gatesJson);
  const gates = Object.fromEntries(
    featureGate.options.map((gate) => [gate, gateOverrides[gate] ?? tierGates.has(gate)]),
  ) as Record<FeatureGate, boolean>;

  // Feature flags: tenant_overrides.flags_json wins, then the flag's own per-tenant map,
  // then default_on, then the rollout percentage.
  const flagOverrides = booleanRecord(override?.flagsJson);
  const flags: Record<string, boolean> = {};
  for (const flag of featureFlags) {
    const perTenant = booleanRecord(flag.tenantOverridesJson)[tenant.id];
    flags[flag.key] =
      flagOverrides[flag.key] ??
      perTenant ??
      (flag.defaultOn || rolloutBucket(flag.key, tenant.id) < flag.rolloutPct);
  }

  const kill = Object.fromEntries(killSwitchKey.options.map((k) => [k, false])) as Record<KillSwitchKey, boolean>;
  for (const row of killSwitches) {
    if (!isKillSwitchKey(row.key)) continue;
    kill[row.key] = killSwitchActive(row, now);
  }

  return {
    config_version: configVersion,
    plan_tier: tenant.planTier,
    gates,
    flags,
    kill_switches: kill,
    caps: {
      concurrency_cap: caps.concurrency_cap,
      kb_allowance: caps.kb_allowance,
      max_agents: caps.max_agents,
      max_numbers: caps.max_numbers,
    },
  };
}

/** A switch is only active while `on` and not past its auto-expiry (admin SA12). */
export function killSwitchActive(row: KillSwitchRow, now = new Date()): boolean {
  if (!row.on) return false;
  if (!row.expiresAt) return true;
  return new Date(row.expiresAt).getTime() > now.getTime();
}

export function isKillSwitchKey(key: string): key is KillSwitchKey {
  return (killSwitchKey.options as readonly string[]).includes(key);
}

function booleanRecord(value: unknown): Record<string, boolean> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}
