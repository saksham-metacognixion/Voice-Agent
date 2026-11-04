/**
 * Customer tenant — Post Change Password (ADR 0036 §5).
 *
 * §6.3 A6: "new password form → all other sessions revoked". Auth0 runs this after any
 * password change — the A6 reset link, a change in the dashboard, the Management API. It
 * tells the API, which ends what the old password opened: every access token issued
 * before now (`users.sessions_revoked_at`, checked by AuthGuard on every request), every
 * session and refresh token at the provider, and every "remember this device".
 *
 * Fire-and-forget like the other Actions: a failure is logged to the tenant log stream and
 * never blocks the change. `event_id` makes each change its own event, so a second change
 * is not deduped against the first.
 *
 * Secrets: API_PUBLIC_URL, ACTION_SECRET (matches AUTH0_CUSTOMER_ACTION_SECRET in .env).
 * Never sends the password, or anything derived from it.
 */
exports.onExecutePostChangePassword = async (event) => {
  if (!event.secrets.API_PUBLIC_URL || !event.secrets.ACTION_SECRET || !event.user || !event.user.email) return;
  const occurredAt = new Date().toISOString();
  try {
    const response = await fetch(`${event.secrets.API_PUBLIC_URL}/webhooks/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-action-secret': event.secrets.ACTION_SECRET },
      body: JSON.stringify({
        event_type: 'user.password_changed',
        external_id: event.user.user_id,
        event_id: `password_changed|${event.user.user_id}|${occurredAt}`,
        occurred_at: occurredAt,
        email: event.user.email,
        email_verified: event.user.email_verified === true,
        name: event.user.name ?? null,
      }),
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok && response.status !== 204) {
      console.error(`webhooks/auth (user.password_changed) returned ${response.status} for ${event.user.user_id}`);
    }
  } catch (error) {
    console.error(`webhooks/auth (user.password_changed) failed for ${event.user.user_id}: ${error && error.message ? error.message : error}`);
  }
};
