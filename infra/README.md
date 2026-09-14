# infra

| File                      | Purpose                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `docker-compose.yml`      | Local Postgres 16 + Redis 7. `pnpm infra:up` / `pnpm infra:down`.                                      |
| `docker-compose.prod.yml` | EC2 services: api, worker, redis, caddy. Lands on D7.                                                  |
| `Dockerfile`              | Backend image, built once by CI and pushed to GHCR. Run as `api` and `worker` with different commands. |
| `auth0/`                  | Auth0 tenant configuration and Actions source (ADR 0002).                                              |

## Backend on AWS EC2 (ADR 0004)

| Service  | Command               | Notes                                                                                |
| -------- | --------------------- | ------------------------------------------------------------------------------------ |
| `caddy`  | —                     | Automatic TLS, reverse proxy for `api.<domain>` → `api:4000`. Only port 443 is open. |
| `api`    | `node dist/main.js`   | Webhooks and SSE terminate here, never on the frontend CDN.                          |
| `worker` | `node dist/worker.js` | No exposed port. BullMQ processors + Job Schedulers.                                 |
| `redis`  | redis:7-alpine        | `appendonly yes`, `maxmemory-policy noeviction`. Compose-internal network only.      |

One `t3.small` for staging and one `t3.medium` for prod, each with an Elastic IP. Secrets come from SSM
Parameter Store at deploy time. Deploy = CI builds and pushes the image, then runs
`docker compose pull && docker compose up -d` on the instance over SSM or SSH. Rollback = the same command
with the previous image tag.

Postgres is on Neon, not AWS, for 7-day point-in-time recovery at low cost (ADR 0001, ADR 0004). Use the
pooled connection string as `DATABASE_URL` and the unpooled one as `DIRECT_DATABASE_URL`.

## Frontend on S3 + CloudFront (ADR 0008)

Both Next.js apps build as a **static export** (`output: 'export'`) and ship to a private S3 bucket
served by CloudFront. There is no Amplify app and no `infra/amplify/`.

| Piece          | Role                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **S3**         | One private bucket per app per environment. *Block all public access* ON. Reached only through CloudFront's OAC.        |
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
