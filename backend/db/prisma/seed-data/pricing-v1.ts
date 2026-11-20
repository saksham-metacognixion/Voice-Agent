import { type PricingConfig, pricingConfig } from '@portal/schemas';

/**
 * pricing_configs version 1 — spec §5.2 packs, §5.3 recurring, §5.4 wallet rules, and the
 * admin §5 defaults (rates, trial caps). This file is the bootstrap of an empty database
 * and nothing else: from here on the numbers live in `pricing_configs` and change through
 * SA5 publish. Code never reads this file; it reads `GET /pricing`.
 *
 * Open items carried as the spec's proposals: trial 20 credits (§20 item 5), Starter
 * = one agent + one number (§20 item 8), USD (§20 item 2).
 */
const ALL_GATES = [
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
] as const;

export const PRICING_V1: PricingConfig = pricingConfig.parse({
  currency_default: 'USD',
  packs: [
    {
      id: 'starter',
      name: 'Starter',
      price_cents: 4_900,
      currency: 'USD',
      credits: 150,
      plan_tier: 'starter',
      concurrency_cap: 2,
      kb_allowance: 0,
      max_agents: 1,
      max_numbers: 1,
      feature_gates: ['call_my_phone', 'auto_topup'],
      description: 'One agent on one number. FAQ text goes in the brief.',
      sort_order: 1,
    },
    {
      id: 'growth',
      name: 'Growth',
      price_cents: 14_900,
      currency: 'USD',
      credits: 500,
      plan_tier: 'growth',
      concurrency_cap: 3,
      kb_allowance: 1,
      max_agents: 3,
      max_numbers: 3,
      feature_gates: ['knowledge_base', 'call_my_phone', 'auto_topup', 'analysis_fields', 'denoise'],
      badge: 'Most popular',
      sort_order: 2,
    },
    {
      id: 'scale',
      name: 'Scale',
      price_cents: 39_900,
      currency: 'USD',
      credits: 1_500,
      plan_tier: 'scale',
      concurrency_cap: 5,
      kb_allowance: 3,
      max_agents: 10,
      max_numbers: 10,
      feature_gates: [...ALL_GATES],
      sort_order: 3,
    },
    {
      id: 'pro',
      name: 'Pro',
      price_cents: 99_900,
      currency: 'USD',
      credits: 4_500,
      plan_tier: 'pro',
      concurrency_cap: 10,
      kb_allowance: 5,
      max_agents: 25,
      max_numbers: 25,
      feature_gates: [...ALL_GATES],
      sort_order: 4,
    },
  ],
  rates: {
    standard_per_min: 1.0,
    premium_per_min: 1.5,
    web_call_per_min: null,
    toll_free_surcharge_per_min: 0.25,
    transferred_leg_per_min: 0.25,
    rounding_dp: 2,
  },
  recurring: {
    number_rental_credits: 15,
    extra_kb_credits: 30,
    release_after_days_at_zero_balance: 30,
    rental_warning_days: [7, 14, 21],
  },
  wallet_policy: {
    trial_credits: 20,
    trial_validity_days: 30,
    trial_channel: 'web',
    credit_expiry_months: 12,
    grace_overdraft_credits: 10,
    low_balance_thresholds_pct: [20, 5, 0],
    auto_topup_default_on: true,
    auto_topup_threshold_pct: 10,
    max_first_purchase_cents_without_review: 100_000,
    mfa_required_above_balance: 1_000,
  },
  trial: { concurrency_cap: 1, kb_allowance: 0, max_agents: 1, max_numbers: 0, feature_gates: [] },
});

/** Admin SA12 kill switches. All off; each row exists so PUT /admin/kill-switches/:key is an update. */
export const KILL_SWITCHES = [
  { key: 'reject_inbound', reason: 'Reject every new inbound call platform-wide (maintenance).' },
  { key: 'pause_web_tests', reason: 'Refuse browser test calls (W5).' },
  { key: 'pause_purchases', reason: 'Refuse POST /wallet/checkout.' },
  { key: 'pause_generation', reason: 'Refuse brief → prompt generation (LLM outage).' },
] as const;

/** Feature flags the P1 portal branches on. Off by default; rollout is a SA12 action. */
export const FEATURE_FLAGS = [
  { key: 'fr_ca', description: 'Serve the fr-CA locale (P1 give-back candidate).', defaultOn: false, rolloutPct: 0 },
  { key: 'outbound_calls', description: 'Phase 2 outbound calling UI.', defaultOn: false, rolloutPct: 0 },
  { key: 'hear_my_greeting', description: 'W3 15-second greeting preview call (P2).', defaultOn: false, rolloutPct: 0 },
] as const;
