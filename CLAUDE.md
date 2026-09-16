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
| 2    | System architecture, with diagrams and rationale  | `docs/architecture.md`                          |
| 3    | Code                                              | this repo                                       |

Greppable identifiers (routes, tables, columns, events, Redis keys) live in
`docs/spec-extract/*.txt` with a page-to-section index at the top. The PDF body copy is vector
outlines, so prose and diagrams must be read from the PDF itself. Cite spec sections as `§13.9`
(portal) or `admin §5.2` in commits, PRs and comments.

When the spec and the code disagree, the spec wins unless a decision in `docs/decisions/` overrides it.

## Glossary

- **Workspace** = tenant = one business. Table is `tenants`, and every foreign key to it is
  `tenant_id` (§15). The product and the HTTP surface say _workspace_ (`X-Workspace-Id`,
  `ctx.workspaceId`); the database says `tenant_id`. The translation happens once, in
  `WorkspaceGuard`. A **user** can belong to many workspaces via `memberships` with a role
  (owner / admin / editor / viewer). Everything billable belongs to the workspace, never the user.
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
  knowledge bases. Numbers are bound with `agent_version: "latest_published"` — unpinned, Retell
  runs `latest`, drafts included (ADR 0003 §7).
- **Screen IDs** — A1–A8 (auth), W1–W7b (wizard), D1–D8 (dashboard), SA1–SA14 (admin).

## Tech stack

| Layer          | Choice                                                                                                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Monorepo       | pnpm workspaces + Turborepo                                                                                                                                                                                                          |
| Portal & admin | Next.js App Router, TypeScript, Tailwind, shadcn/ui, TanStack Query, Zustand (ephemeral wizard UI only), React Hook Form + zod, next-intl (en, fr-CA), PostHog, `retell-client-js-sdk`                                               |
| SSE client     | `@microsoft/fetch-event-source` — `EventSource` cannot send `Authorization` or `X-Workspace-Id`                                                                                                                                      |
| API            | NestJS on the Fastify adapter, validation via `nestjs-zod` from `@portal/schemas`                                                                                                                                                    |
| Worker         | Same Nest codebase, separate entrypoint. BullMQ processors + Job Schedulers registered idempotently on boot                                                                                                                          |
| Database       | Postgres on Neon (7-day PITR, §17) + Prisma. RLS on `workspace_id`; two DB roles; append-only ledger                                                                                                                                 |
| Cache / queue  | Redis 7 as a Docker service on the backend EC2 instance (TCP, compose-internal). BullMQ, runtime cache, config cache, SSE pub/sub. **Not Upstash** — HTTP Redis cannot run BullMQ                                                    |
| Auth           | **Auth0, two separate tenants**: customers, and staff (Google Workspace domain + mandatory TOTP). ADR 0002                                                                                                                           |
| Payments       | Stripe Checkout (hosted) + Customer Portal + webhooks                                                                                                                                                                                |
| Voice          | Retell Node SDK behind a single `RetellGateway`                                                                                                                                                                                      |
| LLM            | Anthropic SDK, `claude-sonnet-5`, structured output. Brief → prompt only, **never in the call path**. ADR 0009                                                                                                                                    |
| Hosting        | **S3 (private) + CloudFront (OAC) + ACM** ×2 (portal, admin; Next.js static export, ADR 0008) + **AWS EC2** running api, worker, redis and Caddy via Docker Compose + Neon Postgres. Webhooks and SSE hit `api.<domain>` directly. ADR 0004 |
| Observability  | OpenTelemetry → Grafana Cloud, Sentry, Slack alerts                                                                                                                                                                                  |
| Storage        | Cloudflare R2 for exports. Recordings stay on Retell URLs, proxied with signed 1-hour URLs                                                                                                                                           |

Decisions live in `docs/decisions/`: 0001 tech stack, 0002 Auth0, 0003 Retell findings (§21 +
Redis-down), 0004 EC2, ~~0005 Amplify~~,
0006 tenancy (two DB roles, RLS, append-only), ~~0007 OpenAI~~, 0008 S3 + CloudFront (supersedes 0005),
0009 Anthropic `claude-sonnet-5` (supersedes 0007), 0010 wallet ledger semantics + pricing config shape +
Stripe webhook retries (D3; §5 amended by 0011), 0011 call runtime — `active:{ws}` reservations, the
BullMQ hand-off for both providers, the recording proxy (D4). Rejected and why, in `docs/decisions/0001-tech-stack.md`: plain Fastify (less ceremony but the spec
names NestJS), Drizzle (SQL-first migrations but the spec names Prisma), FastAPI (would fork the shared
zod schema layer), Next.js route handlers only (breaks SSE and BullMQ).

