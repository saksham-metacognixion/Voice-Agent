# Postman collection

- `voice-agent-portal.postman_collection.json` — every customer-facing route of the API (D1–D5), grouped by module, with Hinglish descriptions and test scripts that capture ids into the environment.
- `voice-agent-portal.local.postman_environment.json` — variables for a local API (`http://localhost:4000`).

## Setup

1. Import both files (File → Import).
2. Select the environment, set `access_token` (an Auth0 customer-tenant **access** token) and, for the auth webhook, `auth_action_secret` (= `AUTH0_CUSTOMER_ACTION_SECRET`).
3. Run in order: `POST /workspaces` → `GET /voices` → `POST /agents` → `PATCH /agents/:id/draft` → `POST /agents/:id/generate` → `GET /jobs/:id` → `POST /agents/:id/publish`. Each step's test script fills the next step's variable.

Without an Auth0 tenant, mint a token from the e2e double (`backend/api/test/auth0-double.ts`) or point `AUTH0_CUSTOMER_DOMAIN` at any JWKS you control; the API only checks issuer, audience and signature.

Retell and Stripe webhooks need a real signature over the raw body — use the fixtures in `backend/api/test/fixtures/retell/` or the Stripe CLI rather than Postman for those.
