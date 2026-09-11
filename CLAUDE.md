# Voice Agent Self-Service Portal

A self-service SaaS where a small or medium service business builds, tests and publishes an AI phone
agent in under 15 minutes, then runs it on **prepaid credits** bought from us. **Retell AI** is the
underlying voice platform and is **never exposed to the customer**. Two Next.js apps (customer portal,
staff admin console) share one backend.

## Source of truth

| Rank | Source                                            | Where                                           |
| ---- | ------------------------------------------------- | ----------------------------------------------- |
| 1    | Portal spec v0.2, 10 Sep 2026, owner Pramod (CTO) | `docs/Voice Agent Project.pdf` (57 pp)          |
| 1    | Admin spec v0.1, 10 Sep 2026                      | `docs/Admin dashboard Voice agent .pdf` (23 pp) |
| 2    | Architecture decisions                            | `docs/decisions/*.md`                           |
| 3    | Code                                              | this repo                                       |

Greppable identifiers (routes, tables, columns, events, Redis keys) live in
`docs/spec-extract/*.txt` with a page-to-section index at the top. The PDF body copy is vector
outlines, so prose and diagrams must be read from the PDF itself. Cite spec sections as `§13.9`
(portal) or `admin §5.2` in commits, PRs and comments.

When the spec and the code disagree, the spec wins unless a decision in `docs/decisions/` overrides it.

## Glossary

- **Workspace** = tenant = one business. Table is `tenants`. A **user** can belong to many workspaces
  via `memberships` with a role (owner / admin / editor / viewer). Everything billable belongs to the
  workspace, never the user.
- **Brief** — the structured fields the customer fills in (`agent_versions.brief_json`). The raw prompt
  is generated from it and is hidden behind "Advanced".
- **Agent version** — an immutable row in `agent_versions`. `source ∈ {generated, feedback, manual, regenerate}`.
- **Credit** — 1 credit = 1 minute of a Standard-tier agent on the phone. Premium = 1.5 credits/min.
  Metered per second, pro-rated, balance shown to 2 decimals.
- **Pack / lot / ledger** — a customer buys a **pack** (Starter/Growth/Scale/Pro/Volume) which creates a
  **credit lot** with a 12-month expiry. Every movement is a row in the append-only `credit_ledger`.
- **Plan tier** — set by the largest pack bought in the last 12 months. Governs concurrency cap, KB
  allowance and feature gates.
- **Tier** (agent) — Standard or Premium. Drives the model/voice stack and the credit rate.
- **Retell objects** — one `retell_llm_id` + one `retell_agent_id` per agent, plus phone numbers and
  knowledge bases. Numbers always run the `latest_published` agent version.
- **Screen IDs** — A1–A8 (auth), W1–W7b (wizard), D1–D8 (dashboard), SA1–SA14 (admin).

## Tech stack

| Layer          | Choice                                                                                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo       | pnpm workspaces + Turborepo                                                                                                                                                            |
| Portal & admin | Next.js App Router, TypeScript, Tailwind, shadcn/ui, TanStack Query, Zustand (ephemeral wizard UI only), React Hook Form + zod, next-intl (en, fr-CA), PostHog, `retell-client-js-sdk` |
| SSE client     | `@microsoft/fetch-event-source` — `EventSource` cannot send `Authorization` or `X-Workspace-Id`                                                                                        |
| API            | NestJS on the Fastify adapter, validation via `nestjs-zod` from `@portal/schemas`                                                                                                      |
| Worker         | Same Nest codebase, separate entrypoint. BullMQ processors + Job Schedulers registered idempotently on boot                                                                            |
| Database       | Postgres on Neon (7-day PITR, §17) + Prisma. RLS on `workspace_id`; two DB roles; append-only ledger                                                                                   |
| Cache / queue  | Redis on Railway (TCP). BullMQ, runtime cache, config cache, SSE pub/sub. **Not Upstash** — HTTP Redis cannot run BullMQ                                                               |
| Auth           | Clerk, **two separate applications**: customers, and staff (Google Workspace domain + mandatory TOTP)                                                                                  |
| Payments       | Stripe Checkout (hosted) + Customer Portal + webhooks                                                                                                                                  |
| Voice          | Retell Node SDK behind a single `RetellGateway`                                                                                                                                        |
| LLM            | Anthropic SDK, `claude-sonnet-5`, structured output. Brief → prompt only, **never in the call path**                                                                                   |
| Hosting        | Vercel ×2 (portal, admin) + Railway (api, worker, redis) + Neon. Webhooks and SSE hit `api.<domain>` directly                                                                          |
| Observability  | OpenTelemetry → Grafana Cloud, Sentry, Slack alerts                                                                                                                                    |
| Storage        | Cloudflare R2 for exports. Recordings stay on Retell URLs, proxied with signed 1-hour URLs                                                                                             |

