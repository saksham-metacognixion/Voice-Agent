import { ApiError, AuthRequiredError } from '@portal/api-client';

/**
 * One place that turns an error into a sentence. Branches on `code` (§16), never on the
 * message; the server's message is the fallback for a code without a line here.
 */
const LINES: Record<string, string> = {
  UNAUTHENTICATED: 'Your session has ended. Sign in again.',
  NETWORK: 'We could not reach the API. Check your connection and try again.',
  MFA_REQUIRED: 'This console needs a second factor. Sign out and sign in again with your authenticator.',
  STAFF_ONLY: 'This account has no staff access.',
  FORBIDDEN_ROLE: 'Your staff role cannot do that.',
  STAFF_LIMIT_EXCEEDED: 'That is over the limit for your role.',
  MARGIN_FLOOR: 'This pricing is below the margin floor. A super admin can override it with a note.',
  STRIPE_SYNC_FAILED: 'Stripe could not be synced. The version is saved but not in effect; publishing again resumes the sync.',
  CONFLICT: 'Someone else changed this first. Reload and try again.',
  VALIDATION_FAILED: 'Some fields are not valid.',
  NOT_FOUND: 'That record does not exist (or was deleted).',
  NOT_CONFIGURED: 'The platform configuration this needs is missing.',
  UPSTREAM_UNAVAILABLE: 'An upstream service did not answer. Try again in a moment.',
};

export function errorMessage(error: unknown): string {
  if (error instanceof AuthRequiredError) return LINES.UNAUTHENTICATED!;
  if (error instanceof ApiError) {
    const line = LINES[error.code];
    // The server's message names who could (STAFF_LIMIT_EXCEEDED) or why (MARGIN_FLOOR): prefer it when it says more.
    if (error.code === 'STAFF_LIMIT_EXCEEDED' || error.code === 'MARGIN_FLOOR' || error.code === 'STRIPE_SYNC_FAILED') {
      return error.body.message || line || 'Request failed.';
    }
    if (error.code === 'VALIDATION_FAILED' && error.body.fields?.length) {
      return error.body.fields.map((f) => `${f.field}: ${f.message}`).join('; ');
    }
    return line ?? (error.body.message || 'Something went wrong.');
  }
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong.';
}
