/**
 * Customer tenant — Post Login.
 *
 * Three jobs.
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
 * 3. Opt-in two-factor (§6.2, A5). The tenant MFA policy stays "Never"; this Action is
 *    the policy. It asks for a second factor when the sign-in requested one (A5 sends the
 *    multi-factor `acr_values`, which is how a person enrols) or when the person already
 *    has a factor enrolled (so enrolment sticks on every later sign-in). It never asks on
 *    a refresh-token grant or on a session that already passed MFA: a non-interactive
 *    grant cannot show a challenge, so asking there fails the SPA's silent renewal.
 *    `https://portal/mfa_enrolled` on the ID token is what A5 shows as the status; the
 *    enrolling sign-in itself is covered by `amr: ["mfa"]`, because this Action runs
 *    before the enrolment it triggers. Needs the One-time Password factor enabled on the
 *    tenant (guardianFactors in tenant.customer.yaml), or there is nothing to enrol.
 *
 * None of the jobs may fail the login. The fetch has a short timeout and its failure is only
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

  // Claim name in lockstep with CLAIM_MFA_ENROLLED in shared/schemas/src/enums.ts.
  // Every field is shape-checked: this Action runs on every sign-in, and a TypeError here
  // fails the login for everyone, not only for two-factor users.
  const list = (value) => (Array.isArray(value) ? value : value ? [value] : []);
  const enrolled = list(event.user.enrolledFactors).length > 0 || list(event.user.multifactor).length > 0;
  api.idToken.setCustomClaim('https://portal/mfa_enrolled', enrolled);

  const requested = list(event.transaction && event.transaction.acr_values).some((v) => String(v).includes('multi-factor'));
  const refreshGrant = Boolean(event.transaction && event.transaction.protocol === 'oauth2-refresh-token');
  const alreadyPassed = list(event.authentication && event.authentication.methods).some((m) => m && m.name === 'mfa');
  if ((requested || enrolled) && !refreshGrant && !alreadyPassed) {
    api.multifactor.enable('any', { allowRememberBrowser: false });
  }

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
