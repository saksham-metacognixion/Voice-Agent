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
| `api`    | `node dist/main.js`   | Webhooks and SSE terminate here, never on Vercel.                                    |
| `worker` | `node dist/worker.js` | No exposed port. BullMQ processors + Job Schedulers.                                 |
| `redis`  | redis:7-alpine        | `appendonly yes`, `maxmemory-policy noeviction`. Compose-internal network only.      |

One `t3.small` for staging and one `t3.medium` for prod, each with an Elastic IP. Secrets come from SSM
Parameter Store at deploy time. Deploy = CI builds and pushes the image, then runs
`docker compose pull && docker compose up -d` on the instance over SSM or SSH. Rollback = the same command
with the previous image tag.

Postgres is on Neon, not AWS, for 7-day point-in-time recovery at low cost (ADR 0001, ADR 0004). Use the
pooled connection string as `DATABASE_URL` and the unpooled one as `DIRECT_DATABASE_URL`.

## Vercel projects

Two projects from the same repo: root directory `frontend/web` and `frontend/admin`. Framework preset
Next.js, install command `pnpm install --frozen-lockfile`, build command `pnpm turbo run build --filter=@portal/<app>...`.
