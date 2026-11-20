# Staging deployment log — what was actually done, and why

The procedure lives in [staging.md](staging.md). **This file is the record of the real run**:
the values that exist, the order things happened in, and every problem hit on the way, so that
production is a repeat rather than a rediscovery.

Environment: **staging**. Account **667723749107** (`metacognixion`), region **ca-central-1**.
Domain **oraly.ai** (Namecheap, BasicDNS — ADR 0015). Started 22 Sep 2026.

## Where it stands

| Step                                               | State                                                               |
| -------------------------------------------------- | ------------------------------------------------------------------- |
| 0. IAM permissions for the deployer                | **done** — Pramod attached `voice-agent-deploy-iam`                 |
| 1. Backend stack (EC2, EIP, RDS, KMS, CI user)     | **done** — `voice-agent-staging-backend`, CREATE_COMPLETE           |
| 2. DNS `api-staging` → Elastic IP                  | **done** — added at Namecheap, propagating                          |
| 3. Database: migrations, seed, login roles         | **done** — 10 migrations, 51 tables, both roles RLS-checked         |
| 4. Configuration → SSM Parameter Store             | **done** — 31 parameters under `/voice-agent/staging/`              |
| 5. Instance bootstrap (registry login, repo clone) | **done** — 23 Sep, GHCR login + private clone                       |
| 6. First deploy                                    | **done** — 23 Sep 11:36 IST, `develop`, all four containers healthy |
| 7. Retell / Stripe / Auth0 pointed at staging      | Stripe and Auth0 done (23 Sep); Retell pending                      |
| 8. GitHub `staging` environment, CI deploys        | **done** — backend and portal deploy on every `develop` push        |
| F. Frontend stack (S3 + CloudFront)                | **done** — `voice-agent-staging-web`, `app-staging.oraly.ai`, D8 exit passed 23 Sep |

Step-by-step version with every value: [staging-deployment-steps.md](staging-deployment-steps.md).

## What exists now

Everything below came from the stack outputs. None of it is secret.

| Thing                    | Value                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Elastic IP               | `16.52.177.152`                                                                                                  |
| Instance                 | `i-0f90a16bb513e2d6d`, `t3.small`, Ubuntu 24.04, IMDSv2, 2 GB swap                                               |
| Database                 | `voice-agent-staging.chme08mmqijq.ca-central-1.rds.amazonaws.com`, `db.t4g.micro`, PostgreSQL 16.13, **private** |
| Database master password | Secrets Manager, `rds!db-fe837eb4-…-KL7C7L`. Used by a human for migrations; the app never sees it               |
| SIP credential key       | `arn:aws:kms:ca-central-1:667723749107:key/a181f88c-882f-4a45-bb9d-a13c43dccb62`                                 |
| CI user                  | `voice-agent-ci-staging` — may only run the deploy on that one instance                                          |
| Configuration            | 31 SecureStrings under `/voice-agent/staging/`                                                                   |
| Hostname                 | `api-staging.oraly.ai`                                                                                           |
| VPC / subnets            | default `vpc-0379a2b8999bd6fdf`; instance in `subnet-07b5e1af748e6f8f9`, database across all three               |

## What was done, in order, and why

### 0. Permissions before anything else

The stack creates an instance role and a CI user, so the deployer needs IAM rights that
`PowerUserAccess` does not include. `voice-agent-devs` had `iam:Create*` but not `Get*` or
`Delete*`, which is worse than having neither: CloudFormation creates a resource, reads it back
to confirm, and deletes what it made when a stack fails. See _Problems_, first entry.

Pramod attached `voice-agent-deploy-iam`, a hardened variant of
`infra/aws/operator-bootstrap-policy.json` that is IAM-only and scoped to `voice-agent-*`. Its
first statement, `CreateOnlyWithBoundary`, allows `iam:CreateRole` and `iam:CreateUser` **only**
when the new identity carries the permissions boundary
`arn:aws:iam::667723749107:policy/VoiceAgentBoundary`. That is why the stack is deployed with
`PermissionsBoundaryArn` set; without it, `CreateRole` is refused.

