import { z } from 'zod';
import { type agentTier, planTier } from './enums.js';
import { outboundPolicy } from './outbound.js';

/**
 * The versioned pricing snapshot stored in `pricing_configs.config_json` (admin §5.1).
 *
 * Everything that can change a price, a rate, a cap or an allowance is in here and
 * nowhere else. The API serves it through `GET /pricing` and `GET /flags`, the wallet
 * reads `rates` and `wallet_policy`, the inbound path reads caps from it via `caps:{ws}`,
 * and every row that consumed it stores the version it saw (`calls.config_version`,
 * `credit_lots.policy_version`). A constant in code would make every later billing
 * question unanswerable, so there are none (CLAUDE.md, Configuration).
 */

export const currencyCode = z.enum(['USD', 'CAD']);
export type CurrencyCode = z.infer<typeof currencyCode>;

/** Admin §5 "Feature gates" — what a plan tier unlocks. Read by the portal from GET /flags. */
export const featureGate = z.enum([
  'knowledge_base',
  'premium_voices',
  'multi_agent',
  'pii_removal',
  'denoise',
  'call_my_phone',
  'web_widget',
  'analysis_fields',
  'auto_topup',
  'sip_import',
]);
export type FeatureGate = z.infer<typeof featureGate>;

export const packVisibility = z.enum(['public', 'hidden', 'link_only']);

/** One §5.2 pack, with the admin §5 (SA5 Packs table) fields. Caps ride on the pack. */
export const pricingPack = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/, 'slug'),
  name: z.string().min(1),
  price_cents: z.number().int().positive(),
  currency: currencyCode,
  /** Minutes at Standard. Granted in full on payment. */
  credits: z.number().int().positive(),
  /** Promotional. Granted on top of `credits`, shown as "+50 bonus". */
  bonus_credits: z.number().int().min(0).default(0),
  plan_tier: planTier,
  concurrency_cap: z.number().int().min(0),
  kb_allowance: z.number().int().min(0),
  max_agents: z.number().int().min(0),
  max_numbers: z.number().int().min(0),
  feature_gates: z.array(featureGate).default([]),
  badge: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  sort_order: z.number().int().default(0),
  visibility: packVisibility.default('public'),
  /** ISO country codes the pack is shown in. Empty = everywhere. */
  regions: z.array(z.string().length(2)).default([]),
  active: z.boolean().default(true),
});
export type PricingPack = z.infer<typeof pricingPack>;

/** Admin §5 "Rates". Credits per minute, metered per second (§14.2). */
export const pricingRates = z.object({
  standard_per_min: z.number().positive(),
  premium_per_min: z.number().positive(),
  /** null = the agent's tier rate (the default). */
  web_call_per_min: z.number().positive().nullable().default(null),
  toll_free_surcharge_per_min: z.number().min(0).default(0),
  /** P2, after transfer_bridged. */
  transferred_leg_per_min: z.number().min(0).default(0),
  /** Decimal places a ledger delta is rounded to. §14.2 says 2. */
  rounding_dp: z.literal(2).default(2),
});
export type PricingRates = z.infer<typeof pricingRates>;

/** §5.3 recurring deductions. */
export const pricingRecurring = z.object({
  number_rental_credits: z.number().min(0),
  extra_kb_credits: z.number().min(0),
  release_after_days_at_zero_balance: z.number().int().positive(),
  rental_warning_days: z.array(z.number().int().positive()),
});
export type PricingRecurring = z.infer<typeof pricingRecurring>;

/** §5.4 wallet rules, admin §5 "Wallet policy". */
export const walletPolicy = z.object({
  trial_credits: z.number().min(0),
  trial_validity_days: z.number().int().positive(),
  trial_channel: z.enum(['web']).default('web'),
  credit_expiry_months: z.number().int().positive(),
  /** Balance may fall to −grace so a call is never cut mid-sentence (§5.4). */
  grace_overdraft_credits: z.number().min(0),
  /** Percent of the last pack size, descending. 0 means "balance hit zero". */
  low_balance_thresholds_pct: z.array(z.number().min(0).max(100)),
  auto_topup_default_on: z.boolean(),
  auto_topup_threshold_pct: z.number().min(0).max(100),
  max_first_purchase_cents_without_review: z.number().int().positive(),
  mfa_required_above_balance: z.number().min(0),
});
export type WalletPolicy = z.infer<typeof walletPolicy>;