Rejected and why, in `docs/decisions/0001-tech-stack.md`: plain Fastify (less ceremony but the spec
names NestJS), Drizzle (SQL-first migrations but the spec names Prisma), FastAPI (would fork the shared
zod schema layer), Next.js route handlers only (breaks SSE and BullMQ).

## Repo layout

Split by deploy target. `frontend/` ships to Vercel, `backend/` ships to Railway, `shared/` is imported
by both and never deployed on its own.

```
frontend/                         → Vercel
  web/            @portal/web         Next.js customer portal      app.<domain>
  admin/          @portal/admin       Next.js staff console        admin.<domain>
  ui/             @portal/ui          shadcn components + shared domain widgets
  api-client/     @portal/api-client  typed fetch wrapper + TanStack Query hooks
backend/                          → Railway
  api/            @portal/api         NestJS + Fastify. Two entrypoints: src/main.ts (HTTP, api.<domain>)
                                      and src/worker.ts (BullMQ processors + schedulers). One image, two services.
  db/             @portal/db          Prisma schema, client, migrations incl. hand-written RLS/grants/triggers
shared/
  schemas/        @portal/schemas     zod request/response/SSE schemas, enums, error codes. Depends on zod only.
  config/         @portal/config      tsconfig bases, eslint, tailwind preset
templates/                        *.json agent templates (receptionist, appointment, afterhours, lead_qual, ...)
infra/                            Dockerfile (turbo prune), docker-compose.yml, railway.json
docs/                             specs, decisions, spec-extract, plan, tools
```

The API and the worker import the same `backend/api/src/modules/*/service.ts`. Routes call services; job
processors call the same services.

Backend modules mirror §13.1: `auth, workspaces, agents, prompting, voices, knowledge, numbers, calls,
wallet, billing, webhooks, notifications, events, jobs, admin`.

## Invariants — do not violate

**Retell isolation**

- Only `RetellGateway` imports the Retell SDK. It owns tier → model/voice mapping, webhook URL
  construction, and retry/backoff.
- Retell is never named in customer-facing copy. Say "voice", not "TTS"; "what your agent knows",
  not "knowledge base".

**Webhooks (§13.10, §14.2)**

- Verify signature on the **raw body** (parser scoped to `/webhooks/*` only) → upsert `webhook_events`
  with unique `(provider, external_id, event_type)` → return 2xx fast → process in the queue.
- Duplicate insert returns 204. Never return 5xx to Retell after the event is stored; retry in BullMQ.
- Handle Stripe `checkout.session.completed`, `async_payment_succeeded` and `expired`.

**Metering (§14) — the money rules**

- `call_ended` is the **only** event that moves credits. `call_analyzed` stores analysis and
  `retell_cost_cents` for COGS and **never bills**.
- `duration_s = (end_timestamp − start_timestamp)/1000`. If `disconnection_reason` indicates not
  connected (dial failed, no answer, busy) the charge is 0.
- `credits = duration_s/60 × rate(tier)` rounded to 0.01. Ledger debit is idempotent on `call_id`.
- `calls.rate` and `calls.config_version` are captured at `call_started` from the config current at
  that moment, so a mid-call price change never double-bills.
- Every ledger write goes through the `wallet` module. No direct `credit_ledger` inserts anywhere else.

**Inbound call authorisation (§13.9) — p95 < 300 ms**

- `POST /webhooks/retell/inbound/:number_token`. Redis-only path; Retell times out at 10 s and retries 3×.
- Six ordered checks: workspace not paused → number not paused → caller not in blocklist →
  balance > −10 → active calls < plan cap → hours rule.
- `max_call_duration_ms = min(planMax, remainingCredits/rate × 60000)`.
- Both the allowed and declined paths write a `calls` row **via an enqueued job**, never inline.
  Declined rows carry `decline_reason ∈ {balance, cap, blocked, hours, paused}` and show as "Missed".
- `runtime-cache.refresh(workspaceId)` must be called from every mutating path: pause/resume, plan
  change, number change, publish, ledger write. Plus a periodic full refresh.
