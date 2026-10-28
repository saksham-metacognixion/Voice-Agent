import { z } from 'zod';
import { reasonCode } from './enums.js';
import { isoDateTime, paginationQuery, uuid } from './common.js';
import { ledgerEntryResponse, purchaseStatus } from './wallet.js';
import { adminPurchaseResponse, adminRange } from './admin.js';

/*
 * SA9 Billing & finance (admin spec §4 SA9, §11 P1 — D13): purchases across workspaces,
 * refunds, failed auto top-ups and the basic revenue report. Nothing here is a raw Stripe
 * object: a refund carries our row and the Stripe refund id, an invoice its hosted link,
 * a card its last four digits at most.
 */

// ---------------------------------------------------------------------------- purchases

export const adminPurchasesQuery = paginationQuery.extend({
  /** Tenant name (contains), a purchase uuid, a Stripe session id or a PaymentIntent id. */
  q: z.string().trim().min(1).max(120).optional(),
  status: purchaseStatus.optional(),
  tenant_id: uuid.optional(),
  /** Query strings are text: `true` / `false`. */
  is_auto_topup: z.enum(['true', 'false']).optional(),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
});
export type AdminPurchasesQuery = z.infer<typeof adminPurchasesQuery>;

/** A purchase as SA9 lists it: the SA2 row plus who bought it and what is left to refund. */
export const adminBillingPurchase = adminPurchaseResponse.extend({
  tenant_name: z.string(),
  pack_name: z.string().nullable(),
  /** Σ succeeded refunds, cents. */
  refunded_cents: z.number().int(),
  /** `amount_cents − refunded_cents` for a paid purchase, else 0. */
  refundable_cents: z.number().int(),
});
export type AdminBillingPurchase = z.infer<typeof adminBillingPurchase>;

export const refundStatus = z.enum(['pending', 'succeeded', 'failed']);
export type RefundStatus = z.infer<typeof refundStatus>;

export const adminRefundResponse = z.object({
  id: uuid,
  purchase_id: uuid,
  amount_cents: z.number().int(),
  credits_reversed: z.number(),
  status: refundStatus,
  reason_code: reasonCode,
  staff: z.object({ id: uuid, name: z.string().nullable(), email: z.string().nullable() }),
  stripe_refund_id: z.string().nullable(),
  created_at: isoDateTime,
});
export type AdminRefundResponse = z.infer<typeof adminRefundResponse>;

/** The mirrored Stripe invoice for a purchase (D6 `invoices`), else the link the fulfilment stored. */
export const adminPurchaseInvoice = z.object({
  number: z.string().nullable(),
  status: z.string().nullable(),
  amount_paid_cents: z.number().int().nullable(),
  hosted_url: z.string().nullable(),
  pdf_url: z.string().nullable(),
});

export const adminPurchaseDetail = adminBillingPurchase.extend({
  refunds: z.array(adminRefundResponse),
  /** The ledger rows that granted this purchase (`ref_type = purchase`) and reversed it (`ref_type = refund`). */
  ledger: z.array(ledgerEntryResponse),
  lots: z.array(
    z.object({
      id: uuid,
      credits_total: z.number(),
      credits_remaining: z.number(),
      expires_at: isoDateTime,
    }),
  ),
  invoice: adminPurchaseInvoice.nullable(),
});
export type AdminPurchaseDetail = z.infer<typeof adminPurchaseDetail>;

/** POST /admin/purchases/:id/refund — a `staffActionRequest` plus the amount and the console's key. */
export const adminRefundRequest = z
  .object({
    reason_code: reasonCode,
    note: z.string().trim().min(1).max(1000).optional(),
    ticket_id: z.number().int().positive().optional(),
    /** Cents. Omitted = everything still refundable. */
    amount_cents: z.number().int().positive().optional(),
    /**
     * One per intended refund (the console makes one when the dialog opens); it becomes
     * the refund id. A repeat answers the existing refund and never asks Stripe twice; a
     * repeat of a failed attempt retries the same row.
     */
    idempotency_key: uuid.optional(),
  })
  .refine((v) => v.reason_code !== 'other' || Boolean(v.note), {
    message: 'A note is required with reason "other".',
    path: ['note'],
  });
export type AdminRefundRequest = z.infer<typeof adminRefundRequest>;

// ---------------------------------------------------------------------------- failed auto top-ups (§5.4)

export const adminFailedTopupsQuery = paginationQuery.extend({
  tenant_id: uuid.optional(),
});
export type AdminFailedTopupsQuery = z.infer<typeof adminFailedTopupsQuery>;

export const adminFailedTopup = adminPurchaseResponse.extend({
  tenant_name: z.string(),
  /** The tenant still has auto top-up switched on. */
  auto_topup_enabled: z.boolean(),
  card_last4: z.string().nullable(),
  /** When the 6-hour failure cooldown ends; null for a pending row that never got a decline. */
  cooldown_until: isoDateTime.nullable(),
  /** An `auto_topup_failed` customer alert is open for this workspace. */
  alert_open: z.boolean(),
  /** When that alert was opened (the customer was told), else null. */
  last_notified: isoDateTime.nullable(),
});
export type AdminFailedTopup = z.infer<typeof adminFailedTopup>;

export const adminTopupRetryResponse = z.object({
  outcome: z.enum(['charged', 'declined', 'skipped']),
  purchase_id: uuid.nullable(),
  reason: z.string().nullable(),
});
export type AdminTopupRetryResponse = z.infer<typeof adminTopupRetryResponse>;

