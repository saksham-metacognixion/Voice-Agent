# Provisioning runbook — external accounts and staging infrastructure

Everything here needs a human with a credit card and an AWS console. The code in this repo
is written against these values; `pnpm doctor` tells you which ones are still missing.

Work top to bottom — later rows depend on earlier ones. Each row names the `.env` key the
value lands in; the same key is the SSM parameter name under `/voice-agent/<env>/` for
staging and prod (§17: nothing but `.env.example` is ever committed).

## 1. Vendor accounts

| Vendor        | What to create                                                                              | Lands in                                                               |
| ------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Retell AI** | Account; one API key per environment; webhook secret                                        | `RETELL_API_KEY`, `RETELL_WEBHOOK_SECRET`                              |
| **Stripe**    | Account in **test mode**; restricted key; webhook endpoint → `api.<domain>/webhooks/stripe` | `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` |
| **OpenAI**    | API key. Brief → prompt only, never in the call path (ADR 0007)                             | `OPENAI_API_KEY`, `GENERATION_MODEL`                                   |
| **Resend**    | Domain verified, sending key                                                                | `RESEND_API_KEY`, `EMAIL_FROM`                                         |

Stripe test and live keys never mix — separate accounts or at least separate restricted
keys per environment, and a different webhook secret for each.

## 2. Auth0 — two tenants (ADR 0002)

Two **separate tenants**, not two applications in one. The API asserts at boot that the
issuers differ; collapsing them would make a customer token verify on `/admin/*`.

**Customer tenant**

- **Single Page Application** for `frontend/web` → `AUTH0_CLIENT_ID`. No client secret: the app is a
  public client on Authorization Code + PKCE (ADR 0008). Enable **Refresh Token Rotation**.
- Callback / Logout / Web Origins are the app origin itself (`https://app.<domain>`), **not**
  `/auth/callback` — a static export has no route handlers.
- API with identifier `https://api.<domain>` → `AUTH0_CUSTOMER_AUDIENCE`, then grant the SPA access
  to it on the API's **Application Access** tab. Zero permissions: roles live in `memberships` (§6.1).
- Connections: database, Google, Microsoft (§6.2)
- M2M app authorised for the Management API (session list/revoke) → `AUTH0_CUSTOMER_M2M_*`
- Post-User-Registration Action → `POST https://api.<domain>/webhooks/auth`, shared secret
  header → `AUTH0_CUSTOMER_ACTION_SECRET`
- Post-Login Action adding `https://portal/email_verified`
- Source for both Actions lives in `infra/auth0/actions/`

**Staff tenant**

- **Single Page Application** for `frontend/admin` → `ADMIN_AUTH0_CLIENT_ID`. No client secret;
  Refresh Token Rotation on. Callback / Logout / Web Origins = `https://admin.<domain>`.
- API with identifier `https://admin-api.<domain>` → `AUTH0_STAFF_AUDIENCE`, and grant the SPA access
  to it. Zero permissions: staff limits live in `staff_role_limits` (admin §2.2).
- Google connection only, restricted to `STAFF_ALLOWED_EMAIL_DOMAIN` by the Post-Login Action; the
  database connection must be **off** for this application — staff have no password path.
- MFA **required** (TOTP or passkey), session 8 hours (admin §2.1)
- Post-Login Action adding `https://portal/mfa` — the API rejects any staff token without it

Set `AUTH0_CUSTOMER_DOMAIN` and `AUTH0_STAFF_DOMAIN` to the bare tenant domains
(`example.us.auth0.com`). The API turns them into `https://<domain>/` issuers itself.

**What cost time the first time round** (dev, 14 Sep) — all of it fails silently:

- **One tenant per Auth0 account on the free plan.** The second tenant needs a second account, so
  sign up with a shared alias (`auth0@<domain>`), never a personal address.
- **An API identifier cannot be edited after creation.** It is a value (`https://api.<domain>`), not
  the name of the env var it lands in. Getting it wrong means deleting the API and starting over.