- The Redis-down policy is decided in `docs/decisions/0002-retell-findings.md`. Do not invent one.

**Append-only tables**

- `credit_ledger`, `audit_log`, `staff_audit_log`. Enforced twice: `REVOKE UPDATE, DELETE` from the app
  role, **and** a `BEFORE UPDATE OR DELETE … RAISE EXCEPTION` trigger so even a BYPASSRLS connection
  cannot rewrite history. Reversals are new negative rows.
- Balance = Σ `credit_ledger.delta`, cached at `bal:{ws}`, rebuilt from the ledger on mismatch.
  Lots are consumed FIFO by `expires_at`.

**Prompts and versions (§9)**

- Every generation or edit creates a new immutable `agent_versions` row. Nothing is edited in place.
- Platform guardrails (§9.4) are appended to every prompt and cannot be removed by the customer.
  Feedback that conflicts with a guardrail returns `changes: []` plus an explanation.
- Numbers always run `latest_published`. Drafts are only reachable by passing an explicit
  `agent_version` to `create-web-call`.

**Configuration**

- Pricing, feature flags, kill switches, templates and the agent stack live in versioned tables and are
  read through `GET /pricing` and `GET /flags`. Never hard-code a price, rate, cap or model id.
- Publishing invalidates `pricing:current`, `flags:*` and `caps:{ws}`; the portal re-reads within 60 s.

**Tenancy and staff access**

- Every request carries `Authorization: Bearer <jwt>` and `X-Workspace-Id`. Middleware verifies the JWT
  against the JWKS for that route namespace, loads the membership, and attaches
  `ctx = {userId, workspaceId, role}`. Postgres RLS is the second guard, not the first.
- `/admin/*` accepts staff JWTs only. On boot, assert the staff issuer differs from the customer issuer.
  A staff JWT without `mfa: true` is rejected.
- Every customer-affecting staff write requires a reason code (admin Appendix B) and an audit row.
  Role limits are enforced server-side, never only in the UI.

**Secrets**

- Secrets manager only, nothing in the repo. SIP credentials are envelope-encrypted (AES-256-GCM with an
  env DEK in P1, KMS-wrapped in P2; the wrap/unwrap interface does not change).

## Redis keys

| Key               | Contents                                                                   |
| ----------------- | -------------------------------------------------------------------------- |
| `bal:{ws}`        | cached credit balance                                                      |
| `active:{ws}`     | active call counter, TTL = max duration + 5 min                            |
| `caps:{ws}`       | plan caps and grace, from the current pricing config plus tenant overrides |
| `num:{e164}`      | number → workspace, agent, tier, hours, transfer targets, paused flags     |
| `pricing:current` | current pricing config snapshot                                            |
| `flags:*`         | feature flags and kill switches                                            |

## API conventions (§16)

- Errors: `{code, message, fields?[]}`. Known codes include `402 NO_CREDITS`, `403 EMAIL_UNVERIFIED`,
  `429 TEST_RATE_LIMIT`.
- Pagination: `?cursor=&limit=`.
- Long operations return `202 {job_id}`; the client subscribes to SSE and falls back to
  `GET /jobs/:id` every 3 s.
- SSE topics: `wallet`, `agent:{id}`, `call:{id}`, `activation:{id}`.
- Webhook routes take no JWT: `/webhooks/retell`, `/webhooks/retell/inbound/:number_token`,
  `/webhooks/stripe`, `/webhooks/auth`.

## Data model index

Portal (§15): `users, tenants, memberships, invites, audit_log, notification_settings, templates,
agents, agent_versions, voices, knowledge_sources, phone_plans, phone_numbers, calls, credit_lots,
credit_ledger, purchases, packs, webhook_events, jobs, alerts`.

Admin (§8): `staff_users, staff_role_limits, pricing_drafts, pricing_configs, stripe_price_map,
promo_codes, custom_deals, tenant_overrides, agent_stack_configs, retell_cost_inputs,
credit_adjustments, refunds, support_tickets, ticket_messages, canned_responses, customer_notes,
customer_flags, impersonation_sessions, announcements, email_templates, feature_flags, kill_switches,
blocklists, fraud_reviews, data_requests, staff_audit_log`.

## External integrations

