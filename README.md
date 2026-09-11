# Voice Agent Self-Service Portal

Build, test and publish an AI phone agent in under 15 minutes, then run it on prepaid credits.
Start with [CLAUDE.md](CLAUDE.md) for the full context, then the specs in [docs/](docs/).

## Quick start

```bash
pnpm install
cp .env.example .env
pnpm infra:up                 # postgres + redis in Docker
pnpm db:migrate               # apply migrations to the local DB
pnpm dev                      # web :3000, admin :3001, api :4000
```

## Layout

- `frontend/` — Next.js apps and UI packages, deployed to Vercel
- `backend/` — NestJS API + worker and the Prisma package, deployed to Railway
- `shared/` — zod schemas and tooling config imported by both
- `docs/` — specs, decisions, delivery plan