`VoiceAgentBoundary` is also attached to `voice-agent-devs` directly. A permissions boundary is
normally set, not attached, and an attached boundary that carried a blanket `iam:*` Deny would
have broken everything. A probe returned `NoSuchEntity` rather than `AccessDenied`, so it carries
no such Deny — and its Allow statements are, in practice, what gives the deployer `ssm:StartSession`
and `ssm:PutParameter`. Worth tidying, not worth blocking on.

### 1. The stack

One CloudFormation template, `infra/aws/backend-stack.yaml`, rather than console clicks, because
production must be the same file with `EnvName=prod`, because a failure cleans up after itself,
because the file is the documentation, and because a template can be reviewed — a set of clicks
cannot. `OperatorIamUser` was left empty: Pramod granted those rights to the user directly, so
the stack has one less IAM resource to create and one less thing to fail on.

### 2. DNS

An A record at Namecheap from `api-staging` to the Elastic IP. First, because propagation takes
up to the zone's hour-long TTL and everything else can happen while it settles. Caddy will not
issue a Let's Encrypt certificate until the name resolves to the box.

### 3. The database

The stack created an **empty** database. Three commands make it usable, and each does something
the next depends on:

- `pnpm db:deploy` — ten migrations. Not just tables: the RLS policies that are the second guard
  on tenancy (ADR 0006), the `portal_app` / `portal_admin` group roles, the append-only triggers
  on `credit_ledger`, `audit_log` and `staff_audit_log`, and the partial unique index that stops
  a replayed `call_ended` webhook from billing a customer twice. None of this is generated by
  Prisma; it is hand-written SQL that must run.
- `pnpm db:seed` — the catalogue the app reads at runtime: packs, pricing config v1, the agent
  stack (tier → model and voice, the guardrails, the lint), the seven templates, staff role
  limits, flags and kill switches. Publish answers `503 NOT_CONFIGURED` without the stack row.
- `infra/scripts/db-env-roles.sh` — the two **login** roles. The migration's roles are `NOLOGIN`
  group roles; nothing can connect as them. `portal_app_staging` (RLS enforced) becomes
  `DATABASE_URL`, `portal_admin_staging` (crosses workspaces by policy) becomes
  `ADMIN_DATABASE_URL`. The master user is not used by the app at all: `assertRlsEnforced()`
  refuses to boot on a superuser, an owner, or a non-member of `portal_app`, because that check
  is the only thing between a mistyped connection string and silent cross-tenant reads.

All three ran **through an SSM port-forwarding tunnel**, because the database has no public
address (ADR 0016) and only the instance's security group reaches port 5432. The script takes
`DB_PUBLIC_HOST` so the URLs it writes name the address the _server_ uses while it connects over
the tunnel itself; without it the box would be handed a `localhost` port.

Verified afterwards that the migrations landed on RDS and not on the local Docker database: the
two report different patch versions, and `portal_app_staging` exists only on one of them.

### 4. Configuration to SSM

`infra/scripts/ssm-put-env.sh` pushes a `KEY=VALUE` file kept **outside the repository** (mode 600) into `/voice-agent/staging/` as SecureStrings. It validates before writing — no empty
values, no `localhost` in `PORTAL_URL`, `API_PUBLIC_URL` must be https, the file must not be
inside the repo — and prints key names and lengths only, never values. `deploy.sh` reads the path
back on the box and writes a root-only `.env`. That is the whole chain, and nothing but
`.env.example` is ever committed (§17).

Values worth recording, without the secrets:

- Reused from dev, because they are the same everywhere or the same Stripe test account:
  `ANTHROPIC_API_KEY`, `AUTH0_CUSTOMER_ACTION_SECRET`, `STRIPE_SECRET_KEY`,
  `STRIPE_PUBLISHABLE_KEY`, and both Auth0 tenant domains and audiences.