- **Deploying an Action is not the same as running it.** After Deploy, drag it into
  **Actions → Triggers → <trigger>** and press Apply, or it never executes and logs nothing.
- **Claims go on the access token**, via `api.accessToken.setCustomClaim`. On the ID token only, the
  API sees `undefined` and every gated route returns `EMAIL_UNVERIFIED` / `MFA_REQUIRED`.
- **Per-app authorization needs an explicit grant.** Without it the app cannot request the audience
  at all and login dies with `access_denied`.
- **The MFA claim needs the tenant policy too.** `staff-post-login.js` only records whether MFA
  happened; without **Security → Multi-factor Auth → Always**, the claim is always `false` and the
  guard rejects every staff token.

## 3. Neon

- Project with a `dev` branch; 7-day PITR on the production branch (§17)
- Owner connection string → `DIRECT_DATABASE_URL` (unpooled, migrations only)
- Then, once per environment, create the two login roles and grant them the group roles the
  migration created:

  ```sql
  CREATE ROLE portal_app_staging   LOGIN PASSWORD '…';  GRANT portal_app   TO portal_app_staging;
  CREATE ROLE portal_admin_staging LOGIN PASSWORD '…';  GRANT portal_admin TO portal_admin_staging;
  ```

  Pooled URLs for those two roles → `DATABASE_URL` and `ADMIN_DATABASE_URL`.
  Passwords go straight to SSM. See [ADR 0006](../decisions/0006-tenancy-rls-and-append-only.md).

- Apply and seed:

  ```sh
  pnpm db:deploy && pnpm db:seed
  ```

`DATABASE_URL` must **not** be the owner. The API refuses to boot if it is — that check is
the only thing standing between a fat-fingered connection string and silent cross-tenant
reads.

## 4. AWS

| Resource                 | Notes                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| IAM user for CI          | Least privilege: `ssm:PutParameter` + `ssm:SendCommand`, S3 write on the frontend buckets, `cloudfront:CreateInvalidation` |
| EC2 `t3.small` (staging) | Docker + Compose; runs api, worker, redis, Caddy (ADR 0004)                                       |
| Elastic IP               | Stable address for `api.<domain>` — Retell and Stripe webhooks point at it                        |
| SSM Parameter Store      | `/voice-agent/<env>/*`, SecureString. The only home for secrets (§17)                             |
| KMS key                  | Wraps the SIP credential data key, AES-256-GCM → `SIP_CREDENTIALS_KMS_KEY_ID`                     |
| S3 ×4, private           | Static export per app per environment. *Block all public access* ON; reachable only via CloudFront OAC (ADR 0008) |
| CloudFront ×2            | `frontend/web` → `app.<domain>`, `frontend/admin` → `admin.<domain>`. Map **403 and 404** → `/index.html` 200 |
| ACM certificate          | **Request in `us-east-1`**, whatever region the account runs in — CloudFront reads certs only from N. Virginia |
| Cloudflare R2            | Bucket for CSV/audio exports                                                                      |

## 5. Local webhook tunnel

Retell and Stripe need a public URL during development:

```sh
cloudflared tunnel --url http://localhost:4000
```

Put the printed hostname into the Retell and Stripe **test** webhook settings and into
`API_PUBLIC_URL`. The tunnel URL changes on restart; a named tunnel avoids that.

## 6. Verify

```sh
pnpm infra:up          # local Postgres + Redis
pnpm db:roles          # local portal_app / portal_admin login roles
pnpm db:deploy         # migrations
pnpm db:seed           # staff_role_limits (admin §2.2), packs (§5.2)
pnpm doctor            # which env vars are missing, what is reachable
pnpm test              # unit
pnpm test:e2e          # RLS, append-only, auth boundaries — needs the database
```

`pnpm doctor` exits non-zero while anything required is unset, so it works as a CI gate on
the staging environment too.
