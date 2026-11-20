# 0034 — Migrations run on every deploy, before the code restarts

Date: 28 Oct 2026. Status: accepted. **Amends ADR 0016** (the master password is read by
`deploy.sh` now, not only by a human through the tunnel) and the deploy in ADR 0004 / ADR 0014
§8. Builds on ADR 0015 (configuration reaches the box only from SSM).

## Context

On 28 Oct the console's Overview answered `500 INTERNAL` on `GET /admin/kpis` and
`GET /admin/system/health`. Staging was running `sha-8199b2b` and its log said
`The table public.platform_settings does not exist`: the commit that added the table had
deployed, its migration had not. It was not the first time. Every commit with a migration
did the same thing until someone opened the SSM tunnel and ran `pnpm db:deploy` by hand
(runbook step 3), for three reasons:

- CI builds the image and runs `deploy.sh` on every push to `develop`; nothing in that path
  migrates.
- The image could not migrate if asked: `pnpm deploy --prod` leaves out the Prisma CLI (a dev
  dependency) and `prisma/migrations/`.
- `/health/ready` checks that Postgres answers, not that its schema matches the code, so the
  deploy reported success and the failure showed up only when someone opened the page.

The owner credential was a second problem. `DIRECT_DATABASE_URL` was written to SSM on
22 Sep, but the RDS-managed master secret rotates every 7 days (last on 27 Oct), so that
copy is a dead password.

## Decision

1. **The image carries its own migrations.** A `migrator` stage in `infra/Dockerfile` installs
   the exact Prisma CLI version the client was generated with, copies `backend/db/prisma`
   (schema + migrations) and `backend/db/scripts/migrate-deploy.mjs` to `/migrate` in the
   runtime image. The SQL that runs is therefore always that of the commit being deployed.
2. **`deploy.sh` migrates between `pull` and `up`.** It runs
   `docker compose run --rm --no-deps migrate`, a compose service under the `migrate` profile
   that `up` never starts. A failure exits non-zero before anything restarts, so the
   environment keeps running the previous image. The order is schema first, code second.
3. **The owner password is read at deploy time, never stored.** The stack publishes the master
   secret's ARN as `/voice-agent/<env>/DB_MASTER_SECRET_ARN` (an SSM `String`, on the path the
   box already reads) and gives the instance role `secretsmanager:GetSecretValue` on that one
   secret. `deploy.sh` reads it and hands it to the one `migrate` container as
   `DB_OWNER_SECRET`. It is never written to `.env` and never printed. `migrate-deploy.mjs`
   takes host, port, database and parameters from `ADMIN_DATABASE_URL` and the user and
   password from the secret. With no ARN it falls back to `DIRECT_DATABASE_URL` as is, for a
   database whose owner password does not rotate. With neither, the deploy refuses.
   `ssm-put-env.sh` refuses `DB_MASTER_SECRET_ARN` in a file, because the stack owns it.
4. **CI proves it before the box does.** The image job runs `/migrate/migrate-deploy.mjs`
   from the built image against an empty `postgres:16-alpine`: a missing CLI, a schema engine
   that does not load on Alpine, or a migration that does not apply from scratch fails CI.
5. **`SKIP_MIGRATIONS=1`** skips the step for an operator who has already migrated by hand.
   It is an escape hatch, not a mode.

Migrations go forward only. A rollback (`deploy.sh <env> <older tag>`) runs older code
against the newer schema. That is safe for additive migrations (new tables, new nullable
columns), which is what this repo writes. A migration that drops or renames something must
ship in two deploys, the code that stops using it first.

## Alternatives considered

- **A separate migrator image tag.** Same result with a smaller runtime image, but two tags
  per build and a way for a deploy to pair code with the wrong SQL. Rejected. The cost of one
  image is ~130 MB (the CLI and its schema engine).
- **Migrate from CI.** The database is private in the VPC (ADR 0016); CI would need a tunnel
  or a public endpoint. The instance is already inside.
- **Migrate on API boot.** Two processes (api, worker) would race, and a slow migration would
  hold the API's healthcheck. Prisma takes an advisory lock, but a one-off step is easier to
  read in a deploy log and fails the deploy instead of a container.
- **A readiness check that compares migrations.** Still worth having as a second guard, but
  it only reports drift; it does not fix it.
- **Keep `DIRECT_DATABASE_URL` in SSM and update it on rotation.** It would need a rotation
  hook, and the password would sit in a second place. Reading the secret where it lives is
  simpler.

## Consequences

- A push with a migration reaches staging with its schema, or does not reach it at all.
- The instance role can read the database master secret. Only `deploy.sh` uses it; the app
  containers never see it. `VoiceAgentBoundary` caps the role and its contents are unverified
  (staging deploy log): if it does not allow `secretsmanager:GetSecretValue`, the deploy stops
  at "cannot read the database owner secret" with nothing restarted. Check once after the
  stack update (runbook).
- **Rollout order: update the stack, then push.** Before the stack update the box has no
  `DB_MASTER_SECRET_ARN`, falls back to the stale `DIRECT_DATABASE_URL`, fails to migrate and
  refuses the deploy (safely).
- The runtime image grows by ~130 MB.
