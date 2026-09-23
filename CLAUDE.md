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

| Layer          | Choice                                                                                                                                                                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo       | pnpm workspaces + Turborepo                                                                                                                                                                                                                                                     |
| Portal & admin | Next.js App Router, TypeScript, Tailwind, shadcn/ui, TanStack Query, Zustand (ephemeral wizard UI only), React Hook Form + zod, next-intl (en, fr-CA), PostHog, `retell-client-js-sdk`                                                                                          |
| SSE client     | `@microsoft/fetch-event-source` — `EventSource` cannot send `Authorization` or `X-Workspace-Id`                                                                                                                                                                                 |
| API            | NestJS on the Fastify adapter, validation via `nestjs-zod` from `@portal/schemas`                                                                                                                                                                                               |
| Worker         | Same Nest codebase, separate entrypoint. BullMQ processors + Job Schedulers registered idempotently on boot                                                                                                                                                                     |
| Database       | Postgres on **Amazon RDS**, private in the VPC (7-day PITR, §17, ADR 0016) + Prisma. RLS on `workspace_id`; two DB roles; append-only ledger                                                                                                                                    |
| Cache / queue  | Redis 7 as a Docker service on the backend EC2 instance (TCP, compose-internal). BullMQ, runtime cache, config cache, SSE pub/sub. **Not Upstash** — HTTP Redis cannot run BullMQ                                                                                               |
| Auth           | **Auth0, two separate tenants**: customers, and staff (Google Workspace domain + mandatory TOTP). ADR 0002                                                                                                                                                                      |
| Payments       | Stripe Checkout (hosted) + Customer Portal + webhooks                                                                                                                                                                                                                           |
| Voice          | Retell Node SDK behind a single `RetellGateway`                                                                                                                                                                                                                                 |
| LLM            | Anthropic SDK, `claude-sonnet-5`, structured output. Brief → prompt only, **never in the call path**. ADR 0009                                                                                                                                                                  |
| Hosting        | **S3 (private) + CloudFront (OAC) + ACM** ×2 (portal, admin; Next.js static export, ADR 0008) + **AWS EC2** running api, worker, redis and Caddy via Docker Compose + private RDS Postgres in the same stack (ADR 0016). Webhooks and SSE hit `api.<domain>` directly. ADR 0004 |
| Observability  | OpenTelemetry → Grafana Cloud, Sentry, Slack alerts                                                                                                                                                                                                                             |
| Storage        | Cloudflare R2 for exports. Recordings stay on Retell URLs, proxied with signed 1-hour URLs                                                                                                                                                                                      |

Decisions live in `docs/decisions/`: 0001 tech stack, 0002 Auth0, 0003 Retell findings (§21 +
Redis-down), 0004 EC2, ~~0005 Amplify~~,
0006 tenancy (two DB roles, RLS, append-only), ~~0007 OpenAI~~, 0008 S3 + CloudFront (supersedes 0005),
0009 Anthropic `claude-sonnet-5` (supersedes 0007), 0010 wallet ledger semantics + pricing config shape +
Stripe webhook retries (D3; §5 amended by 0011), 0011 call runtime — `active:{ws}` reservations, the
BullMQ hand-off for both providers, the recording proxy (D4), 0012 prompting pipeline and
agent lifecycle — guardrails appended after zod, the version-immutability trigger, the
publish lease, the `prompting` queue (D5), 0013 knowledge, numbers, activation and billing —
the `jobs`-row step machine, look-before-you-buy idempotency, the `provisioning` queue, SIP
envelope encryption, auto top-up credited only from Stripe's confirmation (D6), 0014 recurring
operations — schedule locks, rental as a ledger row per period, keyed alert state, the
notifications outbox, the hourly per-timezone digest, reconciliation runs, the manifest-driven
OpenAPI contract and the EC2 compose stack with the worker CPU cap (D7), 0015 the domain
(oraly.ai) and the AWS backend stack as one CloudFormation template — secrets reach SSM only
through `infra/scripts/ssm-put-env.sh` from a file outside the repo, no SSH, Session Manager
and Run Command only, 0016 Postgres on RDS, 0017 the portal foundation — the SPA session,
§6.4 gating as one pure gate plus guards, theme tokens, `/invite/?token=`, SSE and polling
together, the local stand-in issuer and the wizard end-to-end script (D8). Rejected and why, in `docs/decisions/0001-tech-stack.md`: plain Fastify (less ceremony but the spec
names NestJS), Drizzle (SQL-first migrations but the spec names Prisma), FastAPI (would fork the shared
zod schema layer), Next.js route handlers only (breaks SSE and BullMQ).

## Repo layout

Split by deploy target. `frontend/` ships as a static export to S3 + CloudFront, `backend/` ships to AWS EC2, `shared/` is
imported by both and never deployed on its own.