## Repo layout

Split by deploy target. `frontend/` ships as a static export to S3 + CloudFront, `backend/` ships to AWS EC2, `shared/` is
imported by both and never deployed on its own.

```
frontend/                         → S3 + CloudFront (static export, ADR 0008)
  web/            @portal/web         Next.js customer portal      app.<domain>
  admin/          @portal/admin       Next.js staff console        admin.<domain>
  ui/             @portal/ui          shadcn components + shared domain widgets
  api-client/     @portal/api-client  typed fetch wrapper + TanStack Query hooks
backend/                          → AWS EC2 (Docker Compose)
  api/            @portal/api         NestJS + Fastify. Two entrypoints: src/main.ts (HTTP, api.<domain>)
                                      and src/worker.ts (BullMQ processors + schedulers). One image, two compose services.
                                      src/common/* (error envelope, cursor pagination) and src/modules/auth
                                      are global and every feature module inherits them.
  db/             @portal/db          Prisma schema, the two role-scoped clients, withWorkspace(),
                                      migrations incl. hand-written RLS/grants/triggers, seed
shared/
  schemas/        @portal/schemas     zod request/response/SSE schemas, enums, error codes. Depends on zod only.
  config/         @portal/config      tsconfig bases, eslint, tailwind preset
templates/                        *.json agent templates (receptionist, appointment, afterhours, lead_qual, ...)
infra/                            Dockerfile (turbo prune), docker-compose.yml (local), docker-compose.prod.yml (EC2),
                                  auth0/, scripts/doctor.mjs (`pnpm doctor` — what is unset, what is reachable)
docs/                             specs, decisions, runbooks, spec-extract, plan, tools
```

The API and the worker import the same `backend/api/src/modules/*/service.ts`. Routes call services; job
processors call the same services.

Backend modules mirror §13.1: `auth, workspaces, agents, prompting, voices, knowledge, numbers, calls,
wallet, billing, webhooks, notifications, events, jobs, admin`, plus `config` (pricing/flags/caps),
`redis`, `retell`, `runtime-cache` (the Redis projection the inbound path reads) and `scheduled`.

Jobs: `modules/jobs` owns the BullMQ plumbing only — three queues (`webhooks`, `calls`, `scheduled`),
a handler registry every feature module registers into at module init, the worker runtime, and the
§13.11 schedulers. The API registers every handler and starts no Worker; `src/worker.ts` starts them.
Job ids are deterministic, which is the queue side of exactly-once — but `Queue.add()` cannot tell
a caller that an id was refused (BullMQ builds the returned Job locally), so `JobQueues.add(...,
verify)` reads the stored job back. `enqueueWebhook` verifies: an id held by a job that already
failed for good would otherwise swallow the sweeper's re-enqueue forever. Cache repairs
(`warm-workspace`, `refresh-number`) use `REPAIR_JOB_OPTIONS`, which frees the id as soon as the
job settles.

## Invariants — do not violate

**Retell isolation**

- Only `RetellGateway` imports the Retell SDK. It owns tier → model/voice mapping, webhook URL
  construction, and retry/backoff. Everything Retell actually does is in ADR 0003; when in doubt
  read the fixture in `backend/api/test/fixtures/retell/`, not the docs page.
- The webhook signature (`x-retell-signature`) is HMAC-SHA256 over the raw body **keyed with the
  API key**; there is no separate webhook secret. Verified through the gateway only.
- Retell is never named in customer-facing copy. Say "voice", not "TTS"; "what your agent knows",
  not "knowledge base".

**Webhooks (§13.10, §14.2)**

- Verify signature on the **raw body** (parser scoped to `/webhooks/*` only) → upsert `webhook_events`
  with unique `(provider, external_id, event_type)` → return 2xx fast → process in the queue.
