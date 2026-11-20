# Voice Agent Self-Service Portal

Build, test and publish an AI phone agent in under 15 minutes, then run it on prepaid credits.
Start with [CLAUDE.md](CLAUDE.md) for the full context, [docs/architecture.md](docs/architecture.md)
for how the system fits together and why, then the specs in [docs/](docs/).

## Quick start

```bash
pnpm install
cp .env.example .env
pnpm infra:up                 # postgres + redis in Docker
pnpm db:roles                 # local portal_app / portal_admin login roles (dev only)
pnpm db:deploy                # migrations, incl. RLS, grants and append-only triggers
pnpm db:seed                  # staff role limits and the pack catalogue
pnpm doctor                   # what is still unset, what is reachable
pnpm dev                      # web :3000, admin :3001, api :4000
```

`pnpm dev` needs the Auth0 values in `.env`; see
[docs/runbooks/provisioning.md](docs/runbooks/provisioning.md) for every external account and
which key it lands in.

## Tests

```bash
pnpm test        # unit — needs nothing running
pnpm test:e2e    # RLS isolation, append-only history, auth boundaries — needs Postgres
```

## Layout

- `frontend/` — Next.js apps and UI packages, built as a static export to S3 + CloudFront (ADR 0008)
- `backend/` — NestJS API + worker and the Prisma package, deployed to AWS EC2 via Docker Compose
- `shared/` — zod schemas and tooling config imported by both
- `docs/` — specs, [architecture](docs/architecture.md), decisions, runbooks, delivery plan
- `infra/` — Dockerfile, compose files, Auth0 Actions, `pnpm doctor`
