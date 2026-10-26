import { z } from 'zod';
import { planTier } from './enums.js';
import { paginationQuery, uuid } from './common.js';

/** `credit_ledger.reason` (§15). Every movement of credits is exactly one of these. */
export const ledgerReason = z.enum([
  'trial',
  'purchase',
  'call',
  'rental',
  'kb',
  'adjustment',
  'expiry',
  'refund',
  'topup',
]);
export type LedgerReason = z.infer<typeof ledgerReason>;

export const purchaseStatus = z.enum(['pending', 'paid', 'abandoned', 'refunded']);
export type PurchaseStatus = z.infer<typeof purchaseStatus>;

/** `tenants.auto_topup_json` (§5.4). */
export const autoTopup = z.object({
  enabled: z.boolean(),
  pack_id: z.string().nullable().default(null),
  /** Credits. D5 requires ≥ 10 when enabling. */
  threshold: z.number().min(0).nullable().default(null),
  payment_method_id: z.string().nullable().default(null),
  /** Last four of the saved card, for the D5 "Card •••• 4242" line. Never the PAN. */
  card_last4: z.string().length(4).nullable().default(null),
});
export type AutoTopup = z.infer<typeof autoTopup>;

/** GET /wallet — the D5 balance card. */
export const walletResponse = z.object({
  /** Σ credit_ledger.delta, 2 dp. Can be negative down to −grace (§5.4). */
  balance: z.number(),
  plan_tier: planTier,
  concurrency_cap: z.number().int(),
  kb_allowance: z.number().int(),
  /** Credits in the lot that expires next, and when. null when no lot is open. */
  expiring_next: z
    .object({ credits: z.number(), expires_at: z.string() })
    .nullable(),
  /** Size of the last paid pack — the base for the low-balance thresholds. */
  last_pack_credits: z.number().nullable(),
  auto_topup: autoTopup.nullable(),
});
export type WalletResponse = z.infer<typeof walletResponse>;

export const creditLotResponse = z.object({
  id: z.string().uuid(),
  purchase_id: z.string().uuid().nullable(),
  credits_total: z.number(),
  credits_remaining: z.number(),
  expires_at: z.string(),
  created_at: z.string(),
});
export type CreditLotResponse = z.infer<typeof creditLotResponse>;

export const ledgerEntryResponse = z.object({
  id: z.string().uuid(),
  delta: z.number(),
  balance_after: z.number(),
  reason: ledgerReason,
  ref_type: z.string().nullable(),
  /** For reason=call this is the call id, so the D5 row can link to the D2 detail. */
  ref_id: z.string().nullable(),
  created_at: z.string(),
});
export type LedgerEntryResponse = z.infer<typeof ledgerEntryResponse>;

export const ledgerQuery = paginationQuery.extend({
  reason: ledgerReason.optional(),
});
export type LedgerQuery = z.infer<typeof ledgerQuery>;

/** POST /wallet/checkout (§13.7, §16 example). */
export const checkoutRequest = z.object({
  pack_id: z.string().min(1),
  auto_topup: z
    .object({ enabled: z.boolean(), threshold: z.number().min(10).optional() })
    .optional(),
  /** W7: activate this agent once paid (§13.8). */
  agent_id: z.string().uuid().optional(),
  promo_code: z.string().min(1).max(64).optional(),
});
export type CheckoutRequest = z.infer<typeof checkoutRequest>;

export const checkoutResponse = z.object({
  checkout_url: z.string().url(),
  purchase_id: z.string().uuid(),
});
export type CheckoutResponse = z.infer<typeof checkoutResponse>;

/**
 * POST /wallet/checkout/confirm — the customer is back from Stripe with `session_id` in
 * the URL. The id proves nothing on its own: the API retrieves the session from Stripe and
 * runs the same fulfilment as the webhook, so a late or lost `checkout.session.completed`
 * never leaves a paid customer waiting on the return screen.
 */
export const checkoutConfirmRequest = z.object({
  session_id: z.string().regex(/^cs_[A-Za-z0-9_]{8,200}$/),
});
export type CheckoutConfirmRequest = z.infer<typeof checkoutConfirmRequest>;

export const checkoutConfirmResponse = z.object({
  purchase_id: uuid,
  status: purchaseStatus,
  /** True when this call is what credited the pack — the webhook had not arrived. */
  credited: z.boolean(),
  /**
   * When the purchase was created (the checkout started), on the server's clock. W7 shows
   * only an activation created after it — never compared with the browser's clock, which
   * may be minutes off (QA-020).
   */
  purchase_created_at: z.string(),
});
export type CheckoutConfirmResponse = z.infer<typeof checkoutConfirmResponse>;

// ---------------------------------------------------------------------------
// D5 Wallet — auto top-up, invoices, payment methods (§5.4, §13.7, §16)
// ---------------------------------------------------------------------------

/**
 * PUT /wallet/auto-topup. The saved card comes from a Checkout that opted in
 * (`setup_future_usage`), so enabling needs a purchase to have saved one; the route says
 * so with `NO_PAYMENT_METHOD` rather than accepting a switch that could never fire.
 */
export const autoTopupRequest = z.object({
  enabled: z.boolean(),
  pack_id: z.string().min(1).optional(),
  /** Credits. D5 requires ≥ 10 when enabling. */
  threshold: z.number().min(10).optional(),
});
export type AutoTopupRequest = z.infer<typeof autoTopupRequest>;

/** Stripe's invoice lifecycle, as we store it. `uncollectible` is Stripe's `marked_uncollectible`. */
export const invoiceStatus = z.enum(['draft', 'open', 'paid', 'payment_failed', 'void', 'uncollectible']);
export type InvoiceStatus = z.infer<typeof invoiceStatus>;

/** GET /wallet/invoices — one row per Stripe invoice the workspace's customer received. */
export const invoiceResponse = z.object({
  id: uuid,
  purchase_id: uuid.nullable(),
  number: z.string().nullable(),
  amount_cents: z.number().int(),
  currency: z.string(),
  status: invoiceStatus,
  /** Stripe-hosted page and PDF. Both are Stripe URLs, safe to hand to the browser. */
  hosted_url: z.string().nullable(),
  pdf_url: z.string().nullable(),
  finalized_at: z.string().nullable(),
  paid_at: z.string().nullable(),
  created_at: z.string(),
});
export type InvoiceResponse = z.infer<typeof invoiceResponse>;

export const invoicesQuery = paginationQuery;

/** POST /wallet/portal-session — the Stripe Customer Portal for cards and receipts. */
export const portalSessionRequest = z.object({
  /** Where Stripe sends the customer back. Must be on the portal origin; the API checks. */
  return_path: z.string().regex(/^\/[A-Za-z0-9/_\-?=&.]*$/).max(200).optional(),
});
export type PortalSessionRequest = z.infer<typeof portalSessionRequest>;

export const portalSessionResponse = z.object({ url: z.string().url() });
export type PortalSessionResponse = z.infer<typeof portalSessionResponse>;
