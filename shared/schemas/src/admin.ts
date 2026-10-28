import { z } from 'zod';
import { agentStatus, agentTier, memberRole, planTier, reasonCode, staffRole } from './enums.js';
import { isoDateTime, paginationQuery, uuid } from './common.js';
import { pricingConfig } from './pricing.js';
import { phoneNumberStatus } from './numbers.js';
import { callSummary } from './calls.js';
import { jobStatus } from './agents.js';
import { ledgerEntryResponse, purchaseStatus } from './wallet.js';

/*
 * Admin console (admin spec §4, §9 — D12). Every shape a staff route reads or answers
 * with. Staff routes live under `/admin/*`, are verified against the staff tenant only,
 * and never return a Prisma row as-is: the fields here are the contract, chosen so an
 * ops person can run the business without a database client and nothing here leaks a
 * secret (no SIP passwords, no provider keys, no raw Stripe objects).
 */

// ---------------------------------------------------------------------------- me

/** admin §2.2 — what a role may do, from `staff_role_limits`. Read by the shell for permission-aware actions. */
export const staffLimits = z.object({
  credit_adjust_max_per_action: z.number().nullable(),
  credit_adjust_max_per_day: z.number().nullable(),
  refund_max_cents: z.number().int().nullable(),
  can_listen_recordings: z.boolean(),
  can_change_plan: z.boolean(),
  can_pause_tenant: z.boolean(),
  can_edit_pricing_draft: z.boolean(),
  can_publish_pricing: z.boolean(),
  can_edit_agent_stack: z.boolean(),
  can_publish_agent_stack: z.boolean(),
  can_manage_flags: z.boolean(),
  can_view_as_customer: z.boolean(),
  can_act_as_customer: z.boolean(),
  can_delete_customer_data: z.boolean(),
  can_manage_staff: z.boolean(),
  can_export: z.boolean(),
});
export type StaffLimits = z.infer<typeof staffLimits>;

/** GET /admin/me — the signed-in staff member, their role and its limits. */
export const staffMeResponse = z.object({
  id: uuid,
  email: z.string(),
  name: z.string().nullable(),
  role: staffRole,
  limits: staffLimits,
  /** Open view-as sessions this person started (admin §7.4), for the banner. */
  impersonations: z.array(z.lazy(() => impersonationResponse)),
});
export type StaffMeResponse = z.infer<typeof staffMeResponse>;

// ---------------------------------------------------------------------------- KPIs (SA1, Appendix A)

export const adminRange = z.enum(['7d', '30d', '90d']);
export type AdminRange = z.infer<typeof adminRange>;

export const adminKpisQuery = z.object({ range: adminRange.default('30d') });
export type AdminKpisQuery = z.infer<typeof adminKpisQuery>;

export const kpiDay = z.object({
  /** YYYY-MM-DD, UTC. */
  day: z.string(),
  calls: z.number().int(),
  credits_used: z.number(),
  signups: z.number().int(),
  sales_cents: z.number().int(),
});

export const adminKpisResponse = z.object({
  range: adminRange,
  from: isoDateTime,
  to: isoDateTime,
  customers: z.object({
    total: z.number().int(),
    /** ≥ 1 connected call or paid purchase in the trailing 30 days (Appendix A). */
    active: z.number().int(),
    onboarding: z.number().int(),
    paused: z.number().int(),
    /** Balance ≤ 0 for more than three days (SA2 "At risk"). */
    at_risk: z.number().int(),
    new_in_range: z.number().int(),
  }),
  agents: z.object({ live: z.number().int(), draft: z.number().int(), paused: z.number().int() }),
  numbers: z.object({
    active: z.number().int(),
    provisioning: z.number().int(),
    released_in_range: z.number().int(),
  }),
  /** Σ paid purchases in range, by currency (cents), and pack counts. */
  credit_sales: z.object({
    by_currency: z.array(
      z.object({
        currency: z.string(),
        amount_cents: z.number().int(),
        purchases: z.number().int(),
      }),
    ),
    by_pack: z.array(
      z.object({ pack_id: z.string(), purchases: z.number().int(), credits: z.number().int() }),
    ),
  }),
  credits_used: z.object({
    total: z.number(),
    standard: z.number(),
    premium: z.number(),
    test: z.number(),
  }),
  calls: z.object({
    connected: z.number().int(),
    declined: z.number().int(),
    declined_by_reason: z.record(z.number().int()),
    minutes: z.number(),
  }),
  wallet: z.object({
    /** Σ unexpired `credit_lots.credits_remaining` — the deferred liability in credits. */
    outstanding_credits: z.number(),
    expired_in_range: z.number(),
  }),
  /** `allowance` is null when no platform limit is set (`CONCURRENCY_PLATFORM_LIMIT`) — never a 0 to divide by. */
  concurrency: z.object({ live: z.number().int().nullable(), allowance: z.number().int().nullable() }),
  knowledge: z.object({ bases: z.number().int() }),
  /** SA1 "needs attention" — links into SA12 / SA2. */
  attention: z.object({
    failed_jobs_24h: z.number().int(),
    unprocessed_webhooks: z.number().int(),
    overdue_rentals: z.number().int(),
    open_alerts: z.number().int(),
    pending_purchases: z.number().int(),
    /** D13: `activate-agent` jobs that failed in the last 24 h (SA7 provisioning queue). */
    failed_activations_24h: z.number().int(),
    /** D13: auto top-ups abandoned in the last 24 h (SA9 failed top-ups). */
    failed_topups_24h: z.number().int(),
    /** D13: paid workspaces older than 7 days that never finished the wizard, not paused. */
    onboarding_stuck: z.number().int(),
  }),
  series: z.array(kpiDay),
});
export type AdminKpisResponse = z.infer<typeof adminKpisResponse>;

