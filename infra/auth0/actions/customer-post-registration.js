/**
 * Customer tenant — Post User Registration.
 *
 * Upserts the Auth0 user into `users`. This trigger is non-blocking: a throw here does
 * NOT fail the signup, so a failure means the account exists in Auth0 with no row in
 * Postgres. The handler is idempotent on (provider, external_id, event_type), so the
 * recovery path is replaying this call. Two safety nets sit behind it: the Post Login
 * action posts `user.login` to the same route, and the API provisions the row itself from
 * the token's `https://portal/email` claim on the first authenticated request.
 *
 * Secrets: API_PUBLIC_URL, ACTION_SECRET (matches AUTH0_CUSTOMER_ACTION_SECRET in .env).
 */
exports.onExecutePostUserRegistration = async (event, api) => {
  const response = await fetch(`${event.secrets.API_PUBLIC_URL}/webhooks/auth`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-action-secret': event.secrets.ACTION_SECRET,
    },
    body: JSON.stringify({
      event_type: 'user.registered',
      external_id: event.user.user_id,
      email: event.user.email,
      email_verified: event.user.email_verified === true,
      name: event.user.name ?? null,
      created_at: event.user.created_at ?? new Date().toISOString(),
    }),
  });

  if (!response.ok) {
    // Logged to the tenant log stream; the signup still succeeds.
    console.error(`webhooks/auth returned ${response.status} for ${event.user.user_id}`);
  }
};