- Generated for this environment: `RECORDING_SIGNING_SECRET`. It must not be shared — a link
  signed by one process has to verify in another.
- From the stack: `SIP_CREDENTIALS_KMS_KEY_ID`, `AWS_REGION`, all three database URLs.
- Created for staging: a Stripe webhook endpoint at `https://api-staging.oraly.ai/webhooks/stripe`.
  Stripe does not check that the URL is live, so this could be done before the deploy.
- Deliberately left out: `RESEND_API_KEY` and `OPS_ALERT_WEBHOOK_URL`. Without them the email
  sender and the ops alerts become log lines, which is fine until launch. The script refuses an
  empty value, so the lines were removed rather than blanked.

## Step 5–6: the instance and the first deploy (23 Sep 2026)

**CI had never published the image.** The `check` job was failing, and `image` `needs: [check]`,
so nothing was ever pushed to GHCR — the deploy would have died on `docker compose pull`
whatever else was right. Two commits cleared it:

- `ab91e84` — the GHCR owner lowercased (GHCR refuses `Metacognixion-labs`), an IMDSv2 token
  for the region lookup in `deploy.sh`, and `BACKEND_IMAGE` passed through from CI.
- `e6a01b6` — `worker-module.e2e.test.ts` builds the **real** `WorkerModule`, whose `AuthConfig`
  requires four `AUTH0_*` variables. It imports `d5-fixtures` for that file's top-level
  placeholder block, but the Auth0 four were set inside `startD5Harness()`, which this suite
  never calls. A developer's repo-root `.env` filled them in locally, so the gap was invisible
  until CI, which has no `.env`. They are now `||=` placeholders alongside the other
  placeholders, so `startD5Harness()` still overrides them with its two fake tenants.

Why CI could not fall back on its own `env:` block: `turbo.json` declares
`globalPassThroughEnv`, which puts Turborepo 2 in `envMode: strict` (confirmed with
`turbo run test:e2e --dry=json`). Only `NODE_ENV`, `CI` and the four database/Redis URLs
reach a task. The workflow sets `APP_ENV: ci` and it is filtered out before the tests see it
— the CI log says `APP_ENV is not set; assuming prod`. That is still true and is listed under
_Open_; it is not what broke the build, and fixing it changes CI behaviour, so it was left
for its own commit.

**The permissions boundary turned out to be fine.** `VoiceAgentBoundary` caps the instance
role and its contents cannot be read (`iam:GetPolicyVersion` is scoped to `policy/voice-agent-*`),
so whether the box could read its own configuration was unknown and would have shown up as a
box that boots and then fails. Settled before touching anything, with one read-only Run Command
as the instance itself:

    aws ssm get-parameters-by-path --path /voice-agent/staging/ --recursive --with-decryption

It returned all 31 parameters, which also proves `kms:Decrypt` — SecureStrings cannot be read
without it. The same probe confirmed `aws`, `docker` and
`/var/log/voice-agent-bootstrap.done`, so user data had already done the package half.

**Bootstrap** was `instance-bootstrap.sh` with `GH_USER`/`GH_TOKEN` (classic PAT, `repo` +
`read:packages`) over Session Manager: `docker login ghcr.io`, `/root/.git-credentials`, and the
private repo cloned to `/opt/voice-agent/infra`. Fine-grained tokens do not work with GHCR.

**The deploy** was `deploy.sh staging develop`: 31 parameters out of SSM, `APP_ENV`,
`BACKEND_IMAGE` and `BACKEND_TAG` written by the script itself, three images pulled, four
containers up, and Caddy's first Let's Encrypt certificate — which is why the DNS record had
to exist first.

Verified from outside the box, which is the only check that means anything:

| Check               | Result                                                           |
| ------------------- | ---------------------------------------------------------------- |
| `GET /health`       | 200, `env: staging`                                              |
| `GET /health/ready` | 200 — postgres, redis and the worker heartbeat all ok            |
| Job schedulers      | **13**, the full §13.11 set                                      |
| TLS                 | Let's Encrypt `CN=api-staging.oraly.ai`, valid to 22 Dec 2026    |
| Memory / swap       | 1183 MB available, swap **0 used** — the `t3.small` sizing holds |
| Disk                | 21 % of 29 GB                                                    |
| `api` container log | zero errors                                                      |