export const funnelStep = z.object({ key: z.string(), label: z.string(), count: z.number().int() });

/** GET /admin/kpis/funnel — sign-up → live, cohort = tenants created in range. */
export const adminFunnelResponse = z.object({
  range: adminRange,
  cohort_size: z.number().int(),
  steps: z.array(funnelStep),
  /** Tenants that paid ÷ tenants that signed up (Appendix A "Activation rate"). */
  activation_rate: z.number().nullable(),
  /** Median minutes sign-up → onboarding_completed_at (Appendix A "Time to live"). */
  median_minutes_to_live: z.number().nullable(),
  /** Where the unfinished ones are stuck: onboarding_step → count. */
  stuck_by_step: z.array(z.object({ step: z.number().int(), count: z.number().int() })),
});
export type AdminFunnelResponse = z.infer<typeof adminFunnelResponse>;

// ---------------------------------------------------------------------------- customers (SA2)

export const adminCustomerStatus = z.enum(['active', 'onboarding', 'paused', 'at_risk', 'churned']);
export type AdminCustomerStatus = z.infer<typeof adminCustomerStatus>;

export const adminCustomersQuery = paginationQuery.extend({
  q: z.string().trim().min(1).max(120).optional(),
  plan: planTier.optional(),
  status: adminCustomerStatus.optional(),
  country: z.string().length(2).optional(),
  sort: z.enum(['created_at', 'name', 'balance', 'last_activity']).default('created_at'),
  order: z.enum(['asc', 'desc']).default('desc'),
});
export type AdminCustomersQuery = z.infer<typeof adminCustomersQuery>;

export const adminCustomerSummary = z.object({
  id: uuid,
  name: z.string(),
  country: z.string(),
  plan_tier: planTier,
  status: adminCustomerStatus,
  paused_reason: z.string().nullable(),
  onboarding_step: z.number().int(),
  onboarding_completed_at: isoDateTime.nullable(),
  balance: z.number(),
  last_pack_credits: z.number().nullable(),
  usage_30d: z.number(),
  agents_live: z.number().int(),
  agents_total: z.number().int(),
  numbers_active: z.number().int(),
  owner_email: z.string().nullable(),
  last_activity_at: isoDateTime.nullable(),
  flags: z.array(z.string()),
  custom_deal: z.boolean(),
  created_at: isoDateTime,
});
export type AdminCustomerSummary = z.infer<typeof adminCustomerSummary>;

export const adminOverrides = z.object({
  concurrency_cap: z.number().int().nullable(),
  kb_allowance: z.number().int().nullable(),
  max_agents: z.number().int().nullable(),
  max_numbers: z.number().int().nullable(),
  reason: z.string().nullable(),
  updated_at: isoDateTime.nullable(),
});

/** GET /admin/customers/:id — the SA2 header and Overview tab. */
export const adminCustomerDetail = adminCustomerSummary.extend({
  timezone: z.string(),
  website: z.string().nullable(),
  concurrency_cap: z.number().int(),
  kb_allowance: z.number().int(),
  stripe_customer_id: z.string().nullable(),
  paused_at: isoDateTime.nullable(),
  auto_topup_enabled: z.boolean(),
  members: z.number().int(),
  calls_30d: z.number().int(),
  purchases_paid: z.number().int(),
  lifetime_sales_cents: z.number().int(),
  overrides: adminOverrides.nullable(),
  open_alerts: z.number().int(),
  /** Open impersonation sessions on this workspace, any staff member. */
  impersonations_open: z.number().int(),
});
export type AdminCustomerDetail = z.infer<typeof adminCustomerDetail>;

export const adminMemberResponse = z.object({
  id: uuid,
  user_id: uuid,
  email: z.string(),
  name: z.string().nullable(),
  role: memberRole,
  mfa_enabled: z.boolean(),
  locked_at: isoDateTime.nullable(),
  joined_at: isoDateTime,
});
export type AdminMemberResponse = z.infer<typeof adminMemberResponse>;