- Duplicate of a *processed* event returns 204. Never return 5xx to a provider after the event is
  stored; retries are BullMQ's, eight attempts with exponential backoff (ADR 0011 §3). Both providers
  follow this rule since D4 — the D3 Stripe exception is gone. `WebhookEventsService.store()` still
  returns `retry` (not `duplicate`) for a stored but unprocessed event, and the `webhook-sweeper` job
  re-enqueues anything stored that never reached the queue.
- Retell's `external_id` is the `call_id`; a payload without one is deduped on a digest of its bytes.
  `transfer_*` and unknown types are stored, acknowledged and left for a later handler.
- Handle Stripe `checkout.session.completed` (credit only when `payment_status = paid`),
  `async_payment_succeeded`, `async_payment_failed` and `expired` (→ `abandoned`).

**Metering (§14) — the money rules**

- `call_ended` is the **only** event that moves credits. `call_analyzed` stores analysis and
  `retell_cost_cents` for COGS and **never bills**.
- `duration_s = (end_timestamp − start_timestamp)/1000`. If `disconnection_reason` indicates not
  connected (dial failed, no answer, busy) the charge is 0.
- `credits = duration_s/60 × rate(tier)` rounded to 0.01. Ledger debit is idempotent on `call_id`.
- `calls.rate` and `calls.config_version` are captured **once**, by whichever event creates the row
  (the inbound write-behind, `call_started`, or `call_ended` if it arrives first), and are never
  overwritten, so a mid-call price change cannot re-price a call in flight (ADR 0011 §4).
- Retell can deliver out of order: `call_ended` first finalises the row and the late `call_started`
  does not reopen it; `call_analyzed` first creates an **unbilled** row and leaves it unbilled.
- Every ledger write goes through the `wallet` module. No direct `credit_ledger` inserts anywhere else.

**Inbound call authorisation (§13.9) — p95 < 300 ms**

- `POST /webhooks/retell/inbound/:number_token`. Redis-only path; Retell times out at 10 s and retries 3×.
  Four keys, two round trips, one 150 ms budget. Measured p95 8.4 ms at 6 319 req/s (`test/load/inbound.k6.js`).
- Six ordered checks: workspace not paused → number not paused (or no live agent) → caller not in
  blocklist → balance > −grace → active calls < plan cap → hours rule. The SA12 `reject_inbound`
  kill switch declines before all of them. The checks are a pure function, `decide()` in
  `modules/calls/inbound.decide.ts`; the service only fetches and answers.
- `max_call_duration_ms = min(planMax, remainingCredits/rate × 60000)`, clamped to Retell's
  [60 s, 2 h]. "remainingCredits" is the balance **minus what the other live calls may still
  spend** — that is what `active:{ws}` holds per call (ADR 0011 §1).
- The SA12 veto is read from `kill:reject_inbound`, not from `flags:global`, for the same reason:
  a `flags:` key carries the 60 s config TTL against a 5-minute refresh, so it is absent for most
  of every cycle and a miss there reads as "switch off" — a kill switch that silently never fires.
  `PlatformConfigService.setKillSwitch()` republishes it on every flip; `runtime-cache-refresh`
  keeps it alive.
- `decide()` and `reserve.script.ts` both exclude the call's **own** `active:{ws}` entry. Retell
  re-sends `call_inbound` with the same `call_id` up to three times, so a retry meets its own
  reservation; counted, it is a busy tone for the caller whose slot is being held for them.
- Both halves of that formula come from `num:{e164}`: `plan_max_ms` and `rate_per_min`. The rate is
  deliberately **not** read from `pricing:current` on this path — that key carries the 60 s config
  TTL while `runtime-cache-refresh` runs every five minutes, so it is absent for most of every
  cycle, and a decision without a rate reserves nothing and lets concurrent calls overrun the
  grace. A stale rate here can misprice nothing: it only sizes a ceiling, and `calls.rate` is
  captured by the worker from the live config.
- Check-and-reserve is atomic: the slot is written by a Lua script that re-checks the cap and the
  balance ceiling as it writes, so two calls racing cannot both take the last slot or the last
  credits (ADR 0011 §1). A lost race is an ordinary `cap`/`balance` decline.
- A number we cannot identify — no `to_number`, no `num:{e164}`, a token that does not match, or a
  signature that does not verify — is a fail-open (`200 {}`), never a 4xx: Retell would retry three
  times and answer with the bound agent anyway (ADR 0011 §2).
