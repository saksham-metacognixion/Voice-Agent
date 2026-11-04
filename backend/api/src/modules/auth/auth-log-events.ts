/**
 * §6.2 "Audit log: login …" (ADR 0036 §9). Auth0 records every sign-in outcome in its
 * tenant log and streams it to `POST /webhooks/auth/logs`; this is the one map from its
 * log type to our audit action. A type not listed here is acknowledged and dropped — the
 * stream also carries token exchanges and API calls, one per page load, which are not
 * sign-ins and would drown the log a customer reads.
 *
 * Codes: https://auth0.com/docs/deploy-monitor/logs/log-event-type-codes
 */
export const AUTH_LOG_ACTIONS: Readonly<Record<string, string>> = {
  s: 'auth.signed_in',
  f: 'auth.sign_in_failed',
  fp: 'auth.sign_in_failed',
  fu: 'auth.sign_in_failed',
  fcoa: 'auth.sign_in_failed',
  limit_wc: 'auth.sign_in_blocked',
  limit_sul: 'auth.sign_in_blocked',
  mfar: 'auth.mfa_challenged',
  gd_auth_succeed: 'auth.mfa_passed',
  gd_auth_failed: 'auth.mfa_failed',
  gd_auth_rejected: 'auth.mfa_failed',
  gd_otp_rate_limit_exceed: 'auth.mfa_locked',
  gd_recovery_succeed: 'auth.mfa_recovery_used',
  gd_recovery_failed: 'auth.mfa_failed',
  gd_enrollment_complete: 'auth.mfa_enrolled',
  gd_unenroll: 'auth.mfa_removed',
  scp: 'auth.password_changed',
  scpr: 'auth.password_reset_requested',
  slo: 'auth.signed_out',
};

/** The audit action for a log type, or null for one we do not record. */
export function auditActionForLog(type: string): string | null {
  return Object.prototype.hasOwnProperty.call(AUTH_LOG_ACTIONS, type) ? AUTH_LOG_ACTIONS[type]! : null;
}

/** §6.2 "login 5 failures / 15 min per email+IP". */
export const SIGN_IN_BLOCK_MS = 15 * 60_000;

/**
 * When a brute-force block should be lifted (ADR 0036 §8), or null for an entry that is
 * not one. Auth0's own block lasts until an unblock link, a password reset or an admin;
 * the spec's lasts 15 minutes, so we lift it then. Only `limit_wc` (failures against one
 * account) qualifies: `limit_sul` expires by itself, and a block a staff member set
 * (`blocked: true`, SA3 lock) is not a brute-force block and is never lifted here.
 *
 * Counted from the block's own time, so a stream that delivers late does not lengthen it.
 * An entry naming no user and no address cannot be lifted, and an unreadable date is
 * counted from now.
 */
export function signInBlockLift(
  entry: { log_id: string; data: { type: string; date?: string; user_id?: string | null; user_name?: string | null } },
  now: number = Date.now(),
): { logId: string; sub: string | null; identifier: string | null; delayMs: number } | null {
  if (entry.data.type !== 'limit_wc') return null;
  const sub = entry.data.user_id?.trim() || null;
  const identifier = entry.data.user_name?.trim().toLowerCase() || null;
  if (!sub && !identifier) return null;
  const blockedAt = entry.data.date ? Date.parse(entry.data.date) : Number.NaN;
  const from = Number.isNaN(blockedAt) ? now : blockedAt;
  return { logId: entry.log_id, sub, identifier, delayMs: Math.max(0, from + SIGN_IN_BLOCK_MS - now) };
}