export const adminCustomerWallet = z.object({
  balance: z.number(),
  last_pack_credits: z.number().nullable(),
  lots: z.array(
    z.object({
      id: uuid,
      purchase_id: uuid.nullable(),
      credits_total: z.number(),
      credits_remaining: z.number(),
      expires_at: isoDateTime,
      created_at: isoDateTime,
    }),
  ),
  ledger: z.array(ledgerEntryResponse),
  ledger_next_cursor: z.string().nullable(),
  adjustments: z.array(
    z.object({
      id: uuid,
      ledger_id: uuid,
      delta: z.number(),
      reason_code: reasonCode,
      note: z.string().nullable(),
      customer_text: z.string().nullable(),
      staff_email: z.string().nullable(),
      created_at: isoDateTime,
    }),
  ),
});
export type AdminCustomerWallet = z.infer<typeof adminCustomerWallet>;

export const adminPurchaseResponse = z.object({
  id: uuid,
  tenant_id: uuid,
  pack_id: z.string().nullable(),
  amount_cents: z.number().int(),
  currency: z.string(),
  credits: z.number().int(),
  status: purchaseStatus,
  is_auto_topup: z.boolean(),
  failure_reason: z.string().nullable(),
  stripe_session_id: z.string().nullable(),
  stripe_payment_intent: z.string().nullable(),
  invoice_url: z.string().nullable(),
  created_at: isoDateTime,
  updated_at: isoDateTime,
});
export type AdminPurchaseResponse = z.infer<typeof adminPurchaseResponse>;

export const adminAgentResponse = z.object({
  id: uuid,
  tenant_id: uuid,
  tenant_name: z.string(),
  name: z.string(),
  template_id: z.string().nullable(),
  industry: z.string().nullable(),
  tier: agentTier,
  status: agentStatus,
  draft_version: z.number().int().nullable(),
  published_version: z.number().int().nullable(),
  numbers: z.array(z.object({ id: uuid, e164: z.string().nullable(), status: phoneNumberStatus })),
  knowledge_sources: z.number().int(),
  calls_7d: z.number().int(),
  deleted_at: isoDateTime.nullable(),
  created_at: isoDateTime,
});
export type AdminAgentResponse = z.infer<typeof adminAgentResponse>;

export const adminNumberResponse = z.object({
  id: uuid,
  tenant_id: uuid,
  tenant_name: z.string(),
  agent_id: uuid.nullable(),
  agent_name: z.string().nullable(),
  e164: z.string().nullable(),
  type: z.string(),
  status: phoneNumberStatus,
  paused_at: isoDateTime.nullable(),
  forwarding_status: z.string().nullable(),
  rental_credits: z.number().int(),
  next_rental_at: isoDateTime.nullable(),
  rental_overdue_since: isoDateTime.nullable(),
  error: z.string().nullable(),
  calls_7d: z.number().int(),
  created_at: isoDateTime,
});
export type AdminNumberResponse = z.infer<typeof adminNumberResponse>;

export const adminNumbersQuery = paginationQuery.extend({
  q: z.string().trim().min(1).max(60).optional(),
  status: phoneNumberStatus.optional(),
  tenant_id: uuid.optional(),
  /** `true`: only numbers with an unpaid rental (SA1 "Overdue number rentals" links here). */
  rental_overdue: z.enum(['true', 'false']).optional(),
});
export type AdminNumbersQuery = z.infer<typeof adminNumbersQuery>;

export const adminAgentsQuery = paginationQuery.extend({
  q: z.string().trim().min(1).max(60).optional(),
  status: agentStatus.optional(),
  tenant_id: uuid.optional(),
});
export type AdminAgentsQuery = z.infer<typeof adminAgentsQuery>;

export const adminCallsQuery = paginationQuery.extend({
  tenant_id: uuid.optional(),
  status: z.enum(['registered', 'in_progress', 'ended', 'analyzed', 'missed']).optional(),
  q: z.string().trim().min(1).max(80).optional(),
});
export type AdminCallsQuery = z.infer<typeof adminCallsQuery>;

/** Staff see the customer's row plus who it belongs to; never the transcript in a list. */
export const adminCallResponse = callSummary.extend({
  tenant_id: uuid,
  tenant_name: z.string(),
  agent_name: z.string().nullable(),
  retell_cost_cents: z.number().int().nullable(),
});
export type AdminCallResponse = z.infer<typeof adminCallResponse>;

/** Every customer-affecting staff write carries a reason (admin §10, Appendix B). */
/** The longest note a staff reason accepts; the console's textarea reads the same number (QA-050). */
export const STAFF_NOTE_MAX = 1000;
/** View-as notes are shorter: they are shown on the customer-side banner record. */
export const IMPERSONATE_NOTE_MAX = 500;
/** Pricing publish and rollback notes; the console's dialogs read the same number (QA-053). */
export const PRICING_NOTE_MAX = 500;