export const adminAutoTopupStatusResponse = z.object({
  tenant_id: uuid,
  enabled: z.boolean(),
  pack_id: z.string().nullable(),
  threshold: z.number().nullable(),
  card_last4: z.string().nullable(),
});
export type AdminAutoTopupStatusResponse = z.infer<typeof adminAutoTopupStatusResponse>;

// ---------------------------------------------------------------------------- revenue report

export const adminBillingSummaryResponse = z.object({
  range: adminRange,
  from: isoDateTime,
  to: isoDateTime,
  /** Paid purchases in range, by currency. */
  sales: z.array(
    z.object({
      currency: z.string(),
      purchases: z.number().int(),
      amount_cents: z.number().int(),
      credits: z.number().int(),
    }),
  ),
  /** Succeeded refunds in range, by currency. */
  refunds: z.array(
    z.object({
      currency: z.string(),
      count: z.number().int(),
      amount_cents: z.number().int(),
      credits_reversed: z.number(),
    }),
  ),
  failed_topups: z.number().int(),
  packs: z.array(
    z.object({
      pack_id: z.string(),
      pack_name: z.string().nullable(),
      purchases: z.number().int(),
      credits: z.number().int(),
      amount_cents: z.number().int(),
    }),
  ),
  series: z.array(
    z.object({
      /** YYYY-MM-DD, UTC. */
      day: z.string(),
      sales_cents: z.number().int(),
      refunds_cents: z.number().int(),
      purchases: z.number().int(),
    }),
  ),
});
export type AdminBillingSummaryResponse = z.infer<typeof adminBillingSummaryResponse>;

// ---------------------------------------------------------------------------- finance reports (admin §9 `GET /admin/reports/*`)

/** Money per currency: every report keeps currencies apart rather than adding CAD to USD. */
const moneyByCurrency = z.array(z.object({ currency: z.string(), credits: z.number(), value_cents: z.number().int() }));

/**
 * `GET /admin/reports/cogs?range=` — what the calls of the range cost us on the voice
 * platform against what they billed. Revenue here is an estimate: the ledger does not
 * record which lot a call drew down, so credits are valued at the average price per credit
 * of the paid purchases of the last 12 months (`null` when they span currencies).
 */
export const adminCogsReport = z.object({
  range: adminRange,
  from: isoDateTime,
  to: isoDateTime,
  calls: z.number().int(),
  /** Calls the platform has not reported a cost for yet (`call_analyzed` not in). */
  calls_without_cost: z.number().int(),
  billed_seconds: z.number().int(),
  credits_billed: z.number(),
  platform_cost_cents: z.number().int(),
  by_tier: z.array(z.object({ tier: z.string(), calls: z.number().int(), credits_billed: z.number(), platform_cost_cents: z.number().int() })),
  by_day: z.array(z.object({ day: z.string(), calls: z.number().int(), credits_billed: z.number(), platform_cost_cents: z.number().int() })),
  avg_price_cents_per_credit: z.number().nullable(),
  price_currency: z.string().nullable(),
  estimated_revenue_cents: z.number().int().nullable(),
  estimated_margin_pct: z.number().nullable(),
});
export type AdminCogsReport = z.infer<typeof adminCogsReport>;

/**
 * `GET /admin/reports/deferred` — as of now: credits sold and not yet used or expired,
 * valued at what each lot's purchase paid per credit. Credits nobody paid for (the trial,
 * staff adjustments) are counted apart and carry no value.
 */
export const adminDeferredReport = z.object({
  as_of: isoDateTime,
  workspaces: z.number().int(),
  paid: moneyByCurrency,
  unpaid_credits: z.number(),
  /** When the paid credits expire, by UTC month: what becomes breakage if unused. */
  by_expiry_month: z.array(z.object({ month: z.string(), currency: z.string(), credits: z.number(), value_cents: z.number().int() })),
});
export type AdminDeferredReport = z.infer<typeof adminDeferredReport>;

/** `GET /admin/reports/breakage?range=` — credits that expired unused in the range (the `expiry` ledger rows), valued per lot. */
export const adminBreakageReport = z.object({
  range: adminRange,
  from: isoDateTime,
  to: isoDateTime,
  lots: z.number().int(),
  paid: moneyByCurrency,
  unpaid_credits: z.number(),
  by_day: z.array(z.object({ day: z.string(), currency: z.string(), credits: z.number(), value_cents: z.number().int() })),
});
export type AdminBreakageReport = z.infer<typeof adminBreakageReport>;

// ---------------------------------------------------------------------------- knowledge bases (admin §9 `GET /admin/kbs`)

export const adminKbsQuery = paginationQuery.extend({
  tenant_id: uuid.optional(),
  /** Only agents with a source in this state. */
  status: z.enum(['pending', 'syncing', 'ready', 'failed', 'deleting']).optional(),
});
export type AdminKbsQuery = z.infer<typeof adminKbsQuery>;

/** One agent's knowledge: the platform base and its sources by state. */
export const adminKbResponse = z.object({
  agent_id: uuid,
  agent_name: z.string(),
  agent_status: z.string(),
  tenant_id: uuid,
  tenant_name: z.string(),
  /** The agent holds a knowledge base on the voice platform (counts against `kb_allowance`). */
  has_platform_kb: z.boolean(),
  sources: z.number().int(),
  by_status: z.object({ pending: z.number().int(), syncing: z.number().int(), ready: z.number().int(), failed: z.number().int(), deleting: z.number().int() }),
  has_menu: z.boolean(),
  size_bytes: z.number().int(),
  last_synced_at: isoDateTime.nullable(),
  /** The newest failed source's customer-safe reason. */
  last_error: z.string().nullable(),
  updated_at: isoDateTime,
});
export type AdminKbResponse = z.infer<typeof adminKbResponse>;
