import { z } from 'zod';
import { planTier } from './enums.js';
import { paginationQuery } from './common.js';

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
