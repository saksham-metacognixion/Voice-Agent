/**
 * Staff tenant — Post Login (admin §2.1).
 *
 * Two jobs: refuse anyone outside the Workspace domain, and record whether MFA was
 * actually completed in this session. AuthGuard.authenticateStaff() throws MFA_REQUIRED
 * on any staff token without https://portal/mfa === true, so a tenant-policy change that
 * silently stops challenging shows up as a locked-out console, not as a quiet downgrade.
 *
 * Secrets: ALLOWED_EMAIL_DOMAIN (matches STAFF_ALLOWED_EMAIL_DOMAIN in .env).
 * Claim name must stay in lockstep with CLAIM_MFA in shared/schemas/src/enums.ts.
 */
exports.onExecutePostLogin = async (event, api) => {
  const allowedDomain = event.secrets.ALLOWED_EMAIL_DOMAIN;
  const email = (event.user.email || '').toLowerCase();

  if (!event.user.email_verified || !email.endsWith(`@${allowedDomain}`)) {
    api.access.deny('This console is restricted to staff accounts.');
    return;
  }

  const methods = event.authentication?.methods ?? [];
  const mfaCompleted = methods.some((method) => method.name === 'mfa');

  api.accessToken.setCustomClaim('https://portal/mfa', mfaCompleted);
};