export const staffActionRequest = z
  .object({
    reason_code: reasonCode,
    note: z.string().trim().min(1).max(STAFF_NOTE_MAX).optional(),
    ticket_id: z.number().int().positive().optional(),
  })
  .refine((v) => v.reason_code !== 'other' || Boolean(v.note), {
    message: 'A note is required with reason "other".',
    path: ['note'],
  });
export type StaffActionRequest = z.infer<typeof staffActionRequest>;

export const adminCreditAdjustRequest = z
  .object({
    /** Credits to add (positive) or remove (negative). Never zero. 2 dp. */
    delta: z
      .number()
      .refine((v) => v !== 0, 'Delta cannot be zero')
      .refine((v) => Math.abs(v) <= 1_000_000, 'Delta is out of range'),
    reason_code: reasonCode,
    note: z.string().trim().min(1).max(1000).optional(),
    /** Shown to the customer in D5 beside the ledger row. */
    customer_text: z.string().trim().min(1).max(200).optional(),
    ticket_id: z.number().int().positive().optional(),
    /**
     * One per intended adjustment (the console makes one when the dialog opens). A second
     * request with the same key — a double click, a retry after a timeout, a second tab —
     * answers the first adjustment instead of moving credits again. It becomes the adjustment id.
     */
    idempotency_key: uuid.optional(),
  })
  .refine((v) => v.reason_code !== 'other' || Boolean(v.note), {
    message: 'A note is required with reason "other".',
    path: ['note'],
  });
export type AdminCreditAdjustRequest = z.infer<typeof adminCreditAdjustRequest>;

export const adminCreditAdjustResponse = z.object({
  adjustment_id: uuid,
  ledger_id: uuid,
  delta: z.number(),
  balance_after: z.number(),
});
export type AdminCreditAdjustResponse = z.infer<typeof adminCreditAdjustResponse>;

export const adminTenantStatusResponse = z.object({
  id: uuid,
  paused: z.boolean(),
  paused_at: isoDateTime.nullable(),
  paused_reason: z.string().nullable(),
});
export type AdminTenantStatusResponse = z.infer<typeof adminTenantStatusResponse>;

// ---------------------------------------------------------------------------- users (SA3)

export const adminUsersQuery = paginationQuery.extend({
  q: z.string().trim().min(1).max(120).optional(),
  tenant_id: uuid.optional(),
});
export type AdminUsersQuery = z.infer<typeof adminUsersQuery>;

export const adminUserResponse = z.object({
  id: uuid,
  email: z.string(),
  name: z.string().nullable(),
  mfa_enabled: z.boolean(),
  /** From Auth0 when the Management API is configured; null when it is not reachable. */
  email_verified: z.boolean().nullable(),
  locked_at: isoDateTime.nullable(),
  locked_reason: z.string().nullable(),
  /** SA3 force logout / lock: tokens issued at or before this are refused by the API. */
  sessions_revoked_at: isoDateTime.nullable(),
  created_at: isoDateTime,
  memberships: z.array(z.object({ tenant_id: uuid, tenant_name: z.string(), role: memberRole })),
});
export type AdminUserResponse = z.infer<typeof adminUserResponse>;

export const adminUserActionResponse = z.object({
  user: adminUserResponse,
  /** `applied` = the identity provider was updated; `skipped` = no Management API configured (dev), local state only. */
  /** `failed` only on force logout: our own revocation held, the identity provider refused (see `provider_error`). */
  provider: z.enum(['applied', 'skipped', 'failed']),
  /** Force logout's failure, or a lock whose session revoke the provider refused (QA-042). */
  provider_error: z.string().nullable().optional(),
});
export type AdminUserActionResponse = z.infer<typeof adminUserActionResponse>;

// ---------------------------------------------------------------------------- jobs (SA12)

export const queueJobState = z.enum([
  'missing',
  'unknown',
  'completed',
  'failed',
  'delayed',
  'active',
  'waiting',
  'waiting-children',
  'prioritized',
]);

export const adminJobsQuery = paginationQuery.extend({
  status: jobStatus.optional(),
  type: z.string().trim().min(1).max(60).optional(),
  tenant_id: uuid.optional(),
});
export type AdminJobsQuery = z.infer<typeof adminJobsQuery>;

export const adminJobResponse = z.object({
  id: uuid,
  type: z.string(),
  status: jobStatus,
  tenant_id: uuid.nullable(),
  tenant_name: z.string().nullable(),
  agent_id: uuid.nullable(),
  created_at: isoDateTime,
  updated_at: isoDateTime,
  started_at: isoDateTime.nullable(),
  finished_at: isoDateTime.nullable(),
  /** Attempts made so far, from the queue when it still holds the job, else from the row. */
  attempts: z.number().int(),
  queue_state: queueJobState.nullable(),
  error: z.string().nullable(),
  customer_reason: z.string().nullable(),
  can_retry: z.boolean(),
  can_discard: z.boolean(),
  /** `steps_json`, staff-only. Bounded to what fits a detail panel. */
  steps: z.record(z.unknown()),
});
export type AdminJobResponse = z.infer<typeof adminJobResponse>;