## Problems hit, and what they cost

**`ROLLBACK_FAILED` on the first stack attempt.** `iam:GetUser` was denied, so CloudFormation
created the CI user, could not read it back, failed the stack — and then could not delete what it
had made, because `iam:Delete*` was denied too. Two orphaned resources were left whose fixed
names would have collided with the next attempt. Fixed by granting the policy; the orphans were
then removed. **Lesson for prod: `Get*` and `Delete*` are not optional.**

**A permissions boundary the template did not know about.** Pramod's policy requires every
identity the stack creates to carry `VoiceAgentBoundary`. The template already had an optional
`PermissionsBoundaryArn` parameter, so this cost one field rather than a rewrite. **For prod,
set it from the start.**

**The wrong AWS account on the laptop.** The CLI was configured for `skydiveos-deploy` in
account `878013573203`, another project. CloudShell worked because it uses the browser's
identity. Fixed with an access key for `voice-agent-devs` and a `voice-agent` profile.
`session-manager-plugin` also had to be installed: without it `aws ssm start-session` cannot open
a tunnel even when the permissions are right.

**Two IAM policy drafts.** A concurrent session wrote `infra/aws/deployer-policy.json` covering
CloudFormation, ACM, S3 and CloudFront while this one wrote `operator-bootstrap-policy.json`
covering IAM. They overlap without conflicting. Pramod ultimately wrote a third. Worth
consolidating before prod.

**Secrets pasted into a chat transcript.** The Stripe webhook secret and a Retell API key were
pasted while being set. Both should be rotated. Neither is live yet, so the cost is one click
each. The dry-run output is safe to share; values never are.

## Open

**The backend image may not exist in GHCR.** CI on `2b83971` ran with the old workflow, which
pushed to `ghcr.io/Metacognixion-labs/voice-agent-backend` — GHCR refuses an uppercase repository
name. The fix (lowercasing the owner) is in the working tree but **not committed**, so the first
`docker compose pull` will fail until `.github/workflows/ci.yml` and `infra/scripts/deploy.sh`
are committed and pushed. Check the Actions run and the org's Packages page to confirm.

**`VoiceAgentBoundary`'s contents are unverified.** The deployer may not read it
(`iam:GetPolicyVersion` is scoped to `policy/voice-agent-*`, and the name is CamelCase). The
boundary caps the instance role, so if it does not allow `ssm:GetParametersByPath`, `kms:Decrypt`
and `secretsmanager:GetSecretValue`, the box will boot and then fail to read its own
configuration. Ask Pramod for the JSON.

**Retell shares one workspace with development.** The nightly `reconcile-calls` job lists every
call in the workspace and counts any it cannot match as drift, so local test calls will show as
staging drift. Harmless while ops alerts are log lines; create a `staging` workspace before
wiring `OPS_ALERT_WEBHOOK_URL`, or reconciliation can never be trusted.

**`AWSServiceRoleForRDS` already existed** in this account, so the narrower
`SsmServiceLinkedRole` statement in Pramod's policy was not a problem. In a fresh account it
would be.

## What production will need differently

- `EnvName=prod`, `InstanceType=t3.medium`, `DbInstanceClass` at least `db.t4g.small`,
  `DbMultiAz=true`. The template turns on RDS deletion protection for prod by itself.
- Its own Retell workspace, its own Stripe **live** keys and webhook endpoint, and its own Auth0
  tenants — the dev tenants are shared with staging only because the free plan allows one tenant
  per account.
- Hostnames without the `-staging` suffix, and a second certificate.
- `RESEND_API_KEY` and `OPS_ALERT_WEBHOOK_URL` are no longer optional.
- A separate CI user, `voice-agent-ci-prod`, so a leaked staging key can never reach production.
