import { ApiError } from '@portal/api-client';
import { roleAtLeast, type CallbackCheck, type CallDetail, type CallerIdResponse, type MemberRole, type OutboundRefusal } from '@portal/schemas';

/**
 * D18: what the D2 "Call back" panel shows, decided from `GET /calls/:id/callback` and the
 * viewer's role. The server runs every gate (ADR 0031); this only picks the sentence and
 * the one place that can fix it.
 */

/** Where a refusal can be fixed: the D6 Outbound tab, the D6 Workspace tab, the Numbers page, the wallet, or nowhere we can link to. */
export type CallbackFix = 'settings' | 'workspace' | 'numbers' | 'wallet' | null;

export type CallbackView =
  | { kind: 'ready'; canPlace: boolean }
  | { kind: 'blocked'; reason: OutboundRefusal | null; fix: CallbackFix; nextAllowedAt: string | null };

/** The panel is offered only for a phone call in a workspace whose `outbound_calls` flag is on. */
export function showCallbackPanel(call: Pick<CallDetail, 'channel'>, enabled: boolean): boolean {
  return enabled && call.channel === 'phone';
}

const SETTINGS_FIXES: ReadonlySet<OutboundRefusal> = new Set(['KYC_REQUIRED', 'KYC_PENDING', 'KYC_REJECTED', 'OUTBOUND_NOT_CONFIGURED', 'CALLER_ID_REQUIRED', 'CALLER_ID_UNVERIFIED']);
const WALLET_FIXES: ReadonlySet<OutboundRefusal> = new Set(['PURCHASE_REQUIRED', 'NO_CREDITS']);
/** QA-087: the time zone is a workspace setting, not an outbound one. */
const WORKSPACE_FIXES: ReadonlySet<OutboundRefusal> = new Set(['WORKSPACE_TIMEZONE_INVALID']);
/** QA-085: a paused caller ID is resumed on the Numbers page. */
const NUMBERS_FIXES: ReadonlySet<OutboundRefusal> = new Set(['NUMBER_PAUSED']);

export function callbackFix(reason: OutboundRefusal | null): CallbackFix {
  if (!reason) return null;
  if (SETTINGS_FIXES.has(reason)) return 'settings';
  if (WORKSPACE_FIXES.has(reason)) return 'workspace';
  if (NUMBERS_FIXES.has(reason)) return 'numbers';
  if (WALLET_FIXES.has(reason)) return 'wallet';
  return null;
}

/** Allowed → the button (editor and up places it, everyone sees it is possible); refused → why. */
export function callbackView(check: Pick<CallbackCheck, 'allowed' | 'reason' | 'next_allowed_at'>, role: MemberRole): CallbackView {
  if (check.allowed) return { kind: 'ready', canPlace: roleAtLeast(role, 'editor') };
  return {
    kind: 'blocked',
    reason: check.reason,
    fix: callbackFix(check.reason),
    nextAllowedAt: check.reason === 'OUTSIDE_CALLING_WINDOW' ? check.next_allowed_at : null,
  };
}

/**
 * "Add to do-not-call list" from the drawer: editor and up, a call with the other party's
 * number, not already listed. The server refuses a call with no number of its own as well.
 */
export function canListDnc(check: Pick<CallbackCheck, 'reason' | 'to_number'>, role: MemberRole): boolean {
  return roleAtLeast(role, 'editor') && Boolean(check.to_number) && check.reason !== 'DNC_LISTED';
}

/**
 * Whether the next press may reuse this press's `idempotency_key`. Only when we cannot tell
 * whether the call was placed — no answer at all (the network), a 5xx, or the server saying
 * that key is still being placed: the same key then answers the same call instead of
 * ringing the person twice. Every definitive answer (success, a refusal) takes a new key.
 */
export function keepIdempotencyKey(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.status === 0 || error.status >= 500) return true;
  return error.code === 'OUTBOUND_IN_PROGRESS';
}

/**
 * The D6 caller-ID line: how a verified number got verified, or what an unverified one
 * needs. A number bought from us is verified on purchase; one from the customer's own
 * phone system (or one whose verification staff withdrew) only by our team. A verified
 * number that is paused keeps its verification but cannot be called from until it is
 * resumed in Numbers (QA-085) — `usable` is the server's word on that.
 */
export function callerIdNote(c: Pick<CallerIdResponse, 'verified' | 'verified_via' | 'usable'>): 'purchase' | 'staff' | 'contactSupport' | 'paused' | null {
  if (!c.verified) return 'contactSupport';
  if (!c.usable) return 'paused';
  return c.verified_via;
}