// ---------------------------------------------------------------------------- webhooks (SA12)

export const webhookProcessingStatus = z.enum(['processed', 'pending', 'failed']);

export const adminWebhookEventsQuery = paginationQuery.extend({
  provider: z.enum(['retell', 'stripe', 'auth']).optional(),
  status: webhookProcessingStatus.optional(),
  q: z.string().trim().min(1).max(120).optional(),
  tenant_id: uuid.optional(),
});
export type AdminWebhookEventsQuery = z.infer<typeof adminWebhookEventsQuery>;

export const adminWebhookEventResponse = z.object({
  id: uuid,
  provider: z.string(),
  external_id: z.string(),
  event_type: z.string(),
  status: webhookProcessingStatus,
  tenant_id: uuid.nullable(),
  tenant_name: z.string().nullable(),
  received_at: isoDateTime,
  processed_at: isoDateTime.nullable(),
  error: z.string().nullable(),
  queue_state: queueJobState.nullable(),
  attempts: z.number().int().nullable(),
});
export type AdminWebhookEventResponse = z.infer<typeof adminWebhookEventResponse>;

export const adminWebhookEventDetail = adminWebhookEventResponse.extend({
  /**
   * The stored body. Staff-only; a Stripe event carries no card data and a Retell one no key.
   * Recording links, transcripts and the call summary are blanked unless the viewer's role
   * has `can_listen_recordings` (QA-033), and every view is audited (`webhook.payload_viewed`).
   */
  payload: z.unknown(),
  /** True when this viewer's copy had recording or transcript fields blanked. */
  payload_redacted: z.boolean(),
});
export type AdminWebhookEventDetail = z.infer<typeof adminWebhookEventDetail>;

export const adminWebhookReplayResponse = z.object({
  event: adminWebhookEventResponse,
  outcome: z.string(),
  reason: z.string().nullable(),
});
export type AdminWebhookReplayResponse = z.infer<typeof adminWebhookReplayResponse>;

// ---------------------------------------------------------------------------- flags and kill switches (SA12)

export const adminFeatureFlag = z.object({
  key: z.string(),
  description: z.string().nullable(),
  default_on: z.boolean(),
  rollout_pct: z.number().int().min(0).max(100),
  tenant_overrides: z.record(z.boolean()),
});
export type AdminFeatureFlag = z.infer<typeof adminFeatureFlag>;

/**
 * A feature-flag key: lower-case letters, digits and underscores, 2–64 characters. The
 * API refuses anything else and the console validates with the same pattern (QA-046).
 */
export const FLAG_KEY_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

/**
 * A flag change moves what customers see, so it carries a reason like every other staff
 * write (admin Appendix B, QA-035): required, and a note required with `other`.
 */
export const adminUpsertFlagRequest = z
  .object({
    description: z.string().trim().max(300).nullable().optional(),
    default_on: z.boolean().optional(),
    rollout_pct: z.number().int().min(0).max(100).optional(),
    tenant_overrides: z.record(z.boolean()).optional(),
    reason_code: reasonCode,
    note: z.string().trim().min(1).max(500).optional(),
  })
  .refine((v) => v.reason_code !== 'other' || Boolean(v.note), {
    message: 'A note is required with reason "other".',
    path: ['note'],
  });
export type AdminUpsertFlagRequest = z.infer<typeof adminUpsertFlagRequest>;

export const adminKillSwitch = z.object({
  key: z.string(),
  description: z.string(),
  on: z.boolean(),
  /** `on` and not past `expires_at`. */
  active: z.boolean(),
  reason: z.string().nullable(),
  set_by: uuid.nullable(),
  set_by_email: z.string().nullable(),
  expires_at: isoDateTime.nullable(),
  updated_at: isoDateTime.nullable(),
});
export type AdminKillSwitch = z.infer<typeof adminKillSwitch>;

/**
 * Both directions carry an Appendix B reason code (every customer-affecting staff write
 * does; review, 28 Sep). `reason` is the free-text line shown on the SA12 card while the
 * switch is on; it defaults to the code and note.
 */
export const adminSetKillSwitchRequest = z
  .object({
    on: z.boolean(),
    reason_code: reasonCode,
    note: z.string().trim().min(1).max(1000).optional(),
    ticket_id: z.number().int().positive().optional(),
    reason: z.string().trim().min(1).max(300).optional(),
    expires_at: isoDateTime.nullable().optional(),
  })
  .refine((v) => v.reason_code !== 'other' || Boolean(v.note), {
    message: 'A note is required with reason "other".',
    path: ['note'],
  });
export type AdminSetKillSwitchRequest = z.infer<typeof adminSetKillSwitchRequest>;

export const adminFlagsResponse = z.object({
  flags: z.array(adminFeatureFlag),
  kill_switches: z.array(adminKillSwitch),
});
export type AdminFlagsResponse = z.infer<typeof adminFlagsResponse>;