- Allow = `RetellGateway.inboundAllow()`; decline = `RetellGateway.inboundDecline()`, which is
  HTTP 200 `{call_inbound:{reject:true}}` (busy tone, no call object, no cost). A 4xx/5xx is
  **not** a decline: Retell retries 3× then answers with the bound agent (ADR 0003 §1).
- Both the allowed and declined paths write a `calls` row **via an enqueued job**, never inline.
  Declined rows carry `decline_reason ∈ {balance, cap, blocked, hours, paused}` and show as "Missed".
  The one exception is an allow with no `call_id`: `call_started` owns that row, and a synthetic id
  here would be a phantom `registered` call beside the real one.
- `runtime-cache.refresh(workspaceId)` must be called from every mutating path: pause/resume, plan
  change, number change, publish, ledger write. Plus the 5-minute `runtime-cache-refresh` schedule
  and a full warm-up on worker boot. It is the only writer of `num:{e164}`.
- Redis down = **fail open, fast and bounded** (ADR 0003 §12): 150 ms Redis budget, then answer
  200 `{}` immediately (never 5xx, never `reject`), alert, and let `call_ended` bill as usual.
  `INBOUND_REDIS_DOWN_POLICY=closed` flips it to `reject` for an operator. Do not reinvent this.
- A call let through by any fail-open carries **no metadata**, so the lifecycle handlers resolve the
  workspace from `metadata.tenant_id`, then the Retell agent, then the number it was dialled on.
  Without that fallback `call_ended` cannot bill it and the call is free and invisible (ADR 0011 §2).
- A reservation in `active:{ws}` is sized to what the call can actually spend — min(the agent's
  `max_call_duration_s`, the wallet after the other live calls) — never Retell's 2 h ceiling, which
  would decline other callers on `balance` while the credits are still there (ADR 0011 §1).

**Append-only tables**

- `credit_ledger`, `audit_log`, `staff_audit_log`. Enforced twice: `REVOKE UPDATE, DELETE` from the app
  role, **and** a `BEFORE UPDATE OR DELETE … RAISE EXCEPTION` trigger so even a BYPASSRLS connection
  cannot rewrite history. Reversals are new negative rows.
- Consequence: a workspace with ledger history cannot be hard-deleted — the cascade hits the trigger.
  The §17 delete request is an anonymisation job, not a `DELETE`. `TRUNCATE` is deliberately not
  covered by the trigger, so a local `pnpm db:reset` still works.
- A partial unique index on `credit_ledger (ref_id) WHERE reason = 'call'` is the idempotency guard:
  a replayed `call_ended` collides instead of double-billing.
- Balance = Σ `credit_ledger.delta`, cached at `bal:{ws}` with a 1-hour TTL, rebuilt from the ledger
  on a miss or mismatch. Lots are consumed FIFO by `expires_at`. One ledger row per movement even
  when it spans lots; an overdraft leaves lots at 0 and the balance negative, and the next grant's lot
  is created short by that amount (ADR 0010). Every wallet write runs under a per-workspace advisory
  lock via `WalletService.withWallet()`; billing marks a purchase paid and grants inside the same lock.
- A lapsed lot is swept into an `expiry` row at the top of every grant and debit, not only by the
  §13.11 job — FIFO skips expired lots, so a debit taken before the sweep would otherwise be charged
  twice. `bal:{ws}` is published inside the wallet transaction while the lock is still held, which is
  what keeps the cache in commit order; it is the one piece of I/O allowed in there (ADR 0010 §3).
  Readers obey the same order: `rebuildBalance()` takes the wallet lock, and `summary()` only fills a
  miss with `SET NX`. Nothing else writes `bal:{ws}`.
- Stripe fulfilment credits nothing unless `amount_total` and `currency` match the pending purchase.
  A mismatch leaves the purchase `pending` for SA9 and answers 200 (ADR 0010 §5).

**Prompts and versions (§9)**

- Every generation or edit creates a new immutable `agent_versions` row. Nothing is edited in place.
- Platform guardrails (§9.4) are appended to every prompt and cannot be removed by the customer.
  Feedback that conflicts with a guardrail returns `changes: []` plus an explanation.
- Numbers always run `latest_published`. Drafts are only reachable by passing an explicit
  `agent_version` to `create-web-call`.