```
frontend/                         → S3 + CloudFront (static export, ADR 0008)
  web/            @portal/web         Next.js customer portal      app.<domain>
                                      app/ = routes (A1–A8, onboarding/W1–W7, app/D1–D7); src/ = auth, guards,
                                      workspace, wizard hooks, shell + wizard components, i18n, analytics;
                                      scripts/ = serve-export, e2e-wizard (D8 exit check)
  admin/          @portal/admin       Next.js staff console        admin.<domain>
  ui/             @portal/ui          shadcn components + shared domain widgets
  api-client/     @portal/api-client  typed fetch wrapper + TanStack Query hooks
backend/                          → AWS EC2 (Docker Compose)
  api/            @portal/api         NestJS + Fastify. Two entrypoints: src/main.ts (HTTP, api.<domain>)
                                      and src/worker.ts (BullMQ processors + schedulers). One image, two compose services.
                                      src/common/* (error envelope, cursor pagination, withTimeout — the one
                                      bounded-await used by RedisCache, the readiness probes and the email
                                      sender) and src/modules/auth are global and every feature module inherits them.
  db/             @portal/db          Prisma schema, the two role-scoped clients, withWorkspace(),
                                      migrations incl. hand-written RLS/grants/triggers, seed
shared/
  schemas/        @portal/schemas     zod request/response/SSE schemas, enums, error codes. Depends on zod only.
  config/         @portal/config      tsconfig bases, eslint, tailwind preset
templates/                        *.json agent templates (receptionist, appointment, afterhours, lead_qual,
                                  faq_support, restaurant, custom). The files are the source; `pnpm db:seed`
                                  loads them into `templates`, the table wins at runtime when it has the row,
                                  and both paths go through one loader — `templatesDir` / `readTemplateFiles` /
                                  `templateRowFrom` / `templateFromRow` in `@portal/db` — so the seed and the
                                  API cannot resolve different directories or accept different shapes. A file
                                  that fails the zod schema fails the seed
infra/                            Dockerfile (turbo prune), docker-compose.yml (local), docker-compose.prod.yml (EC2),
                                  aws/backend-stack.yaml (the per-environment AWS stack, ADR 0015),
                                  aws/frontend-stack.yaml (S3 + CloudFront per app, ADR 0008/0017), auth0/,
                                  scripts/local-issuer.mjs (`pnpm dev:issuer`, a stand-in OIDC issuer for dev),
                                  scripts/deploy-frontend.sh (build + two-pass s3 sync + invalidation),
                                  scripts/doctor.mjs (`pnpm doctor` — what is unset, what is reachable),
                                  scripts/{deploy,instance-bootstrap,ssm-put-env,db-env-roles}.sh
docs/                             specs, decisions, runbooks, spec-extract, plan, tools
```

The API and the worker import the same `backend/api/src/modules/*/service.ts`. Routes call services; job
processors call the same services.

Backend modules mirror §13.1: `auth, workspaces, agents, prompting, voices, knowledge, numbers, calls,
wallet, billing, webhooks, notifications, events, jobs, admin`, plus `config` (pricing/flags/caps),
`redis`, `retell`, `runtime-cache` (the Redis projection the inbound path reads), `scheduled`,
and since D6 `activation` (§13.8), `crypto` (envelope encryption, global) and `alerts` (ops
alerts, global); since D7 `notifications` (§13.1: the outbox, the email sender, the customer
alert state in `alerts`, low-balance alerts, the daily digest, `GET /alerts/active`) and
`openapi` (the route manifest and the generator — not a Nest module). The arrows run one way: `prompting` → `agents` → `retell`;
`activation` → `agents` + `numbers` + `billing`; nothing depends on `activation`. Billing does
not import activation — `BillingService.onPurchaseCredited` announces and the activation
module listens. The agent stack (§9.3–§9.5 configuration) lives in `agents` because publish
needs it too, which is what saves both modules from a `forwardRef`.

Jobs: `modules/jobs` owns the BullMQ plumbing — five queues (`webhooks`, `calls`, `prompting`,
`provisioning`, `scheduled`), a handler registry every feature module registers into at module init, the worker
runtime, the §13.11 schedulers (plus `job-sweeper`, which writes off `jobs` rows whose queue
job is gone) — plus the `jobs` table behind `202 {job_id}` and `GET /jobs/:id` (§16). Twelve
of the thirteen schedules are live since D7 (`kb-sync` is the skeleton); each is upserted by
id on worker boot, strangers are removed, and **every tick runs under
`lock:schedule:{name}`** — a tick that outlives its interval is skipped on the second worker,
not run twice (ADR 0014 §1). The lock waits 2 s for Redis, and the third consecutive skip
of one schedule (held lock or Redis silent) raises a `schedule_skipped` ops alert: BullMQ
records a skip as a successful job, so nothing else would notice every §13.11 job quietly
doing nothing. Bodies live with the module that owns the data; `scheduled` is dispatch. `prompting` is separate because a job on it is an LLM round trip, and a slow model must never
delay a `calls` write-behind or a webhook that moves credits (ADR 0012 §6). `provisioning`
carries `knowledge-sync`, `provision-number` and `activate-agent` — several voice-platform
round trips each — for the same reason (ADR 0013 §4). The API registers every handler and starts no Worker; `src/worker.ts` starts them.
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
  not "knowledge base". **Audio and URLs count as copy**: the catalogue's own preview clips say
  the vendor's name aloud and are served from its bucket, so `VOICE_VENDOR_SAMPLES` withholds
  both (`deny` is the default under `APP_ENV=prod`). `voices.sample_url`, a clip of ours, is
  played whatever the switch says and the daily `voice-cache` job never writes it. There is no
  text-to-speech route to make one with (ADR 0003 §9 + the D8 addendum).

**Webhooks (§13.10, §14.2)**

- Verify signature on the **raw body** (parser scoped to `/webhooks/*` only) → upsert `webhook_events`
  with unique `(provider, external_id, event_type)` → return 2xx fast → process in the queue.
- Duplicate of a _processed_ event returns 204. Never return 5xx to a provider after the event is
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
- `agents` are soft-deleted the same way and for the same reason: `calls` reference them and calls
  are billing history, so `DELETE /agents/:id` sets `deleted_at`, destroys the Retell objects, and
  refuses while a phone number still points at the agent. Every customer read filters on it.
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

