/**
 * Customer tenant — Post Login.
 *
 * Two jobs.
 *
 * 1. Stamps three namespaced claims onto the ACCESS token (the API verifies the access
 *    token, not the ID token, so setting them on the ID token alone would leave every
 *    gated route returning EMAIL_UNVERIFIED):
 *      https://portal/email_verified   gates POST /workspaces, generate, invites (§6.2)
 *      https://portal/email            what AuthGuard provisions a `users` row from
 *      https://portal/name             display name for that row
 *    Claim names must stay in lockstep with CLAIM_EMAIL_VERIFIED / CLAIM_EMAIL /
 *    CLAIM_NAME in shared/schemas/src/enums.ts.
 *
 * 2. Posts `user.login` to POST /webhooks/auth — the safety net for a Post-User-
 *    Registration webhook that never arrived (that trigger is fire-and-forget on Auth0's
 *    side, so a signup can succeed with no row in Postgres). The API dedupes on
 *    (auth, sub, event_type) and runs the same idempotent upsert, so this costs one
 *    stored row per user and one 204 per login after that.
 *
 * Neither job may fail the login. The fetch has a short timeout and its failure is only
 * logged; the claims above are what let the API repair the row on the first request
 * anyway (AuthGuard.provision), so a dead webhook cannot lock anyone out.
 *
 * Secrets: API_PUBLIC_URL, ACTION_SECRET (matches AUTH0_CUSTOMER_ACTION_SECRET in .env).
 */
exports.onExecutePostLogin = async (event, api) => {
  const emailVerified = event.user.email_verified === true;
  api.accessToken.setCustomClaim('https://portal/email_verified', emailVerified);
  if (event.user.email) api.accessToken.setCustomClaim('https://portal/email', event.user.email);
  if (event.user.name) api.accessToken.setCustomClaim('https://portal/name', event.user.name);

  if (!event.secrets.API_PUBLIC_URL || !event.secrets.ACTION_SECRET || !event.user.email) return;

  try {
    const response = await fetch(`${event.secrets.API_PUBLIC_URL}/webhooks/auth`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-action-secret': event.secrets.ACTION_SECRET,
      },
      body: JSON.stringify({
        event_type: 'user.login',
        external_id: event.user.user_id,
        email: event.user.email,
        email_verified: emailVerified,
        name: event.user.name ?? null,
        picture: event.user.picture ?? null,
      }),
      signal: AbortSignal.timeout(3000),
    });
    // 200 = stored and queued, 204 = already mirrored. Anything else is logged to the
    // tenant log stream; the login still succeeds.
    if (!response.ok && response.status !== 204) {
      console.error(`webhooks/auth (user.login) returned ${response.status} for ${event.user.user_id}`);
    }
  } catch (error) {
    console.error(`webhooks/auth (user.login) failed for ${event.user.user_id}: ${error && error.message ? error.message : error}`);
  }
};
