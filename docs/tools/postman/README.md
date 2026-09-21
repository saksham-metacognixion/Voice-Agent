# Postman collection

- `voice-agent-portal.postman_collection.json` — every customer-facing route of the API (D1–D6), grouped by module, with Hinglish descriptions and test scripts that capture ids into the environment. 82 requests across 14 folders; every path is checked against the real Fastify router.
- `voice-agent-portal.local.postman_environment.json` — variables for a local API (`http://localhost:4000`).

## Setup

1. Import both files (File → Import).
2. Select the environment, set `access_token` (an Auth0 customer-tenant **access** token) and, for the auth webhook, `auth_action_secret` (= `AUTH0_CUSTOMER_ACTION_SECRET`).
3. Run in order: `POST /workspaces` → `GET /voices` → `POST /agents` → `PATCH /agents/:id/draft` → `POST /agents/:id/generate` → `GET /jobs/:id` → `POST /agents/:id/publish`. Each step's test script fills the next step's variable.
4. D6 continues from there: `POST /agents/:id/knowledge` (folder 6) → `PUT /agents/:id/phone-plan` (folder 7) → `POST /wallet/checkout` (folder 9) → `POST /agents/:id/activate` (folder 8) → poll `GET /agents/:id/activation` until `live` → `GET /numbers`.

Activation and provisioning really do spend money: buying a number costs $2/month on the Retell bill, so run folder 7's `POST /numbers/buy` and folder 8's activate against a dev workspace and release the number afterwards (`DELETE /numbers/:id`). `pnpm --filter @portal/api verify:d6` does the whole flow end to end and cleans up after itself.

Without an Auth0 tenant, mint a token from the e2e double (`backend/api/test/auth0-double.ts`) or point `AUTH0_CUSTOMER_DOMAIN` at any JWKS you control; the API only checks issuer, audience and signature.

Retell and Stripe webhooks need a real signature over the raw body — use the fixtures in `backend/api/test/fixtures/retell/` or the Stripe CLI rather than Postman for those.

SSE (`GET /events`, and `activation:{id}` in particular) does not stream in Postman — it buffers the response. Use `curl -N` with the same two headers.
