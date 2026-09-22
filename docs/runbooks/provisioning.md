# Provisioning runbook — external accounts and staging infrastructure

Everything here needs a human with a credit card and an AWS console. The code in this repo
is written against these values; `pnpm doctor` tells you which ones are still missing.

Work top to bottom — later rows depend on earlier ones. Each row names the `.env` key the
value lands in; the same key is the SSM parameter name under `/voice-agent/<env>/` for
staging and prod (§17: nothing but `.env.example` is ever committed).

## 1. Vendor accounts

| Vendor        | What to create                                                                                                                                                                        | Lands in                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Retell AI** | One **workspace per environment** (dev/staging/prod — dashboard only, no API); one API key per workspace, with the _webhook_ badge — it is also the webhook signing secret (ADR 0003) | `RETELL_API_KEY`                                                       |
| **Stripe**    | Account in **test mode**; restricted key; webhook endpoint → `api.<domain>/webhooks/stripe`                                                                                           | `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` |
| **Anthropic** | API key (console.anthropic.com, with billing). Brief → prompt only, never in the call path (ADR 0009)                                                                                 | `ANTHROPIC_API_KEY`, `GENERATION_MODEL`                                |
| **Resend**    | Domain verified, sending key                                                                                                                                                          | `RESEND_API_KEY`, `EMAIL_FROM`                                         |

Stripe test and live keys never mix — separate accounts or at least separate restricted
keys per environment, and a different webhook secret for each.

## 2. Auth0 — two tenants (ADR 0002)

Two **separate tenants**, not two applications in one. The API asserts at boot that the
issuers differ; collapsing them would make a customer token verify on `/admin/*`.

The tenants are configured from `infra/auth0/tenant.*.yaml` with the Auth0 Deploy CLI, not
by hand: **`docs/runbooks/auth0.md`** is the procedure, including the M2M application the
scripts authenticate with and how to reconcile a tenant that was set up by hand first. What
follows is what each tenant has to contain.

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

**What cost time the first time round** (dev, 14 Sep) — all of it fails silently, and all
of it is now either deployed from `infra/auth0/tenant.*.yaml` or checked by
`pnpm auth0:validate` / `verify:auth0`; the longer list is in `docs/runbooks/auth0.md` §5:

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

## 3. Postgres (Amazon RDS, ADR 0016)

Created by the environment's CloudFormation stack, not by hand: a private `db.t4g.micro` in
the same VPC as the backend instance, reachable only from its security group, with 7-day
point-in-time recovery (§17) and a master password generated into Secrets Manager. Nothing to
buy and no vendor account. `docs/runbooks/staging.md` step 3 is the procedure.

- The master user runs migrations and creates the two login roles. The app never uses it.
- `infra/scripts/db-env-roles.sh <env> <owner url> <env file>` creates or rotates
  `portal_app_<env>` and `portal_admin_<env>`, writes the three URLs, and checks that the app
  role is genuinely RLS-enforced. Pass `DB_PUBLIC_HOST` when connecting through the tunnel.
- Reaching it from a laptop is Session Manager port forwarding, never a public address:

  ```sh
  aws ssm start-session --target <instance> \
    --document-name AWS-StartPortForwardingSessionToRemoteHost \
    --parameters '{"host":["<db endpoint>"],"portNumber":["5432"],"localPortNumber":["55432"]}'
  ```

- Local development keeps using Docker Postgres 16 (`pnpm infra:up`), which is what CI runs too.

`DATABASE_URL` must **not** be the master user. The API refuses to boot if it is — that check is
the only thing standing between a fat-fingered connection string and silent cross-tenant
reads.

## 4. AWS

The domain is **oraly.ai** (Namecheap, BasicDNS; ADR 0015). The backend half of this table
is one CloudFormation template, `infra/aws/staging-stack.yaml`, deployed once per environment
by an account administrator — `docs/runbooks/staging.md` step 1 has the command and what to do
with the outputs. The frontend half (S3, CloudFront, ACM) is D8 and still by hand.

| Resource                 | Notes                                                                                                                                                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IAM user for CI          | **Template**: `voice-agent-ci-<env>` — `ssm:SendCommand` on the one instance + `GetCommandInvocation`, nothing else. S3 write on the frontend buckets and `cloudfront:CreateInvalidation` are added at D8 |
| Operator policy          | **Template**: `voice-agent-operator-<env>` for the developer — SSM parameters under the path, Session Manager, manual deploys                                                                             |
| EC2 `t3.small` (staging) | **Template**: Ubuntu 24.04, IMDSv2, encrypted root, no SSH; Docker + Compose + AWS CLI from user data; runs api, worker, redis, Caddy (ADR 0004)                                                          |
| Elastic IP               | **Template**. Stable address for `api-staging.oraly.ai` — Retell and Stripe webhooks point at it                                                                                                          |
| RDS PostgreSQL 16        | **Template**: `db.t4g.micro`, private, gp3 encrypted, 7-day PITR, master password in Secrets Manager (ADR 0016)                                                                                           |
| SSM Parameter Store      | `/voice-agent/<env>/*`, SecureString, written by `infra/scripts/ssm-put-env.sh` from a file outside the repo. The only home for secrets (§17)                                                             |
| KMS key                  | **Template**: `alias/voice-agent-<env>-sip` wraps the SIP credential data key, AES-256-GCM → `SIP_CREDENTIALS_KMS_KEY_ID`                                                                                 |
| S3 ×4, private           | Static export per app per environment. _Block all public access_ ON; reachable only via CloudFront OAC (ADR 0008)                                                                                         |
| CloudFront ×2            | `frontend/web` → `app.oraly.ai`, `frontend/admin` → `admin.oraly.ai` (`-staging` variants first). Map **403 and 404** → `/index.html` 200                                                                 |
| ACM certificate          | **Request in `us-east-1`**, whatever region the account runs in — CloudFront reads certs only from N. Virginia. DNS validation CNAMEs go in Namecheap Advanced DNS                                        |
| Cloudflare R2            | Bucket for CSV/audio exports                                                                                                                                                                              |

## 5. Local webhook tunnel

Retell needs a public URL during development (Stripe does not: `stripe listen` forwards to
localhost). Use a **fixed hostname**: the URL is written into every Retell agent
(`webhook_url`) and number (`inbound_webhook_url`) when the gateway creates them, so a tunnel
whose hostname changes strands every object made against the old one.

```sh
ngrok http 4000 --url=<name>.ngrok-free.app     # one static domain is free; `ngrok http 4000` alone rotates
```

Put the hostname into `API_PUBLIC_URL`, then restart the API so `RetellConfig` picks it up. Nothing
is configured in the Retell dashboard: the gateway sets the agent-level `webhook_url` and the
per-number `inbound_webhook_url` itself. If the hostname does change, re-point existing dev
objects with `pnpm --filter @portal/api spike:retell number mode allow` (numbers) and a
re-publish (agents), or tear them down and recreate.

Verify the round trip without a phone: `spike:retell setup`, `setup-caller`, `phone-call`,
`wait` — the caller number dials the spike number and the fixtures land in
`backend/api/test/fixtures/retell/`. Delete everything with `spike:retell teardown` (numbers are
$2/month each).

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
