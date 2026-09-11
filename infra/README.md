# infra

| File                 | Purpose                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `docker-compose.yml` | Local Postgres 16 + Redis 7. `pnpm infra:up` / `pnpm infra:down`.                                |
| `Dockerfile`         | Backend image. Railway builds it once and runs it as two services with different start commands. |
| `railway.json`       | Railway service config: Dockerfile builder, `/health` check, restart policy.                     |

## Railway services

| Service  | Start command         | Notes                                                                              |
| -------- | --------------------- | ---------------------------------------------------------------------------------- |
| `api`    | `node dist/main.js`   | Public, bound to `api.<domain>`. Webhooks and SSE terminate here, never on Vercel. |
| `worker` | `node dist/worker.js` | No public port. BullMQ processors + Job Schedulers.                                |
| `redis`  | Railway Redis plugin  | Private network only. TCP, which BullMQ needs.                                     |

Postgres is on Neon, not Railway, for 7-day point-in-time recovery (spec §17, ADR 0001). Use the
pooled connection string as `DATABASE_URL` and the unpooled one as `DIRECT_DATABASE_URL`.

## Vercel projects

Two projects from the same repo: root directory `frontend/web` and `frontend/admin`. Framework preset
Next.js, install command `pnpm install --frozen-lockfile`, build command `pnpm turbo run build --filter=@portal/<app>...`.
