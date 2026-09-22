# infra

| File                            | Purpose                                                                                                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker-compose.yml`            | Local Postgres 16 + Redis 7. `pnpm infra:up` / `pnpm infra:down`.                                                                                                            |
| `docker-compose.prod.yml`       | EC2 services: api, worker (1 CPU / 1 GB), redis, caddy. `docs/runbooks/staging.md`.                                                                                          |
| `caddy/Caddyfile`               | TLS + reverse proxy for `api.<domain>`; SSE passthrough, HSTS.                                                                                                               |
| `scripts/deploy.sh`             | Runs on the instance: `.env` from SSM, `compose pull && up -d --wait`. Rollback = previous tag.                                                                              |
| `scripts/instance-bootstrap.sh` | One-time: Docker + Compose (skipped on a template-built box), the GHCR login and the private clone.                                                                          |
| `aws/staging-stack.yaml`        | CloudFormation: SG, instance role, EC2 (Ubuntu 24.04, IMDSv2), Elastic IP, KMS key, CI user, operator policy. One stack per environment (ADR 0015).                          |
| `scripts/ssm-put-env.sh`        | Pushes a `KEY=VALUE` file kept outside the repo into `/voice-agent/<env>/*` as SecureStrings; `--check` says what deploy.sh will find.                                       |
| `scripts/db-env-roles.sh`       | Creates/rotates `portal_app_<env>` / `portal_admin_<env>` and writes their URLs into that file. Takes `DB_PUBLIC_HOST` when it reaches a private RDS through the SSM tunnel. |
| `Dockerfile`                    | Backend image, built once by CI and pushed to GHCR. Run as `api` and `worker` with different commands.                                                                       |
| `auth0/`                        | Auth0 tenant configuration and Actions source (ADR 0002).                                                                                                                    |

## Backend on AWS EC2 (ADR 0004)

| Service  | Command               | Notes                                                                                |
| -------- | --------------------- | ------------------------------------------------------------------------------------ |
| `caddy`  | —                     | Automatic TLS, reverse proxy for `api.<domain>` → `api:4000`. Only port 443 is open. |
| `api`    | `node dist/main.js`   | Webhooks and SSE terminate here, never on the frontend CDN.                          |
| `worker` | `node dist/worker.js` | No exposed port. BullMQ processors + Job Schedulers.                                 |
| `redis`  | redis:7-alpine        | `appendonly yes`, `maxmemory-policy noeviction`. Compose-internal network only.      |

One `t3.small` for staging and one `t3.medium` for prod, each with an Elastic IP, all from
`aws/staging-stack.yaml` (region `ca-central-1`; domain `oraly.ai`, `api-staging.oraly.ai` for staging). Secrets come from SSM
Parameter Store at deploy time (`scripts/deploy.sh`). Deploy = CI builds and pushes the image to GHCR,
then runs `deploy.sh <env> <tag>` on the instance over SSM Run Command. Rollback = the same command with
the previous image tag. The **worker is capped at 1 CPU and 1 GB** so knowledge ingestion, exports and
reconciliation can never starve the API's §13.9 inbound path; the API is deliberately uncapped (ADR 0014 §9).

Postgres is a private RDS instance in the same stack (ADR 0016): no public address, reachable only from the
instance's security group, 7-day PITR for §17. The developer reaches it through Session Manager port
forwarding. `DATABASE_URL` is `portal_app_<env>`, `ADMIN_DATABASE_URL` is `portal_admin_<env>`, and
`DIRECT_DATABASE_URL` is the master user, used for migrations only.

## Frontend on S3 + CloudFront (ADR 0008)

Both Next.js apps build as a **static export** (`output: 'export'`) and ship to a private S3 bucket
served by CloudFront. There is no Amplify app and no `infra/amplify/`.

| Piece          | Role                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **S3**         | One private bucket per app per environment. _Block all public access_ ON. Reached only through CloudFront's OAC.        |
| **CloudFront** | CDN + TLS for `app.<domain>` and `admin.<domain>`. Custom error responses map **403 and 404** → `/index.html` with 200. |
| **ACM**        | One certificate, requested in **us-east-1** — CloudFront reads certs only from N. Virginia, whatever region you run in. |

A private bucket answers a missing key with **403, not 404**, which is why both codes need the SPA
fallback. Set `trailingSlash: true` and `images: { unoptimized: true }` in `next.config.ts`.

Deploy, from the existing GitHub Actions workflow:

```sh
pnpm turbo run build --filter=@portal/web...
aws s3 sync frontend/web/out/ s3://$BUCKET --delete \
  --cache-control 'public,max-age=31536000,immutable' --exclude '*.html'
aws s3 sync frontend/web/out/ s3://$BUCKET --delete \
  --cache-control 'no-cache' --exclude '*' --include '*.html'
aws cloudfront create-invalidation --distribution-id "$DIST" --paths '/*'
```

`NEXT_PUBLIC_*` is baked in at build time, so staging and production are separate builds — never the
same artifact promoted, and nothing secret in one. The apps call `api.<domain>` on EC2 directly
(ADR 0004); webhooks and SSE never touch CloudFront. Auth is `@auth0/auth0-spa-js` with PKCE, so no
Auth0 client secret exists in the frontend at all.