- Every generation or edit creates a new immutable `agent_versions` row. Nothing is edited in place,
  with one carve-out the spec asks for: the W2 autosave writes the brief into _the newest,
  unpublished_ version. Published, or overtaken by a newer version, and it is frozen — enforced by
  the `agent_versions_immutable` trigger, not by the service, so a mistake fails loudly instead of
  rewriting history. Only `published_at`, `retell_agent_version`, `lint_json` and `stack_version`
  stay writable; rows are never deleted or renumbered (ADR 0012 §2).
- Platform guardrails (§9.4) are appended **in code, after the zod parse**, by
  `modules/prompting/guardrails.ts` — never asked of the model, never removable by a request.
  `applyGuardrails` strips whatever block the submitted text contains and appends the canonical
  one, and is idempotent, so publish re-applies it for free. There is no request shape through
  which a customer can edit, replace or delete them. Feedback that conflicts with a guardrail
  returns `changes: []` plus an explanation, and the _stored_ prompt is the one they already had.
- Nothing the model returns is trusted: `generatedPrompt` / `generatedPatch` in `@portal/schemas`
  are the gate, and there is no path from provider output to `agent_versions` that skips it.
  The provider sits behind `PromptProvider` (ADR 0009); `GENERATION_PROVIDER=scripted` answers
  from canned text for tests and a keyless dev box, and is refused when `APP_ENV=prod`.
- `POST /agents/:id/generate` and `/feedback` return `202 {job_id}` and never wait for the model.
  One active job per (agent, type), enforced by a partial unique index on `jobs`.
