# ADR 0001 — Tech stack

- Status: accepted
- Date: 2026-09-11
- Deciders: Saksham (implementation), Pramod (CTO, spec owner)
- Resolves: portal spec §20 decision 7 ("Auth provider and backend framework — align with the existing
  Metacognixion platform stack")

## Context

The portal spec v0.2 proposes a stack in §12.1 (frontend) and §13.1 (backend) and leaves the backend
framework open between NestJS and FastAPI, with Clerk recommended for auth. The build is one developer
working with AI assistance, targeting an MVP live on 2 Oct 2026 and full scope on 9 Oct 2026.

Three constraints shaped every choice:

1. The inbound call authorisation webhook must answer in under 300 ms at p95 (§13.9, §18) because
   Retell times out at 10 s and a slow answer costs a customer a call.
2. BullMQ needs a persistent Node process holding a blocking TCP Redis connection, and `GET /events`
   holds long-lived SSE connections (§13.11, §12.1). Neither survives a function-per-request platform.
3. `@portal/schemas` is shared verbatim between React Hook Form in both Next.js apps and validation in
   the API (§12.1). Anything that forks that schema layer costs days we do not have.

## Decision

| Layer          | Decision                                                                                                                                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo       | pnpm workspaces + Turborepo                                                                                                                                                                                |
| Portal & admin | Next.js App Router, TypeScript, Tailwind, shadcn/ui, TanStack Query, Zustand, React Hook Form + zod, next-intl, PostHog, `retell-client-js-sdk`, `@microsoft/fetch-event-source`                           |
| API            | NestJS on the Fastify adapter, `nestjs-zod` for validation                                                                                                                                                 |
| Worker         | Same codebase, separate entrypoint. BullMQ processors + Job Schedulers                                                                                                                                     |
| Database       | Postgres on Neon + Prisma. RLS on `workspace_id`, two DB roles, append-only ledger                                                                                                                         |
| Cache / queue  | Redis on Railway, TCP                                                                                                                                                                                      |
| Auth           | ~~Clerk, two separate applications~~ → **Auth0, two tenants**. Superseded by [ADR 0002](0002-auth-provider-auth0.md) on 2026-09-11                                                                         |
| Payments       | Stripe Checkout + Customer Portal                                                                                                                                                                          |
| Voice          | Retell Node SDK behind `RetellGateway`                                                                                                                                                                     |
| LLM            | ~~Anthropic SDK, `claude-sonnet-5`~~ → ~~OpenAI SDK, `gpt-5`~~ → **Anthropic SDK, `claude-sonnet-5`** (back to the original), structured output. Superseded by [ADR 0007](0007-llm-provider-openai.md) on 2026-09-14, then [ADR 0009](0009-llm-provider-anthropic.md) on 2026-09-15                                                     |
| Hosting        | ~~Vercel ×2 + Railway + Neon~~ → ~~AWS Amplify Hosting~~ → **S3 + CloudFront (ADR 0008) ×2 + AWS EC2 + Neon**. Superseded by [ADR 0004](0004-backend-hosting-aws-ec2.md) and [ADR 0005](0005-frontend-hosting-aws-amplify.md) on 2026-09-11 |
| Observability  | OpenTelemetry → Grafana Cloud, Sentry, Slack                                                                                                                                                               |

## Alternatives considered

**Plain Fastify with `fastify-type-provider-zod` instead of NestJS.** Genuinely lighter: zod-native
validation, OpenAPI from the same schemas, no DI ceremony, lowest per-request overhead on the webhook
path. Rejected because the spec names NestJS and its module list maps one-to-one onto Nest modules, and
consistency with the written spec is worth more than the saved boilerplate on a solo build. Nest on the
Fastify adapter keeps most of the performance.

**FastAPI (Python).** Rejected: it forks `@portal/schemas` into Pydantic duplicates and replaces BullMQ
with Celery or arq. The spec's own reason for TypeScript end to end stands.

**Next.js route handlers only, no separate API.** Rejected on all three constraints above: function
duration limits break SSE, no persistent process for BullMQ, and cold starts are an unfixable tail-latency
risk on the 300 ms path.

**Drizzle instead of Prisma.** Genuinely better fit for this schema: `SET LOCAL` RLS in one transaction,
`pgPolicy` in the schema file, hand-editable SQL migrations for the `REVOKE` and the ledger trigger, no
engine binary. Rejected because the spec names Prisma. Consequence: the RLS helper wraps queries in an
interactive `$transaction` with `set_config('app.workspace_id', $1, true)`, and policies, grants and
triggers are hand-written SQL inside Prisma migrations.

**Upstash Redis.** Rejected: the HTTP API cannot run BullMQ at all, and the TCP endpoint bills per
command while BullMQ blocking polls and roughly ten schedulers generate a very high command count.
Fly.io's Redis is Upstash-backed and carries the same problem.

**Railway Postgres.** Rejected: snapshots only. §17 requires 7-day point-in-time recovery, which Neon
provides on its paid tier. Render is a reasonable single-vendor fallback if the two-bill setup annoys.

**Identity-provider organisations (Clerk Organizations, Auth0 Organizations) for workspaces.** Rejected:
`tenants` and `memberships` stay the source of truth for authorisation. The provider supplies identity only.

## Consequences

- One language across four deployables; a schema change is one edit.
- Two identity tenants (see ADR 0002) mean two JWKS endpoints. The API picks the issuer by route namespace and
  asserts on boot that the two issuers differ.
- Prisma RLS costs an interactive transaction per tenant request. Index `workspace_id` on every
  RLS-guarded table so `current_setting()` policies stay cheap.
- Ledger immutability needs SQL that Prisma does not model. Those migrations are hand-written and must
  not be regenerated away.
- SSE and webhooks bypass the frontend host entirely and address `api.<domain>`. The portal must never proxy them.
- Two hosting vendors plus Neon means three bills and three status pages to watch.