/** Caps for a workspace that has not bought anything yet (`plan_tier = trial`). */
export const trialCaps = z.object({
  concurrency_cap: z.number().int().min(0),
  kb_allowance: z.number().int().min(0),
  max_agents: z.number().int().min(0),
  max_numbers: z.number().int().min(0),
  feature_gates: z.array(featureGate).default([]),
});

export const pricingConfig = z.object({
  currency_default: currencyCode,
  packs: z.array(pricingPack).min(1),
  rates: pricingRates,
  recurring: pricingRecurring,
  wallet_policy: walletPolicy,
  trial: trialCaps,
  /** P2 (D18) daily caps, the prior-contact window and the calling rules per country (ADR 0031). */
  outbound: outboundPolicy.default({}),
});
export type PricingConfig = z.infer<typeof pricingConfig>;

/** What a tier costs per minute, from a config. The only way code learns a rate. */
export function rateForTier(rates: PricingRates, tier: z.infer<typeof agentTier>): number {
  return tier === 'premium' ? rates.premium_per_min : rates.standard_per_min;
}

/** Fields of a pack the customer may see. Hidden packs and staff-only fields are dropped. */
export const publicPack = pricingPack.pick({
  id: true,
  name: true,
  price_cents: true,
  currency: true,
  credits: true,
  bonus_credits: true,
  plan_tier: true,
  concurrency_cap: true,
  kb_allowance: true,
  max_agents: true,
  max_numbers: true,
  feature_gates: true,
  badge: true,
  description: true,
  sort_order: true,
});
export type PublicPack = z.infer<typeof publicPack>;

/** GET /pricing (§16; admin §5.3 "W7 / D5 pack cards"). Public — W7 renders it before login. */
export const pricingResponse = z.object({
  version: z.number().int(),
  effective_at: z.string(),
  currency: currencyCode,
  packs: z.array(publicPack),
  rates: pricingRates,
  recurring: pricingRecurring,
  wallet_policy: walletPolicy.pick({
    trial_credits: true,
    trial_validity_days: true,
    credit_expiry_months: true,
    grace_overdraft_credits: true,
    low_balance_thresholds_pct: true,
    auto_topup_default_on: true,
    auto_topup_threshold_pct: true,
  }),
});
export type PricingResponse = z.infer<typeof pricingResponse>;

export const pricingQuery = z.object({
  /** ISO country. Filters packs by `regions`; omitted = every public pack. */
  region: z.string().length(2).toUpperCase().optional(),
});

/** The four SA12 kill switches. Each disables one thing without a deploy. */
export const killSwitchKey = z.enum([
  'reject_inbound',
  'pause_web_tests',
  'pause_purchases',
  'pause_generation',
]);
export type KillSwitchKey = z.infer<typeof killSwitchKey>;

/** Effective caps for one workspace: tier defaults ∘ tenant overrides (admin §5.2 step 5). */
export const workspaceCaps = z.object({
  plan_tier: planTier,
  concurrency_cap: z.number().int().min(0),
  kb_allowance: z.number().int().min(0),
  max_agents: z.number().int().min(0),
  max_numbers: z.number().int().min(0),
  grace_overdraft_credits: z.number().min(0),
  /** The pricing_configs.version these came from. */
  config_version: z.number().int(),
});
export type WorkspaceCaps = z.infer<typeof workspaceCaps>;

/** GET /flags — tier defaults ∘ tenant overrides ∘ feature flags (admin §5.3). */
export const flagsResponse = z.object({
  config_version: z.number().int(),
  plan_tier: planTier,
  /** Plan gates after tenant overrides. */
  gates: z.record(featureGate, z.boolean()),
  /** Feature flags after rollout % and per-tenant overrides. */
  flags: z.record(z.string(), z.boolean()),
  kill_switches: z.record(killSwitchKey, z.boolean()),
  caps: workspaceCaps.pick({
    concurrency_cap: true,
    kb_allowance: true,
    max_agents: true,
    max_numbers: true,
  }),
});
export type FlagsResponse = z.infer<typeof flagsResponse>;