// ---------------------------------------------------------------------------- pricing (SA5, admin §5)

export const stripeSyncStatus = z.enum(['pending', 'synced', 'skipped', 'failed']);

export const stripePriceRow = z.object({
  pack_id: z.string(),
  currency: z.string(),
  stripe_product_id: z.string(),
  stripe_price_id: z.string(),
  active: z.boolean(),
});

/** What happened to Stripe for one published version (admin §5.2 step 3). */
export const stripeSyncResult = z.object({
  status: stripeSyncStatus,
  synced_at: isoDateTime.nullable(),
  error: z.string().nullable(),
  prices: z.array(stripePriceRow),
});
export type StripeSyncResult = z.infer<typeof stripeSyncResult>;

export const adminPricingVersion = z.object({
  version: z.number().int(),
  published_at: isoDateTime.nullable(),
  effective_at: isoDateTime.nullable(),
  published_by: uuid.nullable(),
  published_by_email: z.string().nullable(),
  change_summary: z.string().nullable(),
  grandfather_mode: z.string().nullable(),
  /** In effect now: the newest version whose `effective_at` has passed. */
  is_current: z.boolean(),
  stripe_sync: stripeSyncResult,
  packs: z.number().int(),
});
export type AdminPricingVersion = z.infer<typeof adminPricingVersion>;

export const adminPricingVersionDetail = adminPricingVersion.extend({ config: pricingConfig });
export type AdminPricingVersionDetail = z.infer<typeof adminPricingVersionDetail>;

export const adminPricingDraftResponse = z.object({
  /** null when no draft exists: the editor starts from the current config. */
  id: uuid.nullable(),
  based_on_version: z.number().int().nullable(),
  current_version: z.number().int(),
  config: pricingConfig,
  edited_by: uuid.nullable(),
  edited_by_email: z.string().nullable(),
  updated_at: isoDateTime.nullable(),
});
export type AdminPricingDraftResponse = z.infer<typeof adminPricingDraftResponse>;

export const adminPricingDraftRequest = z.object({ config: pricingConfig });
export type AdminPricingDraftRequest = z.infer<typeof adminPricingDraftRequest>;

export const pricingChange = z.object({
  /** Dotted path, e.g. `rates.premium_per_min`, `packs.growth.price_cents`. */
  path: z.string(),
  before: z.unknown(),
  after: z.unknown(),
});

/** Margin per tier from the Retell cost inputs (admin §5.4, Appendix A). */
export const pricingMargin = z.object({
  tier: agentTier,
  /** Cents a customer pays per credit at the cheapest public pack. */
  revenue_cents_per_min: z.number(),
  /** Retell cost per minute, from `retell_cost_inputs`; null when no inputs are set. */
  cost_cents_per_min: z.number().nullable(),
  margin_pct: z.number().nullable(),
  floor_pct: z.number().nullable(),
  below_floor: z.boolean(),
});

export const stripePlannedAction = z.object({
  pack_id: z.string(),
  currency: z.string(),
  action: z.enum(['reuse', 'create', 'archive']),
  detail: z.string(),
});