- **Generation latency is output length**, measured stage by stage on 21 Sep 2026 (ADR 0012,
  "Measured again"): everything that is ours is ~60 ms, the model streams at ≈ 100 tokens/s,
  thinking is 0 ms. The worker records `queue_latency_ms`, `context_ms`, `provider_ttft_ms`,
  `provider_latency_ms`, `postprocess_ms`, `db_ms`, `sse_ms`, `retell_sync_ms`, `total_ms`,
  `usage` and `output_chars` in `steps_json`; `bench:generation` (`--split`, `--thinking`,
  `--out`) is how a change here is judged. Ask the model only for what the worker keeps
  (analysis fields are _additions_ — the template's are merged in code), publish the
  `generated` frame before the Retell draft sync, and `generation_progress` at the first
  token. p95 is 15.5 s against the 10 s exit check; the remaining options are the owner's.
- Publishing takes the `agents.publishing_since` lease, re-reads the state under it, and is
  idempotent; it does **not** un-pause a paused agent (ADR 0012 §3–§4). The lease is a
  **token**: `claimLease()` returns the timestamp it wrote and `releaseLease()` clears the
  column only if it still holds that value, so a publish that overran the two minutes
  cannot clear the lease a later publisher legitimately took over.
- **Tier, voice, languages, duration ceiling and recording travel with the version**
  (`agent_versions.settings_json`, `agentSettings` in `@portal/schemas`). The columns on
  `agents` (`tier`, `voice_id`, `max_call_duration_s`, …) are the **live** copy — the billing
  rate (`calls.rate` derives from `agents.tier`), `num:{e164}` and the inbound checks read
  them — and **only a publish writes them**, in the same transaction as
  `published_version`, followed by `runtime-cache.refresh`. `PATCH /agents/:id/draft`
  writes settings into the draft version (forking if it is frozen) and never onto the live
  row; the one live field it touches is `name`, and that refreshes the cache too. A draft
  Premium→Standard flip therefore changes nothing a caller or the wallet sees until it is
  published. Generation and the Retell draft sync use the _version's_ settings.
- `GET /jobs/:id` returns an explicit whitelist (`jobProgress`), never `steps_json` or
  `jobs.error`. Those name the provider, the model and the Retell sync and stay server-side;
  the customer-facing failure text is `steps_json.customer_reason`, written by the worker.
  `retell_agent_version` is not on any wire schema, and `DELETE /agents/:id` answers
  `{deleted}` only — Retell cleanup errors are audited, not returned.
- A paused workspace (`tenants.paused_at`) is refused by generate, feedback **and** publish,
  and again by the worker for a job queued a moment before the pause. No provider round
  trip happens for a paused tenant.
- **Dead jobs are reconciled, never abandoned.** A `jobs` row left `queued`/`running` by a
  process death would otherwise be joined forever through `jobs_one_active_per_target_idx`.
  `JobRecordsService.reconcileStale()` (the `job-sweeper` schedule, every 60 s) and
  `reconcileIfLost()` (the join path in `PromptingService`) ask BullMQ what holds the
  deterministic id and write the row off — with `customer_reason` and a `generation_failed`
  frame — **only** when the queue says `missing`, `failed` or `completed`. A job that is
  `waiting`, `delayed` or `active` is left alone however old the row looks, and `unknown`
  (Redis did not answer) is never treated as dead.
- Numbers always run `latest_published`. Drafts are only reachable by passing an explicit
  `agent_version` to `create-web-call`.
- Retell versions are immutable once published (`update-agent` → 422). Edit flow is
  `create-agent-version(base)` → `update-retell-llm` → `update-agent` → `publish-agent-version`;
  roll back = new version from the old base, then publish (ADR 0003 §7). **The branch comes
  first**: the LLM is versioned with the agent, so while the latest version is published
  `update-retell-llm` answers 400 `Cannot update published LLM`. Verified live, 17 Sep —
  `pnpm --filter @portal/api verify:d5-retell`.
- **`language: "multi"` means Retell's fixed ten, not the customer's languages**, and fr-CA
  is not among them. The gateway sends the explicit locale array instead — §W3's text says
  `multi`, and ADR 0003 §6 is the decision that overrides it (reviewed 21 Sep 2026; a
  one-line flip in `AgentRetellService.agentSpec` if the spec owner rules otherwise). Agent
  locales are `retellLanguage` in `@portal/schemas` (validated, not cast); there is no `en-CA`.
- An unknown `voice_model` is **ignored silently** by Retell where every other stack id is a
  400, so `tierStack.voice_model` is validated against the SDK union in code.

**Knowledge, numbers and activation (§11, §13.8, W4 — ADR 0013)**

- **Activation is a step machine on the `jobs` row** (`type = activate-agent`,
  `steps_json.steps.{publish,provision,bind,mark_live,notify}`), never one transaction:
  `publish → provision → bind → mark_live → notify`. The worker resumes at the first step
  not `completed`/`skipped` and persists each outcome before the next call. **Only
  `mark_live` writes `agents.status`, and only after `bind` completed.** A republish of an
  agent that already has an active number skips `provision` and `bind`. Three attempts, and
  only for `classifyError()` retryable failures (platform 5xx/429/408/409, network, Postgres);
  a 4xx, a lint failure, no plan, no paid purchase or a plan limit ends on attempt one. The
  final failure marks the number row `failed`, sends one `activation:{id}` `failed` frame and
  one `activation_failed` ops alert. The state → view mapping is pure (`activation-state.ts`).
- **Look before you buy.** The platform has no idempotency keys, so every retry looks up what
  a dead run may have created: a bought number by its nickname `num-<20 hex of its id>`, a SIP
  import by its E.164, a knowledge base by its name `kb-<20 hex of the agent id>` (Retell caps
  names at 40 chars; plus a Redis lock per
  agent around the create), a source by the row id embedded in its title/filename or by URL.
  The platform's answer is persisted before the next call. The row for a resource is created
  _before_ the provider call (`phone_numbers.plan_id` is unique — one number per plan).
- `phone_numbers.e164` is **nullable** until the platform answers; anything keyed on it
  (`num:{e164}`) skips a row without one. `NumberProvisioningService.{provision,bind,release}`
  are the only code that changes a platform number, and `bind` is read-compare-update.
  DELETE releases on the platform **first** and keeps the row as `released` (calls reference
  it). PATCH edits routing and labels only; provider identity is not on the request shape.
- Option B (forwarding) is a bought number plus `forwarding_status = waiting_for_customer`
  until the customer confirms; the agent is live on the new number regardless. Option D
  (porting) is refused (P3).
- **SIP passwords are envelope-encrypted** (`modules/crypto`): fresh AES-256-GCM data key per
  secret, wrapped by KMS (`SIP_CREDENTIALS_KMS_KEY_ID`) in staging/prod or a local key
  (`SIP_CREDENTIALS_LOCAL_KEY`, refused in prod) in dev/test; the plan id is the AAD. Two call
  sites only: `PhonePlansService`/`NumbersService.import` seal, `importSip` opens on the stack
  immediately before `import-phone-number`. Nothing returns, logs or audits the plaintext;
  responses carry `has_password`.
- Knowledge: one platform KB per agent (`agents.retell_kb_id`), `knowledge_sources.status ∈
{pending, syncing, ready, failed, deleting}`, file/text bytes held in `payload` only until
  ingested. Gated by `knowledge_base` and `caps.kb_allowance` (one KB per agent counts), ≤ 20
  sources per agent, files ≤ 20 MB, private hosts refused. A source that synced is deleted on
  the platform **before** its row (`deleting` + the `-del` job id). A KB added after publish
  reaches the LLM at the next publish (the LLM is versioned with the agent, ADR 0003 §7).
- **Auto top-up (§5.4) credits nothing on the create call.** `AutoTopupService.evaluate`
  (every debit + the 15-minute `auto-topup` schedule) creates the pending purchase under the
  wallet lock (no second charge while one is pending for 30 min, none for 6 h after a decline),
  creates the off-session PaymentIntent with `idempotencyKey = topup-<purchase id>`, and
  grants only in `fulfilPaymentIntent` — from `payment_intent.succeeded` or from the schedule
  retrieving the intent — under the lock, when the purchase is still `pending` and the amount
  matches. Checkout PaymentIntents (no `kind: auto_topup`) are ignored there. `invoices` mirror
  Stripe with a monotonic status; `POST /wallet/portal-session` reads the customer id from the
  workspace row only.
- Ops alerts go through `OpsAlertService` (log line always, `OPS_ALERT_WEBHOOK_URL` when set);
  every field is redacted for secret-looking names and values.
- **`PORTAL_URL` is read in one place**, `portalUrl()` in `src/common/env` (normalised, no
  trailing slash). Every customer link and Stripe return URL comes from it; the localhost
  fallback exists for dev, ci and tests only, and `assertPortalUrl()` refuses to boot the
  API or the worker in staging/prod without a public origin. No `process.env.PORTAL_URL ??`
  anywhere else.

**Recurring operations and notifications (§5.3, §5.4, §13.11, §14.2, §14.3 — ADR 0014)**

- **Number rental is a ledger row per (number, period)**: `reason = rental`,
  `ref_type = number_rental`, `ref_id = <number id>:<next_rental_at ISO>`, under the partial
  unique index `credit_ledger_rental_debit_once_idx` — the same shape as the call debit. The
  debit and the advance of `next_rental_at` happen in one wallet transaction under the
  workspace lock, with the row re-read under it. A `DuplicateRentalDebit` (two runs racing
  past the pre-check) is handled **outside** that transaction — the unique violation has
  already aborted it, so nothing after it can run — and reported as already charged. The amount is
  `pricing.recurring.number_rental_credits` from the published config, never the column
  default; `custom_sip` numbers are never charged (the type is the rule). A due rental the
  wallet cannot cover past the grace sets `rental_overdue_since` and leaves the period owed
  (`decideRental()`); warnings open at `rental_warning_days`; `number-release` releases after
  `release_after_days_at_zero_balance`, platform first, and a platform failure leaves the row
  `releasing`, never `released`.
- **Alert state is a keyed `alerts` row**: `alerts_open_key_idx` on `(tenant_id, key) WHERE
resolved_at IS NULL`. Open = `INSERT … ON CONFLICT DO NOTHING`; a schedule that finds the
  condition still true opens nothing; `resolve()` closes it when the condition clears and the
  next crossing opens a fresh row. Keys: `low_balance:<pct>`, `concurrency`,
  `rental_overdue:<number id>:<day>`, `number_released:<number id>`, `auto_topup_failed`
  (opened by the notifications module listening to `AutoTopupService.onAbandoned`, resolved
  on `onCredited` — billing announces, it never writes `alerts`). Dismissal hides, never
  resolves. Only `WorkspaceAlertsService` writes `alerts`.
- **Every customer message is an outbox row** (`notifications`, `dedupe_key` unique): the
  INSERT is the claim and carries the body (`payload_json.text`/`html`) from the start, the
  inserter sends, and a `failed`/`pending` row — including one a crash left between the
  INSERT and the send — is re-sent by `retryFailed()` from what it stored. Nothing else calls the email sender. Bodies carry no
  token, key or secret; the log sender logs recipient (masked) and subject only.
- Low-balance thresholds are `low_balance_thresholds_pct` of the last paid pack (the trial
  size before a purchase), crossed at or below (`decideLowBalance()`), evaluated on every
  ledger write and by the 15-minute sweep. **One evaluation sends at most one email, for
  the lowest threshold it crossed**: a debit through 20 %, 5 % and 0 opens three alerts
  and sends the "run out" email once. The sweep evaluates only workspaces with an open
  low-balance alert or a ledger row in the last 45 minutes (`credit_ledger_created_at_idx`);
  it never aggregates the append-only ledger whole. Emails go to owners and admins whose
  effective `low_balance_email` is true (own `notification_settings` row, else the
  workspace default).
- **The daily digest is hourly and per timezone.** Each tick asks each workspace whether it is
  past `DIGEST_LOCAL_HOUR` in `tenants.timezone` and whether its _previous local day_ went out
  (`local-day.ts`: two local midnights, so DST days are 23 or 25 h). Never one UTC midnight
  run. Recipients: members whose effective `new_message` is `daily`.
- Concurrency: `decideConcurrency()` reaches the threshold at `ceil(cap × CONCURRENCY_ALERT_PCT
/ 100)` live entries of `active:{ws}` (expired ones ignored), from the caps the inbound
  path uses; Redis unreachable decides nothing. `RedisCache.scanKeys()` answers `null` on
  an outage and `complete: false` at its cap, and the monitor resolves nothing from the
  _absence_ of a hash in either case — an empty scan read as "no live calls" would close
  every open alert and re-page ops on the next tick.
- Reconciliation: one `reconciliation_runs` row per UTC day window, upserted on rerun; the ops
  alert is gated by `alerted_at` with a conditional update (once per window, whoever runs it);
  a provider error is `provider_error`, a truncated page list is `partial` — neither is drift.
  Threshold `RECONCILE_DRIFT_THRESHOLD_PCT`. Provider facts come only from
  `RetellGateway.listCallsInWindow()`, which reads retell-sdk 6's page shape
  `{has_more, items, pagination_key}` through `callListPage()` — anything else is a thrown
  provider error, never "zero calls" (a bare-array read once made every night's run report
  every row in `calls` as drift; `retell.list-calls.test.ts` pins the SDK type).
- Auto top-up credits a `pending` **or `abandoned`** purchase when `payment_intent.succeeded`
  arrives with a matching amount: Stripe may deliver an earlier attempt's failure after the
  success, and Stripe has the money either way.
- **The API contract is `src/openapi/manifest.ts` joined with the controllers' decorator
  metadata.** Adding or changing a route means editing the manifest and running
  `pnpm --filter @portal/api openapi:generate`; `openapi:check` fails CI on a route in one and
  not the other, a role mismatch, or stale `docs/api/openapi.json` /
  `frontend/api-client/src/generated/endpoints.ts`. Small ack bodies have names in
  `shared/schemas/src/responses.ts`; a `{deleted: true}` literal is not a contract.
- `GET /health/ready` reports Postgres, Redis and the worker heartbeat (`worker:heartbeat`,
  refreshed every 30 s by `WorkerHeartbeat`, plus a file for the compose healthcheck) and
  answers 503 when Postgres or Redis is down. `/health` stays a liveness probe.
- **The worker is capped at 1 CPU and 1 GB in `infra/docker-compose.prod.yml`; the API is
  not.** The API owns the §13.9 hot path; a worker job must never starve it. Do not add a CPU
  limit to `api`.

**Portal (frontend/web — ADR 0017)**

- Static export: no server, no dynamic segments, `trailingSlash: true`. Every page is a
  client component behind a guard. **`pnpm dev` builds into `.next-dev`, everything else
  into `.next`** (`NEXT_DIST_DIR`, both Next apps): a `build`, a `typecheck` (the web
  typecheck task depends on `build`) or a deploy in a second terminal otherwise rewrites
  the directory the running dev server holds open, and it throws
  `ENOENT … _buildManifest.js.tmp.…` on every compile until it is restarted. `NEXT_PUBLIC_*` is baked at build time;
  `next.config.ts` derives the local values from the repo-root `.env`, so a dev box sets
  nothing extra. Never read `process.env` outside `src/config.ts`.
- Session is `AuthProvider` (`@auth0/auth0-spa-js`, PKCE, localStorage cache, rotating
  refresh tokens). The Auth0 callback is the **origin**; `/` handles `?code=&state=`.
  `getToken()` throws `AuthRequiredError` on a lost session and the guard sends the person
  to `/login?next=`. A3 re-reads claims with `refresh()`; A5 asks for `acr_values`
  multi-factor; A6 is Auth0's `dbconnections/change_password`.
- Gating is `useSessionGate()` + `RequireAuth` / `RequireVerified` / `RequireWorkspace` /
  `OnboardingStepGuard(step)` / `AppGuard`. A wizard page W-k is allowed while
  `k ≤ onboarding_step`; the portal advances the step with `PATCH /workspace`, never
  backwards, single-flight; a guard never redirects while the workspace row is refetching.
  `LAST_IMPLEMENTED_STEP` (`src/routes.ts`) gates the dashboard until W4–W7 land.
- **Colours are tokens.** `bg-card`, `text-muted-foreground`, `border-border`, `bg-primary`…
  from `frontend/ui/src/styles/globals.css` (`:root` and `.dark`), derived from the five
  Oraly brand colours — Purple `#7B5CFF`, Electric Blue `#22D3EE`, Deep Navy `#0A0F1A`,
  Slate `#1E2433`, Soft White `#F7F8FB` (`docs/brand.md`). No `bg-white`, `text-neutral-*`,
  `dark:` overrides or hex values in components; a component that needs a new colour adds a
  token pair. `ThemeProvider` / `ThemeToggle` / `ThemeSegment` are the only theme code, and
  the logo is `Logo` in `@portal/ui`, rendering the supplied artwork from
  `public/brand/` — never redrawn, recoloured or rebuilt inline.
- **W3's language ranks the voice list, it does not cut it.** `list-voices` carries no
  language at all, so the native language is derived from the accent
  (`modules/voices/voice-languages.ts`), matched on the base subtag (`fr-FR` answers
  `fr-CA`) and returned as `native` per item; the picker groups on it and `?native=true`
  narrows. Reading "no languages" as "speaks all of them" is what made every voice
  multilingual and the filter a no-op. `is_multilingual` now means "we cannot name one
  native language", not "can speak others" — they all can.
- Data goes through `useApi()` and the generated hooks; SSE through `useWorkspaceEvents`;
  a `202 {job_id}` through `useJobWatch` **and** the topic's frames at the same time.
  Errors become copy through `errorMessage(error, t)` (branch on `code`, never on text).
- Every user-facing string is a key in `src/i18n/messages/en.json` (`useTranslations`).
- Analytics: `track()` from `src/analytics/posthog.tsx` only; ids, step names and counts,
  never brief text, emails or phone numbers.
- Retell is never named; say "voice", "what your agent knows".
- Local run without the Auth0 tenant: `pnpm dev:issuer`, then the API with
  `AUTH0_CUSTOMER_DOMAIN=http://localhost:9999` and the portal built with
  `NEXT_PUBLIC_AUTH0_DOMAIN=http://localhost:9999`. The D8 exit check is
  `pnpm --filter @portal/web e2e:wizard` (headless Chrome, 36 assertions, a real Generate).

**Configuration**

- Pricing, feature flags, kill switches, templates and the agent stack live in versioned tables and are
  read through `GET /pricing` and `GET /flags`. Never hard-code a price, rate, cap or model id.
  The `pricing_configs.config_json` shape is `pricingConfig` in `shared/schemas/src/pricing.ts`;
  read it through `PlatformConfigService` (`modules/config`), which caches in Redis with a 60 s TTL.
  Version 1 comes from `pnpm db:seed` (`backend/db/prisma/seed-data/pricing-v1.ts`), only into an
  empty table.
- The agent stack is the same kind of data: `agent_stack_configs` holds tier → model/voice, the
  §9.4 guardrail text, the §9.5 lint severities and the §9.3 prompts, read through
  `AgentStackService` and cached at `stack:current` for 60 s. Guardrails, lint and prompts
  degrade to a compiled-in default — an empty or malformed row must never mean "append no
  guardrails" or "skip the lint". **The tier stack does not degrade**: there is no
  compiled-in model, voice or plan ceiling. `AgentRetellService.syncDraft` requires a
  `TierStack`; publish answers `503 NOT_CONFIGURED` and the worker records
  `retell_sync: skipped` when the row is missing or its `tiers_json` fails `agentStackTiers`.
- Publishing invalidates `pricing:current`, `stack:current`, `flags:*` and `caps:{ws}`; the portal
  re-reads within 60 s.
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

| Key                          | Contents                                                                                                                |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `bal:{ws}`                   | cached credit balance, 1-hour TTL                                                                                       |
| `active:{ws}`                | **hash** of live calls: `call_id → "<reserved credits>\|<expires at ms>"`, key TTL = max duration + 5 min (ADR 0011 §1) |
| `events:{ws}`                | pub/sub channel carrying that workspace's SSE frames (PUBLISH only, never a key)                                        |
| `caps:{ws}`                  | plan caps and grace, from the current pricing config plus tenant overrides                                              |
| `num:{e164}`                 | number → workspace, agent, tier, **rate**, plan max, hours, transfer targets, paused flags                              |
| `pricing:current`            | current pricing config snapshot                                                                                         |
| `stack:current`              | current `agent_stack_configs` snapshot: tier stacks, §9.4 guardrails, §9.5 lint                                         |
| `flags:global`               | feature_flags + kill_switches rows                                                                                      |
| `flags:{ws}`                 | `GET /flags` resolved for one workspace                                                                                 |
| `kill:reject_inbound`        | the SA12 veto, `'1'`/`'0'`, for the hot path — outside `flags:` and its 60 s TTL                                        |
| `lock:schedule:{name}`       | one worker per running §13.11 tick, `SET NX`, TTL 2× the interval (D7)                                                  |
| `worker:heartbeat`           | the worker's liveness beacon, refreshed every 30 s, read by `GET /health/ready` (D7)                                    |
| `alert:platform_concurrency` | the open platform-wide concurrency incident, so ops is paged once per incident; held a day at most (D7)                 |

Keys are built only in `modules/redis/redis.keys.ts`. Cache reads go through `RedisCache`, which never
throws and never waits past its budget (ADR 0010 §6).

## API conventions (§16)

- Errors: `{code, message, fields?[]}`. Known codes include `402 NO_CREDITS`, `403 EMAIL_UNVERIFIED`,
  `429 TEST_RATE_LIMIT`.
- Pagination: `?cursor=&limit=`.
- Long operations return `202 {job_id}`; the client subscribes to SSE and falls back to
  `GET /jobs/:id` every 3 s.
- SSE topics: `wallet`, `alerts` (D7: `opened` / `resolved` / `dismissed`), `agent:{id}`,
  `call:{id}`, `activation:{id}`. `GET /events` is an ordinary
  authenticated route (the client is `@microsoft/fetch-event-source`), narrowed with `?topics=`, and
  only ever carries `ctx.workspaceId`'s own channel. `agent:{id}` frame types are named once, in
  `modules/agents/agent-events.ts`: `created`, `draft_updated`, `draft_selected`,
  `generation_started`, `generation_progress`, `generated`, `generation_failed`, `patched`, `version_created`,
  `published`, `paused`, `resumed`, `deleted`, plus `activated` (D6). `activation:{job_id}` frames
  (`ActivationEvents` in `@portal/schemas`): `started`, `progress`, `live`, `failed`, each carrying
  the `activationView` — status, step, progress %, attempt, number id/e164, one customer-safe
  error sentence; never a provider id or a stack trace.
- D6 routes: `POST/GET /agents/:id/knowledge`, `DELETE /agents/:id/knowledge/:sourceId` (and
  the same resource at `/knowledge`); `PUT/GET /agents/:id/phone-plan`; `GET /numbers`,
  `POST /numbers/buy`, `POST /numbers/import`, `GET/PATCH/DELETE /numbers/:id`,
  `GET /numbers/forwarding-guide`; `POST /agents/:id/activate` (202), `GET /agents/:id/activation`,
  `GET /activations/:id`; `PUT /wallet/auto-topup`, `GET /wallet/invoices`, `POST /wallet/portal-session`.
  Buying, importing, releasing, activating and billing routes are owner/admin; knowledge and
  routing edits are editor and above.
- D7 routes: `GET /alerts/active`, `POST /alerts/:id/dismiss`,
  `GET|PATCH /workspace/notification-settings` (any member; a member edits only their own
  preferences), `GET /health/ready`. The full contract with every code and role is
  `docs/api/openapi.json`.
- Recordings: `GET /calls/:id/recording` mints a signed one-hour link to
  `GET /calls/:id/recording/stream?token=`, which is `@Public()` and proxies the bytes. The Retell
  URL is never given to the browser (ADR 0011 §5).
- Webhook routes take no JWT: `/webhooks/retell`, `/webhooks/retell/inbound/:number_token`,
  `/webhooks/stripe`, `/webhooks/auth`.

## Data model index

Portal (§15): `users, tenants, memberships, invites, audit_log, notification_settings, templates,
agents, agent_versions, voices, knowledge_sources, phone_plans, phone_numbers, calls, credit_lots,
credit_ledger, purchases, packs, webhook_events, jobs, alerts`, plus since D7 `notifications`
(the outbox) and `reconciliation_runs` (global, staff-only).

Admin (§8): `staff_users, staff_role_limits, pricing_drafts, pricing_configs, stripe_price_map,
promo_codes, custom_deals, tenant_overrides, agent_stack_configs, retell_cost_inputs,
credit_adjustments, refunds, support_tickets, ticket_messages, canned_responses, customer_notes,
customer_flags, impersonation_sessions, announcements, email_templates, feature_flags, kill_switches,
blocklists, fraud_reviews, data_requests, staff_audit_log`.

## External integrations

**Retell** (Appendix A): `list-voices`; `create-agent`, `update-agent`, `get-agent`, publish/version;
`create-retell-llm`, `update-retell-llm`; `create-knowledge-base` + sources; `create-phone-number`,
`import-phone-number`, `update-phone-number`, `delete-phone-number`, `list-phone-numbers`;
`v3/create-web-call`, `v2/create-phone-call`, `v2/get-call`, `v3/list-calls`, `delete-call`
(v2 web-call creation loses support 30 Sep 2026; retell-sdk 6 already posts to v3, pinned by
`retell.endpoints.test.ts`. The browser uses `RetellClient` with a `fetch` that answers
create-web-call from our API — never a public key; `RetellWebClient` is gone in SDK 4.)
Events in: `call_started`, `call_ended`, `call_analyzed`, `transfer_*`, plus the per-number inbound webhook.

**Stripe**: Checkout Session, Customer Portal, `checkout.session.completed`,
`checkout.session.async_payment_succeeded`, `checkout.session.expired`, off-session PaymentIntent for
auto top-up (`payment_intent.succeeded | payment_failed | canceled`), `invoice.created | finalized |
paid | payment_failed | voided | marked_uncollectible`, `charge.dispute.created`. The full list is
`StripeEventHandler.HANDLED`; subscribe the dashboard endpoint to exactly that.

**Auth0**: two tenants, both **Single Page Application** type. Post-User-Registration Action → `POST /webhooks/auth` (shared-secret header, `user.registered`) → upsert `users`. That trigger is fire-and-forget on Auth0's side, so there are two safety nets, both the same idempotent `UsersService.upsert` (module `auth`): the customer Post-Login Action posts `user.login` to the same route on every login (deduped to a 204 after the first), and `AuthGuard` provisions the row itself when a verified token has no row and carries `https://portal/email`. Only that namespaced claim is trusted for provisioning, never a bare `email` claim. Post-Login Actions add `https://portal/email_verified`, `https://portal/email`, `https://portal/name` (customer) and `https://portal/mfa` (staff). Frontend uses `@auth0/auth0-spa-js` (Authorization Code + PKCE — no client secret in the browser, ADR 0008). Both tenants are configured from `infra/auth0/tenant.customer.yaml` and `tenant.staff.yaml` with the Auth0 Deploy CLI (`pnpm auth0:validate|check|export|plan|deploy`, a dev dependency — nothing global to install), Actions source in `infra/auth0/actions/`, procedure in `docs/runbooks/auth0.md`. The deploy CLI matches objects by **name**, so a wrong name creates a second application instead of failing: export and diff before the first deploy. `pnpm --filter @portal/api verify:auth0` is the check against the real tenant — Actions deployed and bound, the shared secret, the access-token claims, and JIT provisioning.

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
pnpm dev               # api, worker, portal, admin. The worker is not optional: without it
                       # every 202 job (generate, provision, activate) sits in `queued` for
                       # ever. `GET /health/ready` reports it as "no heartbeat".
pnpm --filter @portal/api openapi:generate   # after any route change: docs/api/openapi.json + the typed client
```

External accounts and staging infrastructure: `docs/runbooks/provisioning.md`; the EC2 stack,
deploy and verification: `docs/runbooks/staging.md`.

## Open decisions (§20, §5.5, admin)

1. ~~Working name and domain~~ — resolved 22 Sep 2026: **oraly.ai** (Namecheap, BasicDNS). Hosts
   `api` / `app` / `admin.oraly.ai`, staging with a `-staging` suffix (ADR 0015).
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
  one webhook URL set per environment. Stripe test and live keys never mix. Staging and prod run
  `infra/docker-compose.prod.yml` on EC2; configuration is written on the box from SSM by
  `infra/scripts/deploy.sh` (which refuses to deploy without `PORTAL_URL`, or with one that
  points at localhost, and exits non-zero when `/health/ready` is not 200 — a degraded box is
  a failed deploy, not a printed status), and CI publishes the image to GHCR and deploys `develop` to staging
  over SSM Run Command (`docs/runbooks/staging.md`).
- Tests are required for metering, ledger idempotency, webhook exactly-once, inbound decline paths,
  RLS cross-tenant isolation, and — from D5 — guardrail tampering, version immutability, publish
  idempotency and duplicate generation jobs; from D6 — SIP credentials encrypted at rest, activation
  step order and retry limit, one purchase per retried activation, top-up credited once, invoice
  idempotency, and workspace isolation on knowledge/numbers/activations (`test/d6-*.e2e.test.ts`);
  from D7 — scheduler registration across restarts and the tick lock, rental idempotency and
  the overdue → release path, expiry idempotency, low-balance alert state, digest per
  timezone (DST included), reconciliation once-per-window alerting, concurrency alert
  hysteresis, webhook ordering / replay / decline for both providers, and the RLS matrix over
  every D6/D7 table (`test/d7-*.e2e.test.ts`, `backend/db/test/rls.e2e.test.ts`).
  Other areas are best-effort.
- The §13.9 latency SLO is asserted, not eyeballed: `pnpm --filter @portal/api load:setup` then
  `load:inbound` runs k6 with `p(95)<300` as a threshold, so the run exits non-zero if it regresses.
  `load:reset` frees the slots a previous run reserved; `load:teardown` pauses the number afterwards.
- `pnpm test` is unit-only and needs nothing running. `pnpm test:e2e` needs Postgres **and Redis** and
  covers the parts that cannot be mocked: RLS isolation, the append-only triggers, the auth
  boundaries, the wallet (FIFO, overdraft, idempotent call debit, `bal:{ws}` rebuild), the Stripe
  webhook path with real signatures, and the D5 lifecycle — workspace creation atomicity, invites
  and ownership transfer, the generation pipeline through a real worker, guardrail tampering,
  version immutability and the publish lease (`backend/db/test/*`, `backend/api/test/*`). Start with
  `pnpm infra:up && pnpm db:roles && pnpm db:deploy && pnpm db:seed`; `pnpm doctor` says what is
  still missing. The e2e files run **one at a time** (`fileParallelism: false`): they share the
  global config tables and the `flags:*` cache, and a suite that flips a kill switch was
  invalidating another suite's assertion once in every ten runs.
- Retell and the LLM are the only two things a test substitutes, and both have a stand-in that
  models the real behaviour rather than mocking it away: `FakeRetellGateway` (a published version
  is immutable, so an edit branches) and `ScriptedPromptProvider` (`GENERATION_PROVIDER=scripted`).
- Conventional commits. Reference the spec section in the body.
- Update this file and add an ADR whenever a decision changes. Do not let CLAUDE.md drift from reality.
- Prefer editing the spec-derived schema in `shared/schemas` first, then the API, then the UI.