- Retell versions are immutable once published (`update-agent` → 422). Edit flow is
  `create-agent-version(base)` → `update-agent` / `update-retell-llm` → `publish-agent-version`;
  roll back = new version from the old base, then publish (ADR 0003 §7).

**Configuration**

- Pricing, feature flags, kill switches, templates and the agent stack live in versioned tables and are
  read through `GET /pricing` and `GET /flags`. Never hard-code a price, rate, cap or model id.
  The `pricing_configs.config_json` shape is `pricingConfig` in `shared/schemas/src/pricing.ts`;
  read it through `PlatformConfigService` (`modules/config`), which caches in Redis with a 60 s TTL.
  Version 1 comes from `pnpm db:seed` (`backend/db/prisma/seed-data/pricing-v1.ts`), only into an
  empty table.
- Publishing invalidates `pricing:current`, `flags:*` and `caps:{ws}`; the portal re-reads within 60 s.
  Kill switch keys: `reject_inbound`, `pause_web_tests`, `pause_purchases`, `pause_generation`.

**Tenancy and staff access** (ADR 0006)

- Every request carries `Authorization: Bearer <jwt>` and `X-Workspace-Id`. Middleware verifies the JWT
  against the JWKS for that route namespace, loads the membership, and attaches
  `ctx = {userId, workspaceId, role}`. Postgres RLS is the second guard, not the first.
- **There are exactly two ways to reach Postgres.** `withWorkspace(ctx.workspaceId, db => …)` on the
  customer request path, and `adminDb` for work that legitimately crosses workspaces — webhooks (the
  workspace is only known after the payload is parsed), scheduled jobs, workspace creation, `/admin/*`.
  A query outside both sees an empty database, because `app.tenant_id` is unset and every policy
  compares against NULL. That is the intended failure mode.
- **No network I/O inside `withWorkspace`.** The callback runs in an interactive transaction
  holding a pooled connection for its whole duration, and the pool is `num_cpus × 2 + 1`.
  Read → close → call Anthropic / Retell / Stripe → reopen to write. A handler that awaits a
  generation inside the callback exhausts the pool at ~6 concurrent users at 3% CPU. The
  5 s default timeout turns that into a loud `P2024` in dev rather than a stall under load.
- Three connection strings, two roles: `DATABASE_URL` (portal_app, RLS enforced),
  `ADMIN_DATABASE_URL` (portal_admin, crosses workspaces), `DIRECT_DATABASE_URL` (owner, migrations
  only). `assertRlsEnforced()` runs before the API or worker binds anything and refuses to start if
  `DATABASE_URL` is a superuser, a table owner, or not a portal_app member.
- Routes are authenticated by default. `@Public()` opts out, `@NoWorkspace()` skips the workspace
  lookup, `@Roles(...)` and `@StaffRoles(...)` enforce the §6.1 and admin §2.2 matrices.
- Auth namespace is chosen by the route path, never by the token: `/admin/*` is verified against the
  staff JWKS only, so a customer token fails on `iss` and never reaches a staff handler.
- `/admin/*` accepts staff JWTs only. On boot, assert the staff issuer differs from the customer issuer.
  A staff JWT without the `https://portal/mfa` claim is rejected.
- Every customer-affecting staff write requires a reason code (admin Appendix B) and an audit row.
  Role limits are enforced server-side, never only in the UI.

**Secrets**

- AWS SSM Parameter Store only, nothing in the repo. SIP credentials are envelope-encrypted with an AWS KMS
  data key (AES-256-GCM).

## Redis keys

| Key               | Contents                                                                   |
| ----------------- | -------------------------------------------------------------------------- |
| `bal:{ws}`        | cached credit balance, 1-hour TTL                                          |
| `active:{ws}`     | **hash** of live calls: `call_id → "<reserved credits>\|<expires at ms>"`, key TTL = max duration + 5 min (ADR 0011 §1) |
| `events:{ws}`     | pub/sub channel carrying that workspace's SSE frames (PUBLISH only, never a key) |
| `caps:{ws}`       | plan caps and grace, from the current pricing config plus tenant overrides |
| `num:{e164}`      | number → workspace, agent, tier, **rate**, plan max, hours, transfer targets, paused flags |
| `pricing:current` | current pricing config snapshot                                            |
| `flags:global`    | feature_flags + kill_switches rows                                         |
| `flags:{ws}`      | `GET /flags` resolved for one workspace                                    |
| `kill:reject_inbound` | the SA12 veto, `'1'`/`'0'`, for the hot path — outside `flags:` and its 60 s TTL |

