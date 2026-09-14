/**
 * Customer tenant — Post Login.
 *
 * Stamps https://portal/email_verified onto the ACCESS token. The API verifies the
 * access token, not the ID token, so setting it on the ID token alone would leave
 * CLAIM_EMAIL_VERIFIED undefined and every gated route returning EMAIL_UNVERIFIED.
 *
 * Claim name must stay in lockstep with CLAIM_EMAIL_VERIFIED in shared/schemas/src/enums.ts.
 */
exports.onExecutePostLogin = async (event, api) => {
  api.accessToken.setCustomClaim('https://portal/email_verified', event.user.email_verified === true);
};
