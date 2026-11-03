// The matcher lives in `common/webhook-payload.ts` (ADR 0035): the SA12 view blanks these
// fields for a role without `can_listen_recordings`, and the §17 retention purge clears
// the same fields for good. Re-exported so the admin module's imports read as before.
export { REDACTED, PURGED, redactWebhookPayload } from '../../common/webhook-payload';
export type { RedactedPayload } from '../../common/webhook-payload';
