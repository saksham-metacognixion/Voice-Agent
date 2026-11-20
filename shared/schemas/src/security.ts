import { z } from 'zod';
import { isoDateTime } from './common.js';
import type { MemberRole } from './enums.js';

/*
 * Sign-in and money-protection rules (§6.2, §6.3, §17 — ADR 0036). The decisions are
 * pure functions here so the API (which enforces them) and the portal (which explains
 * them) can never disagree about when a rule applies.
 */

// ---------------------------------------------------------------------------
// §6.2 — MFA "required for Owner/Admin once auto top-up is enabled or balance > 1,000"
// ---------------------------------------------------------------------------

/** The roles that can spend money (§6.1), and so the roles the MFA rule binds. */
export const MFA_PROTECTED_ROLES: readonly MemberRole[] = ['owner', 'admin'];

export const mfaReason = z.enum(['auto_topup', 'balance']);
export type MfaReason = z.infer<typeof mfaReason>;

export interface MoneyAtRisk {
  /** The workspace balance in credits (Σ ledger). */
  balance: number;
  autoTopupEnabled: boolean;
  /** `wallet_policy.mfa_required_above_balance` from the published pricing config. */
  threshold: number;
}

/** Why a workspace puts money at risk, empty when it does not. "Above" is strict: 1,000 is not over 1,000. */
export function mfaReasons(state: MoneyAtRisk): MfaReason[] {
  const reasons: MfaReason[] = [];
  if (state.autoTopupEnabled) reasons.push('auto_topup');
  if (Number.isFinite(state.balance) && state.balance > state.threshold) reasons.push('balance');
  return reasons;
}

/** True when this role, in a workspace in this state, must have passed a second factor. */
export function mfaRequiredFor(role: MemberRole, state: MoneyAtRisk): boolean {
  return MFA_PROTECTED_ROLES.includes(role) && mfaReasons(state).length > 0;
}

/** `GET /workspace` → `mfa`: what the rule says about the caller in this workspace. */
export const workspaceMfa = z.object({
  /** The rule binds the caller (owner/admin of a workspace with money at risk). */
  required: z.boolean(),
  /** The caller's current session passed a second factor. */
  satisfied: z.boolean(),
  reasons: z.array(mfaReason),
});
export type WorkspaceMfa = z.infer<typeof workspaceMfa>;

// ---------------------------------------------------------------------------
// §6.3 A1 — Terms of Service, accepted explicitly and kept per version
// ---------------------------------------------------------------------------

/**
 * The Terms and Privacy Policy version a person must have accepted. Raising it asks
 * everyone again on their next visit; the older acceptances stay in `terms_acceptances`.
 */
export const TERMS_VERSION = '2026-11-03';

export const termsAcceptRequest = z.object({
  /** The version the person was shown. Anything but the current one is refused (409). */
  version: z.string().min(1).max(32),
  accepted: z.literal(true),
});
export type TermsAcceptRequest = z.infer<typeof termsAcceptRequest>;

export const termsStatus = z.object({
  current_version: z.string(),
  accepted_version: z.string().nullable(),
  accepted_at: isoDateTime.nullable(),
  /** The current version has not been accepted yet. */
  required: z.boolean(),
});
export type TermsStatus = z.infer<typeof termsStatus>;

/** True when `accepted` is not the version in force. */
export function termsAcceptanceRequired(accepted: string | null | undefined, current = TERMS_VERSION): boolean {
  return accepted !== current;
}

/** `GET /me` — the signed-in person, before any workspace. */
export const accountResponse = z.object({
  id: z.string().uuid(),
  email: z.string(),
  name: z.string().nullable(),
  email_verified: z.boolean(),
  /** This session passed a second factor. */
  mfa: z.boolean(),
  terms: termsStatus,
});
export type AccountResponse = z.infer<typeof accountResponse>;

// ---------------------------------------------------------------------------
// §6.3 A2 — "Resend" with a 60-second cooldown and at most 5 an hour
// ---------------------------------------------------------------------------

export const VERIFICATION_RESEND_COOLDOWN_S = 60;
export const VERIFICATION_RESEND_MAX_PER_HOUR = 5;

export const verificationEmailResponse = z.object({
  /** `already_verified`: nothing was sent — refresh the session instead. */
  status: z.enum(['sent', 'already_verified']),
  /** Seconds before another resend is accepted. */
  retry_after_s: z.number().int().min(0),
});
export type VerificationEmailResponse = z.infer<typeof verificationEmailResponse>;

/** `POST /me/devices/forget` — A4 "Remember this device" undone everywhere (ADR 0036 §4). */
export const forgetDevicesResponse = z.object({ forgotten: z.literal(true) });
export type ForgetDevicesResponse = z.infer<typeof forgetDevicesResponse>;

// ---------------------------------------------------------------------------
// §10 D6 Security — "MFA enrol/disable (with re-auth)", "connected SSO accounts"
// ---------------------------------------------------------------------------

/**
 * How long ago the second factor may have been passed for `POST /me/mfa/disable`. The
 * spec's "with re-auth": the portal asks for a fresh challenge first, so a session that
 * passed one this morning is not enough.
 */
export const MFA_REAUTH_WINDOW_S = 5 * 60;

/** `POST /me/mfa/disable`. */
export const mfaDisableResponse = z.object({ disabled: z.literal(true) });
export type MfaDisableResponse = z.infer<typeof mfaDisableResponse>;

/** One way the person can sign in, as D6 names it. `other` = a connection we do not label. */
export const signInMethod = z.enum(['password', 'google', 'microsoft', 'other']);
export type SignInMethod = z.infer<typeof signInMethod>;

/**
 * `GET /me/sign-in-methods` — D6 "connected SSO accounts". `available: false` when the
 * identity provider cannot be asked (a dev box): the portal says so rather than showing
 * none.
 */
export const signInMethodsResponse = z.object({
  available: z.boolean(),
  methods: z.array(z.object({ method: signInMethod, connection: z.string() })),
});
export type SignInMethodsResponse = z.infer<typeof signInMethodsResponse>;

/** The provider's identity → D6's label. Pure, shared by the API and its tests. */
export function signInMethodOf(provider: string): SignInMethod {
  if (provider === 'auth0') return 'password';
  if (provider === 'google-oauth2') return 'google';
  if (provider === 'windowslive' || provider === 'waad') return 'microsoft';
  return 'other';
}

// ---------------------------------------------------------------------------
// §6.3 A8 — the invitee's address, pre-filled at sign-in
// ---------------------------------------------------------------------------

/** `GET /invites/:token/hint` (public): the address an open invite was sent to. */
export const inviteHintResponse = z.object({ email: z.string() });
export type InviteHintResponse = z.infer<typeof inviteHintResponse>;

// ---------------------------------------------------------------------------
// §17 — "manual review flag for > $1,000 first purchase"
// ---------------------------------------------------------------------------

/**
 * True when a purchase must be approved by staff before it can be paid: the workspace has
 * never paid for anything, and the amount is strictly over the limit
 * (`wallet_policy.max_first_purchase_cents_without_review`). Exactly the limit passes.
 */
export function purchaseNeedsReview(input: { hasPaidBefore: boolean; amountCents: number; limitCents: number }): boolean {
  return !input.hasPaidBefore && input.amountCents > input.limitCents;
}

export const purchaseReviewStatus = z.enum(['open', 'approved', 'rejected']);
export type PurchaseReviewStatus = z.infer<typeof purchaseReviewStatus>;

/** The `fraud_reviews.trigger` this rule writes. */
export const FIRST_PURCHASE_REVIEW_TRIGGER = 'first_purchase_over_limit';
