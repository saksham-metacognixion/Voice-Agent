/**
 * Staff tenant — Post Login (admin §2.1).
 *
 * Two jobs: refuse anyone outside the Workspace domain, and make MFA happen on every
 * interactive staff sign-in, stamping https://portal/mfa for AuthGuard.authenticateStaff(),
 * which throws MFA_REQUIRED on any staff token without the claim set to true.
 *
 * Why the Action asks for MFA itself (28 Sep fix): Post-Login Actions run *before* a
 * tenant-policy MFA challenge, so `event.authentication.methods` does not contain `mfa` on
 * a fresh sign-in and a claim derived from it was always false — every staff member was
 * locked out. `api.multifactor.enable()` makes Auth0 challenge after this Action and issue
 * the tokens only once the second factor succeeds, so the claim is true exactly when MFA
 * passed: a sign-in that fails the challenge gets no token at all.
 *
 * Refresh-token grants cannot be challenged. They only exist because an interactive sign-in
 * that passed MFA issued the refresh token, so they keep the claim.
 *
 * Secrets: ALLOWED_EMAIL_DOMAIN (matches STAFF_ALLOWED_EMAIL_DOMAIN in .env).
 * Claim names must stay in lockstep with CLAIM_MFA and CLAIM_EMAIL in shared/schemas/src/enums.ts.
 */
exports.onExecutePostLogin = async (event, api) => {
  const allowedDomain = event.secrets.ALLOWED_EMAIL_DOMAIN;
  const email = (event.user.email || '').toLowerCase();

  if (!event.user.email_verified || !email.endsWith(`@${allowedDomain}`)) {
    api.access.deny('This console is restricted to staff accounts.');
    return;
  }

  const refreshGrant = Boolean(
    event.transaction && event.transaction.protocol === 'oauth2-refresh-token',
  );
  const methods = (event.authentication && event.authentication.methods) || [];
  const alreadyPassed = methods.some((method) => method && method.name === 'mfa');

  if (!refreshGrant && !alreadyPassed) {
    // Enrols on first use (One-time Password must be enabled on the tenant), challenges after.
    api.multifactor.enable('any', { allowRememberBrowser: false });
  }

  api.accessToken.setCustomClaim('https://portal/mfa', true);
  // SA13 (D13): an invited colleague's `staff_users` row is bound to this `sub` on their
  // first request, matched on this claim — the only email claim the API trusts, as on the
  // customer tenant. Lower-cased here so the match is exact.
  api.accessToken.setCustomClaim('https://portal/email', email);
  // The display name an invite without one is filled from at that first request (QA-065).
  if (event.user.name) api.accessToken.setCustomClaim('https://portal/name', event.user.name);
};