export const adminPricingPreviewResponse = z.object({
  current_version: z.number().int(),
  next_version: z.number().int(),
  has_draft: z.boolean(),
  changes: z.array(pricingChange),
  packs: z.object({
    added: z.array(z.string()),
    removed: z.array(z.string()),
    changed: z.array(z.string()),
  }),
  margins: z.array(pricingMargin),
  stripe: z.array(stripePlannedAction),
  /** Reasons publish will refuse without an override (admin §5.4). */
  blockers: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type AdminPricingPreviewResponse = z.infer<typeof adminPricingPreviewResponse>;

/**
 * Publishing or rolling back pricing changes what every customer pays, so it carries a
 * reason like every other customer-affecting staff write (admin Appendix B, QA-039).
 */
export const adminPricingPublishRequest = z
  .object({
    effective_at: isoDateTime.optional(),
    grandfather_mode: z
      .enum(['keep_until_next_purchase', 'apply_now'])
      .default('keep_until_next_purchase'),
    change_summary: z.string().trim().min(1).max(500).optional(),
    /** Publish past a margin-floor blocker (super admin, with a note). */
    override_margin: z.boolean().default(false),
    reason_code: reasonCode,
    note: z.string().trim().min(1).max(PRICING_NOTE_MAX).optional(),
    ticket_id: z.number().int().positive().optional(),
  })
  .refine((v) => v.reason_code !== 'other' || Boolean(v.note), {
    message: 'A note is required with reason "other".',
    path: ['note'],
  });
export type AdminPricingPublishRequest = z.infer<typeof adminPricingPublishRequest>;

/** Rollback takes publish's checks too (QA-040): the margin floor can be overridden the same way. */
export const adminPricingRollbackRequest = z
  .object({
    override_margin: z.boolean().default(false),
    reason_code: reasonCode,
    note: z.string().trim().min(1).max(PRICING_NOTE_MAX).optional(),
    ticket_id: z.number().int().positive().optional(),
  })
  .refine((v) => v.reason_code !== 'other' || Boolean(v.note), {
    message: 'A note is required with reason "other".',
    path: ['note'],
  });
export type AdminPricingRollbackRequest = z.infer<typeof adminPricingRollbackRequest>;

/** `PUT /admin/retell-costs` — what a minute costs us, for the margin check. */
export const retellCostInputs = z.object({
  standard_cents_per_min: z.number().min(0),
  premium_cents_per_min: z.number().min(0),
  /** Publish is blocked below this gross margin unless overridden. */
  margin_floor_pct: z.number().min(0).max(100),
});
export type RetellCostInputs = z.infer<typeof retellCostInputs>;

export const adminRetellCostsResponse = z.object({
  version: z.number().int().nullable(),
  costs: retellCostInputs.nullable(),
  updated_by_email: z.string().nullable(),
  updated_at: isoDateTime.nullable(),
});
export type AdminRetellCostsResponse = z.infer<typeof adminRetellCostsResponse>;

// ---------------------------------------------------------------------------- impersonation (admin §7.4)

export const impersonationMode = z.enum(['view']);

/** Starting a view-as session is a customer-affecting staff action: the reason is chosen, never defaulted (review, 28 Sep). */
export const adminImpersonateRequest = z
  .object({
    mode: impersonationMode.default('view'),
    reason_code: reasonCode,
    note: z.string().trim().min(1).max(IMPERSONATE_NOTE_MAX).optional(),
    ticket_id: z.number().int().positive().optional(),
  })
  .refine((v) => v.reason_code !== 'other' || Boolean(v.note), {
    message: 'A note is required with reason "other".',
    path: ['note'],
  });
export type AdminImpersonateRequest = z.infer<typeof adminImpersonateRequest>;

export const impersonationResponse = z.object({
  id: uuid,
  tenant_id: uuid,
  tenant_name: z.string(),
  staff_id: uuid,
  staff_email: z.string().nullable(),
  mode: impersonationMode,
  started_at: isoDateTime,
  expires_at: isoDateTime,
  ended_at: isoDateTime.nullable(),
  /**
   * Where the staff member opens the read-only portal. Set on the create response and on
   * `POST /admin/impersonations/:id/open` (a fresh key for an open session — the console
   * banner's "Open portal" after the portal tab was closed); null on the lists.
   */
  portal_url: z.string().nullable(),
});
export type ImpersonationResponse = z.infer<typeof impersonationResponse>;

export const endedResponse = z.object({ ended: z.boolean() });
export type EndedResponse = z.infer<typeof endedResponse>;

/** GET /impersonation — what the portal shows in its banner while a staff session is active. */
export const impersonationContext = z.object({
  id: uuid,
  tenant_id: uuid,
  tenant_name: z.string(),
  mode: impersonationMode,
  staff_email: z.string().nullable(),
  expires_at: isoDateTime,
});
export type ImpersonationContext = z.infer<typeof impersonationContext>;

// ---------------------------------------------------------------------------- search (admin §3)

export const adminSearchQuery = z.object({
  q: z.string().trim().min(2).max(120),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type AdminSearchQuery = z.infer<typeof adminSearchQuery>;

export const adminSearchEntity = z.enum([
  'customer',
  'user',
  'agent',
  'number',
  'call',
  'job',
  'webhook_event',
  'purchase',
]);
export type AdminSearchEntity = z.infer<typeof adminSearchEntity>;

export const adminSearchResult = z.object({
  type: adminSearchEntity,
  id: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  status: z.string().nullable(),
  tenant_id: uuid.nullable(),
  tenant_name: z.string().nullable(),
});
export type AdminSearchResult = z.infer<typeof adminSearchResult>;

export const adminSearchResponse = z.object({ q: z.string(), results: z.array(adminSearchResult) });
export type AdminSearchResponse = z.infer<typeof adminSearchResponse>;

// ---------------------------------------------------------------------------- system health (admin §3 health strip)

export const healthSignal = z.enum(['ok', 'warn', 'down', 'unknown']);

export const adminHealthCheck = z.object({
  signal: healthSignal,
  detail: z.string().nullable(),
  latency_ms: z.number().nullable(),
});

export const adminSystemHealthResponse = z.object({
  time: isoDateTime,
  env: z.string(),
  api: adminHealthCheck,
  postgres: adminHealthCheck,
  redis: adminHealthCheck,
  worker: adminHealthCheck.extend({
    last_seen: isoDateTime.nullable(),
    schedulers: z.number().int().nullable(),
  }),
  retell: adminHealthCheck,
  stripe: adminHealthCheck.extend({
    last_webhook_at: isoDateTime.nullable(),
    unprocessed: z.number().int(),
  }),
  webhooks: adminHealthCheck.extend({ unprocessed: z.number().int(), failed: z.number().int() }),
  jobs: adminHealthCheck.extend({ failed_24h: z.number().int(), queued: z.number().int() }),
  concurrency: adminHealthCheck.extend({
    live: z.number().int().nullable(),
    /** Null when no platform limit is set. */
    allowance: z.number().int().nullable(),
  }),
  kill_switches_on: z.array(z.string()),
});
export type AdminSystemHealthResponse = z.infer<typeof adminSystemHealthResponse>;

/**
 * D14 diagnostics: a test ops alert through every configured sink (Slack is the webhook
 * sink), with what each answered. The log line is always written as well.
 */
export const adminTestAlertResponse = z.object({
  delivered: z.array(z.object({ sink: z.string(), ok: z.boolean(), error: z.string().optional() })),
});
export type AdminTestAlertResponse = z.infer<typeof adminTestAlertResponse>;

// ---------------------------------------------------------------------------- audit (SA14)

/**
 * The SA14 filters, shared by the list and the CSV export. `staff` and `customer` are what
 * a person types — part of an email or a name, or a pasted id — because the console never
 * shows a staff id and shows a workspace id only on the Customer 360 header (QA: audit
 * filters needed a UUID). The `_id` forms stay for links.
 */
export const adminAuditFilters = z.object({
  staff_id: uuid.optional(),
  /** Part of a staff email or name, case ignored; an id is matched exactly. */
  staff: z.string().trim().min(1).max(120).optional(),
  tenant_id: uuid.optional(),
  /** Part of a customer (workspace) name, case ignored; an id is matched exactly. */
  customer: z.string().trim().min(1).max(120).optional(),
  action: z.string().trim().min(1).max(80).optional(),
  target_id: z.string().trim().min(1).max(120).optional(),
});
export type AdminAuditFilters = z.infer<typeof adminAuditFilters>;

export const adminAuditQuery = paginationQuery.extend(adminAuditFilters.shape);
export type AdminAuditQuery = z.infer<typeof adminAuditQuery>;

/** GET /admin/audit/export — the filtered rows as CSV, newest first, at most this many. */
export const ADMIN_AUDIT_EXPORT_MAX_ROWS = 10_000;

export const adminAuditEntry = z.object({
  id: uuid,
  staff_id: uuid,
  staff_email: z.string().nullable(),
  action: z.string(),
  target_type: z.string().nullable(),
  target_id: z.string().nullable(),
  tenant_id: uuid.nullable(),
  tenant_name: z.string().nullable(),
  reason_code: reasonCode.nullable(),
  note: z.string().nullable(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  ip: z.string().nullable(),
  impersonation_id: uuid.nullable(),
  request_id: z.string().nullable(),
  created_at: isoDateTime,
});
export type AdminAuditEntry = z.infer<typeof adminAuditEntry>;

/** The customer-visible `audit_log` rows for one workspace, as staff see them (SA2 Audit tab). */
export const adminCustomerAuditEntry = z.object({
  id: uuid,
  action: z.string(),
  target_type: z.string().nullable(),
  target_id: z.string().nullable(),
  actor_email: z.string().nullable(),
  ip: z.string().nullable(),
  meta: z.unknown().nullable(),
  created_at: isoDateTime,
});
export type AdminCustomerAuditEntry = z.infer<typeof adminCustomerAuditEntry>;

export const adminCustomerAuditQuery = paginationQuery.extend({
  source: z.enum(['customer', 'staff']).default('customer'),
});
export type AdminCustomerAuditQuery = z.infer<typeof adminCustomerAuditQuery>;

/**
 * The admin §2.2 matrix as the routes apply it (`@StaffRoles`): one list per group, read by
 * the controllers and by the console's permission checks, so a button the API would answer
 * 403 FORBIDDEN_ROLE to is never enabled because a limit was ticked in SA13 (QA-048).
 * The finer `staff_role_limits` are checked on top, in both places.
 */
export const STAFF_ROUTE_ROLES = {
  /** Agent, number, user and workspace pause/resume, the support desk's writes. */
  mutate: ['super_admin', 'ops', 'support'],
  /** Credit adjustments, refunds and top-up actions. */
  money: ['super_admin', 'ops', 'finance', 'support'],
  /** Jobs, webhook replays, flags and kill switches. */
  system: ['super_admin', 'ops'],
  /** The pricing draft and the cost inputs. */
  pricingEdit: ['super_admin', 'finance'],
  /** Pricing publish and rollback. */
  pricingPublish: ['super_admin'],
  /** Starting a read-only view-as session. */
  viewAs: ['super_admin', 'ops', 'finance', 'support'],
  /** A stored webhook body (QA-033); its contents are narrowed again by `can_listen_recordings`. */
  payloadView: ['super_admin', 'ops', 'finance', 'support'],
} as const satisfies Record<string, ReadonlyArray<z.infer<typeof staffRole>>>;