Keys are built only in `modules/redis/redis.keys.ts`. Cache reads go through `RedisCache`, which never
throws and never waits past its budget (ADR 0010 §6).

## API conventions (§16)

- Errors: `{code, message, fields?[]}`. Known codes include `402 NO_CREDITS`, `403 EMAIL_UNVERIFIED`,
  `429 TEST_RATE_LIMIT`.
- Pagination: `?cursor=&limit=`.
- Long operations return `202 {job_id}`; the client subscribes to SSE and falls back to
  `GET /jobs/:id` every 3 s.
- SSE topics: `wallet`, `agent:{id}`, `call:{id}`, `activation:{id}`. `GET /events` is an ordinary
  authenticated route (the client is `@microsoft/fetch-event-source`), narrowed with `?topics=`, and
  only ever carries `ctx.workspaceId`'s own channel.
- Recordings: `GET /calls/:id/recording` mints a signed one-hour link to
  `GET /calls/:id/recording/stream?token=`, which is `@Public()` and proxies the bytes. The Retell
  URL is never given to the browser (ADR 0011 §5).
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

**Auth0**: two tenants, both **Single Page Application** type. Post-User-Registration Action → `POST /webhooks/auth` (shared-secret header) → upsert `users`. Post-Login Action adds namespaced claims `https://portal/email_verified` and `https://portal/mfa`. Frontend uses `@auth0/auth0-spa-js` (Authorization Code + PKCE — no client secret in the browser, ADR 0008); Actions source lives in `infra/auth0/actions/`.

§21 is answered in `docs/decisions/0003-retell-findings.md` (15 Sep 2026), with fixtures. One Retell
workspace per environment, never per tenant. Post-call analysis is a flat per-call charge, so
`post_call_analysis_model` is part of the tier stack. Retell's website widget is not used (§11.5 is ours).

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

## Getting a working machine

```sh
pnpm install
pnpm infra:up          # local Postgres + Redis
pnpm db:roles          # local portal_app / portal_admin login roles (dev only)
pnpm db:deploy         # migrations, incl. RLS, grants and the append-only triggers
pnpm db:seed           # staff_role_limits (admin §2.2), packs (§5.2)
pnpm doctor            # which env vars are unset, what is reachable
```

External accounts and staging infrastructure: `docs/runbooks/provisioning.md`.

## Open decisions (§20, §5.5, admin)

1. Working name and domain.
2. USD vs CAD; merchant of record (Metacognixion Canada vs Gritbyte India).
3. Standard-tier LLM: GPT-5 mini vs GPT-4.1 mini, after the P0 benchmark.
4. Launch countries for numbers: US + CA only, or include India.
5. Trial size (20 credits proposed) and whether a card is required at sign-up.
6. Credit expiry of 12 months against prepaid-credit consumer rules in target provinces and states.
7. ~~Auth provider and backend framework~~ — resolved: Auth0 (ADR 0002), NestJS (ADR 0001).
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
- The §13.9 latency SLO is asserted, not eyeballed: `pnpm --filter @portal/api load:setup` then
  `load:inbound` runs k6 with `p(95)<300` as a threshold, so the run exits non-zero if it regresses.
  `load:reset` frees the slots a previous run reserved; `load:teardown` pauses the number afterwards.
- `pnpm test` is unit-only and needs nothing running. `pnpm test:e2e` needs Postgres **and Redis** and
  covers the parts that cannot be mocked: RLS isolation, the append-only triggers, the auth
  boundaries, the wallet (FIFO, overdraft, idempotent call debit, `bal:{ws}` rebuild) and the Stripe
  webhook path with real signatures (`backend/db/test/*`, `backend/api/test/*`). Start with
  `pnpm infra:up && pnpm db:roles && pnpm db:deploy && pnpm db:seed`; `pnpm doctor` says what is
  still missing.
- Conventional commits. Reference the spec section in the body.
- Update this file and add an ADR whenever a decision changes. Do not let CLAUDE.md drift from reality.
- Prefer editing the spec-derived schema in `shared/schemas` first, then the API, then the UI.