**Retell** (Appendix A): `list-voices`; `create-agent`, `update-agent`, `get-agent`, publish/version;
`create-retell-llm`, `update-retell-llm`; `create-knowledge-base` + sources; `create-phone-number`,
`import-phone-number`, `update-phone-number`, `delete-phone-number`, `list-phone-numbers`;
`v2/create-web-call`, `v2/create-phone-call`, `v2/get-call`, `v2/list-calls`, `delete-call`.
Events in: `call_started`, `call_ended`, `call_analyzed`, `transfer_*`, plus the per-number inbound webhook.

**Stripe**: Checkout Session, Customer Portal, `checkout.session.completed`,
`checkout.session.async_payment_succeeded`, `checkout.session.expired`, off-session PaymentIntent for
auto top-up, `charge.dispute.created`.

**Clerk**: two applications. `user.created` webhook → `POST /webhooks/auth` → upsert `users`.

Open questions to answer against Retell in P0 are §21; the answers land in
`docs/decisions/0002-retell-findings.md`.

## Business rules quick reference

Packs (§5.2): Starter $49 / 150 cr, Growth $149 / 500, Scale $399 / 1,500, Pro $999 / 4,500,
Volume custom / 10,000+. Concurrency caps 2 / 3 / 5 / 10 / negotiated. KB included 0 / 1 / 3 / 5 / negotiated.

Recurring (§5.3): number rental 15 credits/number/month on the purchase anniversary; extra KB 30
credits/month; BYO SIP numbers cost 0.

Wallet (§5.4): credits expire 12 months after purchase, FIFO, non-refundable. Low-balance alerts at
20%, 5% and 0 of the last pack size. Auto top-up is opt-in, default suggestion on at 10% of last pack.
Grace overdraft of 10 credits so a call is never cut mid-sentence. Free trial 20 credits, browser test
calls only, no card, no phone number before first purchase.

Roles (§6.1): owner, admin, editor, viewer; exactly one owner per workspace.
Staff roles (admin §2.2): super admin, ops, finance, support, read-only, with per-role limits stored in
`staff_role_limits` so they are tunable without a deploy.

## Open decisions (§20, §5.5, admin)

1. Working name and domain.
2. USD vs CAD; merchant of record (Metacognixion Canada vs Gritbyte India).
3. Standard-tier LLM: GPT-5 mini vs GPT-4.1 mini, after the P0 benchmark.
4. Launch countries for numbers: US + CA only, or include India.
5. Trial size (20 credits proposed) and whether a card is required at sign-up.
6. Credit expiry of 12 months against prepaid-credit consumer rules in target provinces and states.
7. ~~Auth provider and backend framework~~ — resolved: Clerk, NestJS. See ADR 0001.
8. Whether Starter allows exactly one agent and one number.
9. Whether the viewer role may download recordings (recommendation: no).
10. Support tooling (Intercom vs Crisp) and status page vendor.
11. Portfolio positioning under Metacognixion.

## Delivery schedule

One developer, AI-assisted. Day 0 is Fri 11 Sep 2026.

| Milestone                                                | Date          |
| -------------------------------------------------------- | ------------- |
| Bootstrap + monorepo scaffold                            | Fri 11 Sep    |
| Accounts, data layer, auth guards                        | Mon 14 Sep    |
| Retell + Stripe verified against real payloads (P0 exit) | Tue 15 Sep    |
| Backend P1 complete                                      | Tue 22 Sep    |
| Portal wizard + dashboard complete                       | Mon 28 Sep    |
| Admin P1 subset, P1 exit review                          | Wed 30 Sep    |
| Integration + security gate                              | Thu 1 Oct     |
| **MVP live with design partners**                        | **Fri 2 Oct** |
| **P2 complete, full scope**                              | **Fri 9 Oct** |

Day-by-day tasks: `docs/plan/tasks.csv`. One buffer day (1 Oct). If a day overruns, give back in this
order: fr-CA content → admin SA4/SA7/SA8/SA9 actions (keep read-only tables) → SIP option C →
knowledge W4 → auto top-up → team and invites.

## Working agreements

- Environments `dev`, `staging`, `prod`. Retell test agents are prefixed `dev-`. One Retell API key and
  one webhook URL set per environment. Stripe test and live keys never mix.
- Tests are required for metering, ledger idempotency, webhook exactly-once, inbound decline paths and
  RLS cross-tenant isolation. Other areas are best-effort.
- Conventional commits. Reference the spec section in the body.
- Update this file and add an ADR whenever a decision changes. Do not let CLAUDE.md drift from reality.
- Prefer editing the spec-derived schema in `shared/schemas` first, then the API, then the UI.
