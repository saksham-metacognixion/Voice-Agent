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
| Portal & admin | Next.js App Router, TypeScript, Tailwind, shadcn/ui, TanStack Query, Zustand (ephemeral wizard UI only), React Hook Form + zod, next-intl (en, ar, fr-CA — ADR 0026, ADR 0030), PostHog, `retell-client-js-sdk`                                                                                          |
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
BullMQ hand-off for both providers, the recording proxy (D4), and `call-recovery` for a lifecycle
webhook the platform never sent (§7, 24 Sep), 0012 prompting pipeline and
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
together, the local stand-in issuer and the wizard end-to-end script (D8), 0018 the
customer dashboard — sort/total/`sentiment` on `GET /calls`, `PATCH /calls` bulk handled,
`POST /calls/export` streamed CSV, the lint dry-run route, first-frame `call:` payloads,
`?id=&tab=` / `?call=` routes, URL-held D2 state, shared wizard form bodies, the inline
SVG chart and phone-width tables (D10), 0019 the rest of the dashboard — one SSE stream
opened by the shell and closed on `pagehide`, the bottom tab bar, tables as cards below
640 px, `GET /audit-log`, `sip` + `calls_7d` on numbers, D4 as `?id=&tab=`, and what
D4–D7 deliberately do not offer (D11), 0020 the restaurant menu as a knowledge `role`
(one per agent, restaurant agents only), the category shown on W2/W4/D3 with a W1
warning that never refuses, the identity block + `platform_named` lint, and vendor
voice clips denied outside `APP_ENV=dev` (25 Sep), 0021 the admin console — the `admin`
module on `adminDb` in front of the same services, `staff_audit_log` inside the write's
transaction, pricing publish as insert-unpublished → Stripe sync → effective, jobs keeping
their payload for a staff retry, SA3 through the Auth0 Management API, and read-only view-as
as an API-minted `imp_` credential (D12, 28 Sep), 0022 the P1 admin close — SA4 tickets with
macros, SA9 refunds as claim → Stripe → settle, SA13 staff invites bound on first sign-in, the
SA7 provisioning queue and concurrency view, and the D13 QA (28 Sep), 0023 business
documents in the brief — a menu or price list uploaded on W2, extracted to text by a
stateless route, kept in `brief.documents` and appended to the runtime prompt verbatim
next to the guardrails, no plan gate; photos transcribed by the generation model; `parseBrief` repairs per field (29 Sep), 0024 what the
agent knows comes after payment — W3 → W5, W4 is the first page after go-live behind
`LiveGuard`, and the `knowledge-sync` job that attaches a base to a live agent republishes
the live version itself (29 Sep), 0025 the D14 hardening — disposable email refused
by a pre-registration Action and again by `UsersService.upsert`, Auth0 attack protection as the
§6.2 login/sign-up limits, one `onRequest` hook for the origin check and the per-IP API budget,
OpenTelemetry for traces and Sentry (errors only, nine integrations) with measured inbound
cost, the console diagnostics routes, the RDS PITR drill and the console's CI deploy (29 Sep), 0026
Arabic and right-to-left in the portal — next-intl without routing, the language a per-browser
choice applied before first paint, `UiLocaleProvider` in `@portal/ui`, logical CSS only, API copy
translated by id through `useServerCopy` (26 Oct), 0027 Arabic agents for KSA and the UAE —
`agentLanguage` = the platform's locales + `ar-AE` (sent as `ar-SA`), Arabic always transcribes
`accurate`, the dialect / speaker gender / digit-by-digit numbers as a `## Language (fixed)`
runtime block, curated Gulf voices recognised by platform name, Arabic digits in the phone
check; UAE not sold until Emirati numbers transcribe (26 Oct), 0028 D16 — the transferred
leg as its own `transfer` ledger row folded from the stored events, per-number date
overrides and strict hours writes, knowledge use per call, SIP re-verify by OPTIONS +
digest, and Arabic instead of fr-CA (27 Oct, amended by 0030), 0029 D17 — "Call my phone" on the browser
test's checks plus a paid pack and an own-phone destination, the forwarding test as a
`fwdtest:{e164}` marker the inbound path declines, the website widget as a public key, an
`/embed/` iframe and one `WIDGET_UNAVAILABLE`, `is_test` from `metadata.test` (27 Oct), 0030 Canadian French in the portal beside Arabic —
`fr-CA` as the locale id (Auth0 `ui_locales`, `<html lang>`, `Intl`), `matchLocale` (same
tag, else same base language), one glossary (27 Oct), 0031 D18 outbound click-to-call — a
callback of a D2 call only, behind staff-decided KYC, a verified caller ID, the workspace and
platform do-not-call lists, prior contact, every-zone calling windows and a per-plan daily cap
under a lock; voicemail per call (28 Oct), 0032 the 28 Oct QA batch — duplicate / discard draft /
save version, denoise + PII add-ons on the version, editable analysis fields, the recording notice,
the transfer-failed message, ledger export, the workspace zip and delete *request* (supersedes
ADR 0019 §8), test-call versions, and the console's pinned actions and non-blocking health (28 Oct). Rejected and why, in `docs/decisions/0001-tech-stack.md`: plain Fastify (less ceremony but the spec
names NestJS), Drizzle (SQL-first migrations but the spec names Prisma), FastAPI (would fork the shared
zod schema layer), Next.js route handlers only (breaks SSE and BullMQ).

## Repo layout

Split by deploy target. `frontend/` ships as a static export to S3 + CloudFront, `backend/` ships to AWS EC2, `shared/` is
imported by both and never deployed on its own.

```
frontend/                         → S3 + CloudFront (static export, ADR 0008)
  web/            @portal/web         Next.js customer portal      app.<domain>
                                      app/ = routes (A1–A8, onboarding/W1–W7, app/D1–D7, app/agents/detail = D3 tabs);
                                      src/ = auth, guards, workspace, wizard hooks, dashboard hooks + pure
                                      modules (src/dashboard), shell + wizard + dashboard components, i18n,
                                      analytics; scripts/ = serve-export, e2e-wizard (D8), e2e-dashboard (D10), e2e-dashboard-d11 (D11)
  admin/          @portal/admin       Next.js staff console        admin.<domain> (D12: static export like the portal,
                                      no next-intl, every mutation behind a reason-code dialog; app/ = overview, customers
                                      (+detail/?id=&tab=), users, pricing, telephony, calls, system, audit; src/ = auth,
                                      shell (search, health strip, impersonation banner), lib)
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
alerts, global); since D18 `outbound` (click-to-call and its gates, above `calls`); since ADR 0032
`data-requests` (D6 export zip and delete request, above `calls` and `wallet`, nothing imports it); since D12 `admin` (admin §9: every `/admin/*` route, `StaffAuditService`,
`StaffLimitsService`, `ImpersonationService`, plus the customer-namespace `/impersonation`
routes) — the top of the graph, imports wallet/runtime-cache/billing/webhooks/config/agents/
events/calls and nothing imports it; since D7 `notifications` (§13.1: the outbox, the email sender, the customer
alert state in `alerts`, low-balance alerts, the daily digest, `GET /alerts/active`) and
`openapi` (the route manifest and the generator — not a Nest module). The arrows run one way: `prompting` → `agents` → `retell`;
`activation` → `agents` + `numbers` + `billing`; nothing depends on `activation`. Billing does
not import activation — `BillingService.onPurchaseCredited` announces and the activation
module listens. The agent stack (§9.3–§9.5 configuration) lives in `agents` because publish
needs it too, which is what saves both modules from a `forwardRef`.

Jobs: `modules/jobs` owns the BullMQ plumbing — five queues (`webhooks`, `calls`, `prompting`,
`provisioning`, `scheduled`), a handler registry every feature module registers into at module init, the worker
runtime, the §13.11 schedulers (plus `job-sweeper`, which writes off `jobs` rows whose queue
job is gone) — plus the `jobs` table behind `202 {job_id}` and `GET /jobs/:id` (§16). Thirteen
of the fourteen schedules are live (`kb-sync` is the skeleton; `call-recovery` joined on 24 Sep); each is upserted by
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
  played whatever the switch says and the daily `voice-cache` job never writes it. Every
  catalogue voice has one of ours shipped with the portal
  (`frontend/web/public/samples/voices/<hash>.mp3` + the `voice-samples.generated.ts`
  manifest the API reads — files, not rows, so staging gets them with the deploy), made
  by `pnpm --filter @portal/api samples:voices`; rerun it when the catalogue grows
  (ADR 0020 §5 addendum). There is no
  text-to-speech route to make one with (ADR 0003 §9 + the D8 addendum). The W1 template
  clips (`frontend/web/public/samples/*.mp3`) are recordings of a throwaway `dev-sample-*`
  agent reading a fictional business's line, made by `pnpm --filter @portal/api samples:templates`. **The default is
  `deny` everywhere but `APP_ENV=dev`** — a design partner on staging heard a clip say the
  vendor's name (25 Sep, ADR 0020 §5). The agent's own script is kept clean the same way:
  `identitySection()` in the generation user turn names the business and forbids any other
  name, and lint rule `platform_named` blocks a publish whose prompt or greeting names the
  platform (as spelt, or as a transcript hears it). Nothing here is a hard-coded business
  name.

**Webhooks (§13.10, §14.2)**

- Verify signature on the **raw body** (parser scoped to `/webhooks/*` only) → upsert `webhook_events`
  with unique `(provider, external_id, event_type)` → return 2xx fast → process in the queue.
- Duplicate of a _processed_ event returns 204. Never return 5xx to a provider after the event is
  stored; retries are BullMQ's, eight attempts with exponential backoff (ADR 0011 §3). Both providers
  follow this rule since D4 — the D3 Stripe exception is gone. `WebhookEventsService.store()` still
  returns `retry` (not `duplicate`) for a stored but unprocessed event, and the `webhook-sweeper` job
  re-enqueues anything stored that never reached the queue.
- Retell's `external_id` is the `call_id`; a payload without one is deduped on a digest of its bytes.
  `transfer_started|bridged|cancelled|ended` settle the transferred leg (D16); unknown types are
  stored, acknowledged and left for a later handler.
- Handle Stripe `checkout.session.completed` (credit only when `payment_status = paid`),
  `async_payment_succeeded`, `async_payment_failed` and `expired` (→ `abandoned`).

**Metering (§14) — the money rules**

- `call_ended` is the **only** event that moves credits for the agent leg. `call_analyzed` stores
  analysis and `retell_cost_cents` for COGS and **never bills**.
- **A transferred call is two legs** (D16, ADR 0028). The agent leg is `call_ended` as above; the
  transferred leg (`bridge → end`, `rates.transferred_leg_per_min`, 0.25) is its own ledger row,
  `reason = transfer`, `ref_id = call_id`, under `credit_ledger_transfer_debit_once_idx`. Its facts
  are **folded from every stored `webhook_events` row for the call** (`foldTransfer` in
  `modules/calls/transfer.ts`, pure, order-independent): earliest `transfer_bridged`, the
  platform's `transfer_end_timestamp` else `transfer_ended`'s time; no bridge = `cancelled`, never
  billed. `CallsService.settleTransfer` runs on every transfer event and after every lifecycle
  event; a transfer event before the row exists settles as `transfer_deferred` (never retried —
  the sweeper would loop on a call that is not ours) and is folded in when the row appears. The
  rate comes from the pricing version the call was rated under, captured once into
  `calls.transfer_rate`. `transfer_credits_charged` is the second projection; anything summing
  call usage counts `reason IN ('call', 'transfer')`. A live agent subscribes to
  `transfer_bridged` at its next publish — `pnpm --filter @portal/api agents:republish --apply`
  once per environment after the deploy.
- `duration_s = (end_timestamp − start_timestamp)/1000`. If `disconnection_reason` indicates not
  connected (dial failed, no answer, busy) the charge is 0.
- `credits = duration_s/60 × rate(tier)` rounded to 0.01. Ledger debit is idempotent on `call_id`.
- `calls.rate` and `calls.config_version` are captured **once**, by whichever event creates the row
  (the inbound write-behind, `call_started`, or `call_ended` if it arrives first), and are never
  overwritten, so a mid-call price change cannot re-price a call in flight (ADR 0011 §4).
- Retell can deliver out of order: `call_ended` first finalises the row and the late `call_started`
  does not reopen it; `call_analyzed` first creates an **unbilled** row and leaves it unbilled.
- Every ledger write goes through the `wallet` module. No direct `credit_ledger` inserts anywhere else.
- **A lifecycle webhook the platform never sends is recovered, not lost** (ADR 0011 §7). The
  platform has been seen delivering `call_started` and dropping `call_ended` + `call_analyzed`
  for a call it had ended and analysed. The 5-minute `call-recovery` schedule
  (`CallRecoveryService`, module `webhooks`) asks `get-call` about rows still
  `registered`/`in_progress` after 3 min (24 h window) and `ended` rows without analysis after
  10 min (6 h window), and **stores the answer as the missing `webhook_events` row** — same
  dedupe key, same queue, same handler — so it bills nothing itself and a late real delivery is
  a 204 duplicate. A call whose event is already stored is skipped (that is the sweeper's).
  A call someone is watching does not wait for the tick: `GET /calls/:id` on an unsettled row
  queues `recover-call` (`recover-<call_id>`, 20 s delay, which is also the throttle) →
  `CallRecoveryService.recoverOne()`, same path, a 15 s ended-ago grace. **Every ask is
  remembered on the row** (`recovery_checked_at`, `recovery_checks`): re-asked no sooner
  than 15 min, never-asked rows first, a missing analysis given up after 3 asks, and a
  call the platform has no record of is settled with the `call_ended` it never sent
  (`not_connected` / `error`, `recovery_reason: not_found`, billed zero by the ordinary
  handler). The predicate and windows are `modules/calls/call-recovery.rules.ts`
  (`unsettledCallKind`), shared by the route and the service.
- **`is_test` is what we minted** (D17, ADR 0029): `isTestCall()` reads `metadata.test` when it
  is a boolean, else `channel = web`. W5 and "Call my phone" mint `test: true`, the website
  widget `test: false` — a real caller on the `web` channel. Never infer "test" from `web`
  alone again; the portal's `webCaller()` and the new-call toast follow the same rule.
- `calls.agent_version` is **our** `agent_versions.version_no` — `metadata.version_no`, else the
  platform version mapped through the published row's `retell_agent_version`, else null. Never
  the platform's counter (a draft reads 0 there, and it must not reach the wire).

**Inbound call authorisation (§13.9) — p95 < 300 ms**

- `POST /webhooks/retell/inbound/:number_token`. Redis-only path; Retell times out at 10 s and retries 3×.
  Four keys, two round trips, one 150 ms budget. Measured p95 8.4 ms at 6 319 req/s (`test/load/inbound.k6.js`).
- Six ordered checks: workspace not paused → number not paused (or no live agent) → caller not in
  blocklist → balance > −grace → active calls < plan cap → hours rule. Hours: `custom` = the
  number's own schedule and zone, `business` = the workspace's (none set = open, `no_schedule`),
  `always` = none. On a date: closed date → `date_overrides` entry (no intervals = closed) →
  weekday; a closed date also shuts the previous evening's overnight spill (D16). `isOpen` lives
  in `@portal/schemas` so D4's "open now" is the same decision; writes go through
  `businessHoursInput` (known IANA zone, ≤ 4 non-overlapping intervals a day, real unique dates). The SA12 `reject_inbound`
  kill switch declines before all of them. The checks are a pure function, `decide()` in
  `modules/calls/inbound.decide.ts`; the service only fetches and answers.
- **A forwarding test is turned away before the checks** (D17, ADR 0029): the first MGET also
  reads `fwdtest:{e164}`; a call from our own number or the customer's forwarded line while
  it is set is answered `inboundDecline()` — no `calls` row, nothing billed — and only
  enqueues `forwarding-test-landed`. Not part of `decide()`. **The call it turns away
  consumes the marker** (compare-and-delete inside the budget), so a test declines one
  call at most — never every real caller on a carrier that shows the forwarded line.
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
  The number is **our end only** — `to_number` inbound, `from_number` outbound (`ourEnd()`), never
  the other party's: a platform number ringing a customer posts its own outbound leg with `to` =
  the customer's number, and matching that billed the caller's minutes to the callee (25 Sep).
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
- **A paid Checkout is settled from Stripe's answer, not only from the webhook** (ADR 0013 §9,
  24 Sep). `POST /wallet/checkout/confirm {session_id}` (owner/admin) looks up _this_
  workspace's pending purchase by session id, retrieves the session from Stripe and hands it
  to the same `fulfil()` the webhook uses — same amount check, same wallet lock, same
  idempotency, same `onPurchaseCredited` announcement that starts W7's activation. A
  foreign or unknown id is a 404 and never a Stripe call; an `expired` session is
  abandoned. W7 posts it on every return from Stripe and on "Check again". The
  `auto-topup` tick runs `BillingService.reconcilePendingCheckouts()` first — pending
  Checkout purchases whose session is older than 5 min and younger than 48 h — so a tab
  closed before the confirm is covered too. A session Stripe answers `resource_missing` for is
  abandoned (`failure_reason = session_not_found`) rather than retried; only an outage is retried. Whichever of the three lands first credits;
  the others are no-ops. **Local dev needs `pnpm dev:stripe`** (`stripe listen` forwarding
  to `/webhooks/stripe`, the same `whsec_` as `STRIPE_WEBHOOK_SECRET`): the only endpoint
  registered on the Stripe account points at staging, so without it no local purchase is
  ever credited by webhook — the confirm and the sweep are what saved the 24 Sep go-live.

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
- **`FIXED_PLATFORM_GUARDRAILS` are appended after whatever the stack row says** (SA6 can
  reword §9.4, not these): the closing rule and the phone-number rule — read back only the
  digits said, never pad or guess one, digits said in groups count, ask again only when it sounds incomplete or unclear, give up after two tries and carry on
  (26 Oct: nine digits said, ten read back and captured). **The rule never branches on a
  digit count**: gpt-5-mini miscounts spoken digits, and a length-gated variant re-asked a
  valid ten-digit number 15/16 times on dev; a short number is caught by the read-back and
  by the check below, not by the model counting. Captured phone numbers are not
  trusted either: a text field named like a phone (`isPhoneFieldName`) gets
  `PHONE_FIELD_RULE` in its analysis description, and `GET|PATCH /calls/:id` answers
  `captured_checks` — each number checked against the caller's own transcript turns and
  `libphonenumber-js` for the workspace country + the agent's locale regions
  (`modules/calls/captured-phones.ts`, `mismatch` / `invalid` / `ok`, with the digits the
  caller did say). Read-time only: the platform's analysis is never rewritten, and nothing
  repairs a number. D2 and the W5 card show the warning (`PhoneCheckNote`).
- **A staff transfer number is never in anything the model reads** (ADR 0012, "staff
  transfers", BUG-005). It is the `transfer_call` destination and the `transfer_number_N`
  variables only; `briefForModel`, `transferSection()` and the tool description
  (`transferCallTools()`) name *who* the caller reaches, and `redactTransferNumbers()`
  strips it from the script and greeting at `llmSpec`, so old scripts are covered too.
  `TRANSFER_RULE` and `LIST_RULE` (a category answer is three or four items and an offer
  of more, BUG-007) are fixed rules like `CLOSING_RULE`. **A failed transfer reads the
  number's `transfer_fail_message`** (D4, ADR 0032 §4): a dynamic variable that is
  **always supplied** — `''` from the agent's defaults, the number's value from `num:{e164}`
  on inbound, the calling number's on "Call my phone" — because the platform leaves an
  unsupplied `{{variable}}` as literal braces; blank = the rule's own words. Braces are
  stripped from the customer's text and the number's own targets replaced by "our staff".
- **Add-ons and the recording notice** (ADR 0032 §3, §6). `agentSettings.denoise` /
  `.pii_removal` travel with the version; `runtimeAddOns()` re-applies the plan gate at
  every sync (lost gate = sent off, the version keeps the choice). PII removal never
  covers name, phone, email or address. The recording notice (`tenants.recording_notice`,
  on by default) is put before the greeting at sync by `prompting/recording-notice.ts`,
  never stored, like the documents block. `settings.analysis_fields_edited` makes an
  edited analysis-field list the customer's: a regenerate keeps it.
- **One editable draft on the platform** means a test can only ring the current draft or a
  version that was published: anything else is `409 VERSION_NOT_TESTABLE` (QA-082).
- **The closing line is said only once the caller is done** (ADR 0012, "The closing line",
  26 Oct: "Thank you for calling …" after a read-back or an answer about parking). Four
  places say so: `CLOSING_RULE` (fixed, so it reaches a live agent at its next sync without
  a regenerate), `closingSection()` in the generation user turn (in code, because the
  skeleton is the stack row and staging's v1 ends in a bare `{closing_line}`), every
  template's last two steps ("anything else?" → goodbye only once there is nothing else),
  and the `end_call` tool description. Do not name `end_call` in the rule: agents on old
  scripts then hung up mid-booking. The full fix for an existing agent is a regenerate.
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
- **Business documents are a brief field, appended to the prompt in code** (ADR 0023).
  `brief.documents` (≤ 3, ≤ 15 000 characters in total, `briefDocuments` in
  `@portal/schemas`) is a menu, a price list or a services sheet read into text by
  `POST /agents/:id/documents/extract` (`unpdf` / `mammoth` / UTF-8, stores nothing,
  `400 DOCUMENT_UNREADABLE` for a scan) and saved by the W2 autosave like any other
  field — no plan gate, no platform knowledge base. **A photo** (JPEG/PNG/WebP) is
  shrunk to ≤ 2 000 px JPEG in the browser and transcribed by
  `PromptProvider.transcribeImage` (the generation model's vision, build time only;
  obeys `pause_generation`, `503 NOT_CONFIGURED` without a key), which is why the route
  is in `prompting`. **`parseBrief` drops only what fails** (a bad document entry, a bad
  field) — it used to return `{}`, and a worker running an older schema generated a
  script from an empty brief and stored it (29 Sep); the generation worker now refuses
  a brief that is not generation-ready as it reads it (`brief_incomplete`). Restart the
  worker after rebuilding `@portal/schemas` — `nest --watch` watches `src/` only. `runtimePrompt()`
  (`modules/prompting/documents.ts`) is what `AgentRetellService.llmSpec` sends: script,
  then `## Business documents (attached)` verbatim, then the §9.4 block. The stored
  `prompt_text`, `editable_prompt`, the lint's length rule and a version diff never
  contain the block; the generation turn gets `documentsSection()` (names + a 1 200-char
  excerpt, "do not copy the contents") and `briefForModel()` names only; `mergeBriefPatch`
  skips `documents`. A re-upload reaches the phone at the next sync without a regenerate.
  Fastify's `bodyLimit` is 32 MiB (`main.ts`): the 1 MiB default had been answering 413 to
  any W4 file over ~750 KB. The W4 `role = menu` source (ADR 0020) is unchanged and
  complementary — searched, not read; for a menu longer than the budget.
- **A hand-off rule carries its own payload** (`handoffRule` in `@portal/schemas`, W2 #9):
  `transfer` needs `transfer_number`, `read_message` needs `message` (non-blank, ≤ 500
  chars) — refused by the schema, so the draft PATCH answers 422 and the autosave holds
  the row back until it is complete. Switching action clears the other payload.
  `briefForModel` hands the model the words with "read … word for word", and lint rule
  `handoff_message_missing` (warning) fires when the script does not contain them
  (case and punctuation ignored, guardrail block excluded). `parseBrief` filters
  `handoff_rules` per rule, so a legacy `read_message` without a message costs that
  rule only (30 Sep).
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
- **`ar-AE` is ours, not the platform's** (ADR 0027). Agent settings validate against
  `agentLanguage` (`retellLanguage` + `ar-AE`); `platformLanguage()` / `platformLanguages()`
  in `modules/retell/retell.types.ts` are the only translation, at `agentSpec`, and two
  Arabics collapse into one platform locale. `sttModeFor()` makes every Arabic agent
  `accurate` (the `fast` 10 ms endpoint cut Gulf callers off). The dialect, the **live
  voice's** gender (`voices.gender`) and "say a phone number one digit at a time, as words"
  are `languageBlock()` (`modules/prompting/dialects.ts`), appended by `runtimePrompt` after
  the documents and before the §9.4 block — never stored, like the documents;
  `dialectSection()` puts the dialect in the generation and feedback turns. Gulf voices are
  `CURATED_VOICES` (`modules/voices/curated-voices.ts`), added per platform workspace by
  `pnpm --filter @portal/api voices:import` and **recognised by their platform name** (the
  platform lists them as `custom_voice_<workspace>` with no gender or accent); their clips
  are filed under `curated:<key>`. `captured-phones.ts` reads Eastern Arabic numerals and
  Arabic digit words. Saudi is ready; **UAE is not sold** until Emirati phone numbers
  transcribe (`pnpm --filter @portal/api proof:arabic`, ADR 0027 Consequences).
- **`language: "multi"` means Retell's fixed ten, not the customer's languages**, and fr-CA
  is not among them. The gateway sends the explicit locale array instead — §W3's text says
  `multi`, and ADR 0003 §6 is the decision that overrides it (reviewed 21 Sep 2026; a
  one-line flip in `AgentRetellService.agentSpec` if the spec owner rules otherwise). Agent
  locales are `retellLanguage` in `@portal/schemas` (validated, not cast); there is no `en-CA`.
- An unknown `voice_model` is **ignored silently** by Retell where every other stack id is a
  400, so `tierStack.voice_model` is validated against the SDK union in code.
- A `voice_model` from another provider than the voice is a **400** on `update-agent`, and
  omitting it keeps the stored one: `voiceModelFor()` sends the stack's model only with a
  voice of its provider (`voices.provider`) and `null` otherwise (ADR 0003, D9 addendum).
- A brief field sent as **`null` is cleared** (`briefPatch` in `@portal/schemas`, QA-006):
  `mergeBrief` deletes the key; arrays clear with `[]`. The W2 autosave sends `null` for a
  field emptied by the customer (`briefDiff`), flushes on unmount and guards `beforeunload`.
  A version still syncing to the platform answers `409 VERSION_SYNCING` on a test call (QA-021).
  **`BRIEF_INCOMPLETE` means the brief, nothing else** (QA-021 reopened, 26 Oct): an agent with
  no script is `409 AGENT_NOT_GENERATED` (test call, publish, activate, feedback), one never
  published is `409 AGENT_NOT_PUBLISHED` (resume, pointing a number at it). The portal shows
  `errors.<code>` first, so a code reused for another condition shows the wrong sentence.
  `activate` checks the version publish will take for a script before it queues anything.
- `PATCH /agents/:id/draft` does not touch the platform. `POST /agents/:id/test/web`
  re-syncs the unpublished draft (`AgentDraftSyncService`, shared with the generation
  worker) before minting, so a test call rings the voice and languages W3 saved.

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
- **The W6 area code is a preference, not a condition** (30 Sep: 647 and 236 answered
  `404 No phone numbers of this area code.` on staging). `purchaseAttempts()`
  (`modules/numbers/purchase-attempts.ts`) is the order: the code at Twilio (the platform's
  default carrier), then Telnyx, then the code's Canadian overlay (647 → 416, 437, 942) at
  both, then any local number at both. Only that 404 (`isNoNumberStock`) moves on; a 404
  buys nothing, so the walk cannot buy twice. Toll-free is never widened to local. The row
  records the carrier (`retell_telnyx` / `retell_twilio`) and the code actually bought;
  `requested_area_code`, written once at creation, keeps the one asked for, and W7's live
  page and D4 say so when they differ (`areaCodeSubstitute`, QA-076). All exhausted is
  `area_code_unavailable`, permanent, on attempt one.
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
  (`SIP_CREDENTIALS_LOCAL_KEY`, refused in prod) in dev/test; the plan id is the AAD. Three call
  sites: `PhonePlansService`/`NumbersService.import` seal, `importSip` opens on the stack
  immediately before `import-phone-number`, and D16's `SipVerificationService` opens (and seals
  new credentials only when the check did not fail).
- **SIP re-verify** (D16, `POST /numbers/:id/sip/verify`, owner/admin) is synchronous so a typed
  password never sits in a job payload: a lease on `phone_numbers.sip_verify_started_at` (90 s,
  `409 SIP_VERIFY_IN_PROGRESS`), 10 checks/h per workspace, one SIP OPTIONS digest-answered by
  `SipProbe` to the trunk's **public address only** (ports < 1024 refused), then — unless the
  trunk failed — `get-phone-number` + `updateSipTrunk` with the details. `answered`/`forbidden`
  = warning (reachable, password unconfirmed). The outcome is `sip_verification_json`, no secret. Nothing returns, logs or audits the plaintext;
  responses carry `has_password`.
- **The restaurant menu is a knowledge source with `role = menu`** (ADR 0020): the same
  row, body, validation, sync job and platform KB as any source, plus
  `knowledge_sources_agent_role_idx` (one menu per agent; a race is `409 CONFLICT`, a
  replace removes the old row first). Only a restaurant agent may hold one —
  `knowledgeRolesFor()` in `@portal/schemas` (`template_id` or `industry` = `restaurant`)
  is what the API refuses on (`400`, field `role`) and what the portal shows the Menu
  section from. The generation worker passes every pending/syncing/ready source to
  `knowledgeSection()`, which tells the model to answer from the menu and to say when a
  dish is not on it. The platform ingests documents, not images, so a **photo** (the menu
  slot, "Add a source", W2's documents) is read into text in the browser's flow first —
  `photoToText()` (`src/wizard/photo-text.ts`) → `POST /agents/:id/documents/extract` — and
  stored as a `text` source (ADR 0024). **Replace
  (DELETE then POST in the same second) is settled by the worker, not the portal**: a delete
  of the last synced source defers (5 s × ≤ 24, `-del-p<n>`) while a sibling is pending or
  syncing, and a sync whose base answers 404 mid-flight clears the stale `retell_kb_id` and
  retries — on the real platform the newcomer otherwise ended `failed` (ADR 0020 §2).
- Knowledge: one platform KB per agent (`agents.retell_kb_id`), `knowledge_sources.status ∈
{pending, syncing, ready, failed, deleting}`, file/text bytes held in `payload` only until
  ingested. Gated by `knowledge_base` and `caps.kb_allowance` (one KB per agent counts), ≤ 20
  sources per agent, files ≤ 20 MB, private hosts refused. A source that synced is deleted on
  the platform **before** its row (`deleting` + the `-del` job id). The platform will not
  empty a knowledge base, so the **last** source deletes the base and clears
  `agents.retell_kb_id`. The LLM is versioned with the agent (ADR 0003 §7), so a base
  attached after publish is invisible to the live agent until a publish: the sync that
  attaches one to an agent with a `published_version` marks the source
  `sync_json.republish` and, once `ready`, calls `publish(…, published_version,
  {refresh: true})` — same version of ours, new platform version (ADR 0024). The
  republish is outside the sync's `try` and a throw keeps the mark for the retry.
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

**Outbound click-to-call (D18, ADR 0031)**

- **Outbound is a callback.** `POST /calls/:id/callback` rings the other party of a D2 call;
  no route takes a typed destination. Every gate is `decideOutbound()`
  (`modules/outbound/outbound.decide.ts`, pure, one order) and `GET /calls/:id/callback` is
  the same verdict without placing. A refusal writes `audit_log` `call.outbound_blocked`
  (reason, number masked to `+1••••••••23`, request id) and **nothing else** — no
  `outbound_calls`, `calls` or ledger row, no platform request. Test calls ("Call my
  phone", forwarding test) are not outbound in this sense and are not gated.
- **KYC and caller-ID verdicts are staff's.** `tenants.kyc_status` (customer may only set
  `pending`) and `phone_numbers.caller_id_verified_at` are refused from `portal_app` by the
  `guard_outbound_verdicts` trigger, not only by the service. A bought number is verified at
  `bind` (`via = purchase`); a SIP import only by staff; `via = staff` is never overwritten.
- **The daily cap is a row count under a lock**, not Redis: `pg_advisory_xact_lock('outbound:<ws>')`,
  `outbound_calls` of the workspace-local day in `pending|placed`, idempotency key re-read
  under it. A provider failure marks the attempt `failed` (uncounted) and frees the `MintSlot`.
- **The calling window holds in every zone of the destination's country**
  (`outbound.countries` in the pricing config; US 8–21, CA 9–21:30 / weekends 10–18). Never
  model DST — each zone's wall clock via `localClock`. No rule = not callable.
- **No national DNC registry**: a callback needs an inbound call from that number within
  `outbound.prior_contact_days` (90); the workspace's `dnc_entries` and the platform's
  `blocklists` (type `phone`) apply on top. Legal sign-off is pending (ADR 0031 §3–§4); the
  `outbound_calls` flag stays at 0 % until then.
- Billing is the ordinary path: published version at the live tier rate, `call_ended` bills
  once on `call_id`; the API pre-writes the `registered` row (`recordOutboundPlaced`).
- **No answer from the platform is not a failure** (ADR 0031 addendum). Only a 4xx marks
  an attempt `failed`. A timeout, a reset or a 5xx leaves it `pending` (`unconfirmed`), and
  its key answers `OUTBOUND_IN_PROGRESS`, because the person may be ringing. The first
  lifecycle event carrying `metadata.outbound_id` binds the attempt to its call
  (`bindOutboundAttempt`). A `pending` attempt with no call stops counting after
  `UNCONFIRMED_ATTEMPT_MS` (5 min), and the next claim writes it off. The `MintSlot` line
  is taken **before** the claim, so a lost race writes no `outbound_calls` row. The
  callback carries the caller ID's `transfer_number_N` and fail message
  (`numberTransferVariables`, the same reader the runtime cache and "Call my phone" use).

**Knowledge use (D16, ADR 0028)**

- `calls.kb_retrievals` / `kb_hits` / `kb_usage_json` come from the `call-knowledge` job (`calls`
  queue, `kb-<call_id>`), queued by `call_ended`/`call_analyzed` when the payload shows a knowledge
  look-up. It re-reads the signed retrieval-file URL from the stored webhook (never a job
  payload), writes the count first, then attributes passages by the 8-hex row id our sync puts in
  file names and text titles (`kb-usage.ts`). SET, never incremented; a complete row is never
  downgraded. It owns no credits. `GET /agents/:id/knowledge/stats` aggregates real callers only.

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
  token, key or secret; the log sender logs recipient (masked) and subject only. **The D6
  invitation email** is the one message with a link that must work: `deliver({secrets})`
  fills `{invite_link}` into the copy handed to the sender only, the row keeps the
  placeholder (`one_time_secret`), and `retryFailed()` writes such a row off instead of
  mailing a dead link — the inviter resends (new token, new row `invite:<id>`). Senders:
  Resend when `RESEND_API_KEY` is set, else SMTP (`SMTP_HOST`/`PORT`/`USER`/`PASS`, e.g. a
  Gmail app password on a dev box), else the log. Mail is always *from* `EMAIL_FROM`; the
  invitation's `replyTo` is the inviter. The e2e config blanks all of them, so a test never
  mails anyone.
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
- The `auto-topup` sweep closes a pending top-up whose PaymentIntent Stripe has no record of
  (`resource_missing`) as `abandoned` / `payment_intent_not_found`, quietly — no customer
  alert — as Checkout does a missing session; only an outage is retried (ADR 0032 §8).
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
  multi-factor, and customer two-factor is opt-in through `customer-post-login.js`
  (tenant MFA policy "Never", One-time Password + recovery codes enabled; the Action
  challenges on that request and on every interactive sign-in of an enrolled person,
  never on a refresh grant; status = the `https://portal/mfa_enrolled` ID-token claim or
  `amr` `mfa`); A6 is Auth0's `dbconnections/change_password`. **The return path survives
  sign-in** (QA-001): the callback only cleans `/`'s address and hands the validated
  `appState.returnTo` to `RootPage` as `auth.returnTo`, which `router.replace`s there
  (rewriting the URL with `replaceState` left `/` mounted and its gate sent everyone to
  `/app/`); `RedirectIfSignedIn` honours `?next=`, and the workspace switcher carries it.
  **One workspace switch** (QA-013): `useSwitchWorkspace()` in `workspace-switcher.tsx` is
  what the header switcher, the account menu (`WorkspaceMenuItems`, shown only with more than
  one membership — `accountMenuWorkspace()`) and /select-workspace call; it lands on the
  page's `?next=` or `/` (`switchWorkspaceDestination()`), never the old workspace's page.
  `safeNext()` is the one validator — same-origin paths only, no `//`, `\`, control
  characters or `/login`/`/signup` targets; `signedInDestination()` picks return path over gate.
  **An invite survives sign-up and verification too** (BUG-008): `?next=` rides the
  login ↔ signup links and `RequireVerified` → `/verify-email?next=`, and the invite page
  remembers itself (`pendingInvite`, localStorage, `/invite/?token=` paths only, 7 days)
  while it cannot be accepted, for what a query string cannot cross (the confirmation
  link in a new tab, "Sign out" to switch address). `/` prefers `returnTo`, then that,
  then the gate; the join screen clears it. Nothing accepts without the click.
- Gating is `useSessionGate()` + `RequireAuth` / `RequireVerified` / `RequireWorkspace` /
  `OnboardingStepGuard(step)` / `AppGuard`. A wizard page W-k is allowed while
  `k ≤ onboarding_step`; the portal advances the step with `POST /workspace/onboarding-step`
  (editor and up — editors build, test and route the agent; `PATCH /workspace` is settings,
  owner/admin, and its 403 used to bounce an editor back to W1, QA-005), never backwards
  (the server's conditional update refuses to as well, and `PATCH /workspace` no longer
  takes `onboarding_step` at all, QA-058), single-flight; a guard never redirects while the workspace row is refetching.
  `LAST_IMPLEMENTED_STEP` is 7 since D9, so `/app` opens only once `onboarding_completed_at`
  is set (the activation job's `mark_live`). **W4 is after payment** (ADR 0024):
  `ONBOARDING_STEPS` is 1, 2, 3, 5, 6, 7 (4 unused, `stepPath(4)` → W5), W3 advances to 5,
  and `WIZARD_STEPPER` draws knowledge as the last dot. `/onboarding/knowledge` and
  `/onboarding/live` sit outside the steps behind `LiveGuard` (onboarding complete, else
  back to the step); a live activation (and W7's `completeRedirect`) goes to knowledge,
  whose Continue goes to live.
- **Colours are tokens.** `bg-card`, `text-muted-foreground`, `border-border`, `bg-primary`…
  from `frontend/ui/src/styles/globals.css` (`:root` and `.dark`), derived from the five
  Oraly brand colours — Purple `#7B5CFF`, Electric Blue `#22D3EE`, Deep Navy `#0A0F1A`,
  Slate `#1E2433`, Soft White `#F7F8FB` (`docs/brand.md`). No `bg-white`, `text-neutral-*`,
  `dark:` overrides or hex values in components; a component that needs a new colour adds a
  token pair (`text-warning-emphasis` / `text-success-emphasis` are warning / success as
  text on an ordinary surface — never `text-warning-foreground dark:text-warning`; purple
  text on a `bg-primary/…` tint is `text-accent-foreground`). `--primary` is a shade of
  the brand purple chosen for WCAG AA (`#7050F5` light, `#9580FF` + navy text dark — ADR
  0025 addendum), and the base `:focus-visible` rule is a visible ring: never set it back
  to `outline: none`. `ThemeProvider` / `ThemeToggle` / `ThemeSegment` are the only theme code, and
  the logo is `Logo` in `@portal/ui`, rendering the supplied artwork from
  `public/brand/` — never redrawn, recoloured or rebuilt inline.
- **W3 offers `agentLanguage`** (ADR 0027): the Gulf Arabics first when the portal is in
  Arabic, after the launch set otherwise (`sortedLanguages(locale)`). The script is written
  on W2, before the language exists, so `VoiceSettings` (W3 + the D3 Voice tab) offers
  "Rewrite in <language>" — W2's regenerate — when the draft's greeting is not in the main
  language (`scriptNeedsRewrite`, `src/wizard/script-language.ts`); never automatically. The
  worker refreshes `voices` on boot while a curated voice is missing from it.
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
- Every user-facing string is a key in `src/i18n/messages/en.json`, `ar.json` **and**
  `fr-CA.json` (`useTranslations`); `src/i18n/messages.test.ts` fails on a key, placeholder
  or tag in one and not the others, a line that does not format under its locale's plural
  rules (ADR 0026), or a straight apostrophe before `{`/`}` (ICU quotes the placeholder) —
  French uses `’` throughout. Write a one-word plural branch as `# time`, never `{once}`:
  the placeholder check reads it as an argument. French is Québécois, vouvoiement, sentence
  case, one glossary (ADR 0030 §3: pack → forfait, plan → formule, brief → fiche, email →
  courriel); the locale id is `fr-CA` everywhere, and `matchLocale()` gives a `fr-FR` browser
  the Canadian catalogue.
  The language is per browser (`portal:locale`, `LocaleProvider`), applied to `<html lang
  dir>` before paint by `localeBootScript`; no locale in the URL. `lib/format` and every
  `Intl` call use `activeIntlLocale()` (`ar-u-nu-latn`: Western digits), never the browser's.
  Text the API sends in English (template names, lint findings, analysis fields,
  disconnection reasons) goes through `useServerCopy()`, by id, never translated in place.
- **Right to left is logical CSS.** `ms-/me-/ps-/pe-/start-/end-/text-start/text-end`, never
  `ml-/mr-/pl-/pr-/left-/right-/text-left/text-right`; `@portal/ui` labels and direction come
  from `UiLocaleProvider` (Radix `Direction.Provider` inside). Directional lucide icons are
  mirrored by one rule in `globals.css`; phone/email/URL inputs stay LTR; free text is
  `dir="auto"`. The console has no provider and is English, left to right.
- Analytics: `track()` from `src/analytics/posthog.tsx` only; ids, step names and counts,
  never brief text, emails or phone numbers. **No URL reaches PostHog with its query or
  fragment** (QA-008: invite tokens, `code`/`state`, `session_id`, view-as keys):
  `sanitizeCapture` (`src/analytics/sanitize.ts`) is `before_send` for every event and
  person property, another site's URL keeps only its origin, and `/flags`, session replay
  and heatmaps are off — they carry URLs `before_send` never sees.
- Retell is never named; say "voice", "what your agent knows".
- Local run without the Auth0 tenant: `pnpm dev:issuer`, then the API with
  `AUTH0_CUSTOMER_DOMAIN=http://localhost:9999` and the portal built with
  `NEXT_PUBLIC_AUTH0_DOMAIN=http://localhost:9999`. The wizard check is
  `pnpm --filter @portal/web e2e:wizard` (headless Chrome with a fake microphone, 60
  assertions: a real Generate, a real W5 test call with live transcript and after-call
  card, a real feedback patch, W6 persistence, the W7 Stripe redirect and cancel/unpaid
  returns). It stops before paying: activation buys a real number.
- **`/embed/` runs on strangers' sites** (D17 §11.5, ADR 0029): `Providers` gives it theme
  and language only — no Auth0, workspace or PostHog — and its API client sends no token.
  `public/widget.js` (hand-written, no build) frames it from the portal's origin and only
  takes `{type: 'oraly-widget:size'}` from that frame. Unframed (D3's "Preview") it shows
  the button and places no call. The public mint refuses a request whose own `Origin` is
  not the portal's (`ORIGIN_NOT_ALLOWED` — only our frame calls it); the allow-list is a
  browser control, not authentication, and a script holding the key is bounded by the
  budgets and the wallet only. The per-visitor window (IPv4 address or IPv6 /64,
  `clientBucket`) is counted before the per-widget one.
- **Every call we mint takes its line before the platform is asked** (`MintSlot` in
  `modules/calls/call-headroom.ts`): the browser test, "Call my phone", the forwarding
  test and the widget write a `mint:<uuid>` placeholder through `reserveActive()` (the
  inbound path's `RESERVE_SCRIPT`, the one writer of a reservation ahead of
  `call_started`), move it to the call id with `HSETNX` once minted, and free it on a
  refusal. A lost race is the ordinary `CONCURRENCY_LIMIT` / `NO_CREDITS`
  (`WIDGET_UNAVAILABLE` on the widget), with nothing minted. A self-minted call's ceiling
  is the balance alone; inbound passes balance + grace. The §13.4 10/h window
  (`assertUnderTestWindow` / `countTestCall`) is shared by all three test mints. CloudFront's `/embed/*` behaviour is
  the one path without `X-Frame-Options`. The D3 Website tab (`AGENT_TABS`) holds the
  snippet; "Call my phone" sits in `TestCallPanel` once `last_pack_credits` is set; D4's
  Forwarding section has "Test forwarding" (`ForwardingTestPanel`, polls while `calling`).
- W5 test calls: `useTestCall` gives `RetellClient` a `fetch` that answers create-web-call
  from `POST /agents/:id/test/web`, and replaces `client.api.monitorSocket` so only the
  live-transcript socket goes to our relay (`${apiUrl}/test-calls/v2/monitor-call/:id`)
  while WebRTC signalling stays on the platform (ADR 0003, D9 addendum). Every await in
  `start()` is followed by `TestCallLifecycle.isActive(run)` (QA-017): a microphone answer
  after the page left stops its tracks and mints nothing, a mint that returns after it is
  never joined (unjoined = `error_user_not_joined`, billed zero), and unmount hangs up
  whatever session is held. W7 remembers the
  started checkout in `checkoutMarker` as a hint only; paid is whatever the activation says.
  Back from Stripe it posts the URL's `session_id` to `POST /wallet/checkout/confirm` once
  on mount and again on "Check again", so a late or lost webhook cannot strand a paid
  customer on "Confirming your payment"; the page still shows only what the activation says.

**Dashboard (frontend/web `/app` — ADR 0018)**

- **D3 is `/app/agents/detail/?id=&tab=` and the D2 detail is `/app/calls/?call=`** — the
  spec's `[id]` segments flattened for the export like `/invite/?token=`. Build them with
  `agentPath()` / `callPath()` in `src/routes.ts`, never by hand. `AGENT_TABS` is the
  tab order.
- **D2 state is the URL** (`useUrlQuery` + `calls-url.ts`): status, agent, channel, test,
  handled, range, sort, order, cursor and the open call. A component never holds its own
  copy. Range presets are instants from the workspace timezone's local midnight
  (`startOfLocalDay`), the same days `GET /stats` uses. Pages are the §16 cursor plus the
  API's `total`.
- **One SSE subscription per page, on every topic** (`useDashboardLive`): a `call:{id}`
  topic cannot be subscribed to before the id exists. Frames only invalidate queries
  (`listCalls`, `getStats`, `getCall`, `getWallet`, `listActiveAlerts`, `getAgent`),
  folded 400 ms; the new-call toast fires once per call id, on the first `registered` /
  `in_progress` / `missed` frame, and never for `is_test` or a `web` channel. The first
  frame carries `from_number`, `agent_id`, `channel`, `direction`, `is_test` for that.
- `GET /calls` sorts server-side (`sort`, `order`, nulls last, `created_at`+`id` tiebreak)
  and returns `total`; `callSummary.sentiment` is read from `analysis_json` on the server.
  The cursor is an explicit keyset predicate (`afterPosition()`), **not Prisma's `cursor`**:
  a tuple compared against NULL is NULL, so a cursor row in the null tail (a missed call)
  made the next page empty. A cursor naming a row this workspace cannot see is
  `400 INVALID_CURSOR`. The portal carries a 1-based `page` beside `cursor` in the URL and
  keeps the walked cursors in `sessionStorage` per filter, so a pasted or reloaded page
  labels itself right and can step back.
  Bulk handled is `PATCH /calls {ids, handled}` → `{updated}` (rows now in that state,
  foreign ids silently unmatched). Export is `POST /calls/export` → streamed `text/csv`,
  500 rows per `withWorkspace`, 10 000 rows max, formula-safe cells; the client helper is
  `exportCalls()` (hand-written — `client: false` in the manifest).
- The Advanced editor lints through `POST /agents/:id/versions/:v/lint` (same
  `lintPrompt`, guardrails appended, nothing written) and saves through
  `PUT …/versions/:v/prompt`. It edits `editable_prompt` only; the §9.4 block is shown
  read-only. Unsaved edits survive a background refetch and warn on `beforeunload`.
- `BriefFields` and `VoiceSettings` (`src/components/wizard/`) are the W2/W3 bodies and the
  D3 Brief/Voice tabs at once. Change a field there, not in a page.
- **The script is editable on W2 too.** Once the draft has a prompt, the Generate panel shows
  "Edit the script", which opens `PromptTab` (the D3 Advanced editor, same lint and
  `PUT …/versions/:v/prompt`) in a section under the brief; it stays mounted while hidden
  so edits survive "Hide", and Continue is disabled while it holds unsaved edits
  (`onDirtyChange`). `WizardHeading`'s subtitle is a `<div>`: `AgentContextBanner` is a
  `<p>`, and `<p>` inside `<p>` is a hydration error.
- **The category is `agents.template_id` + `agents.industry`, shown wherever the agent is
  edited** (ADR 0020 §1): `AgentContextBanner` under the W2/W4 headings, `TemplateBadge`
  in the D3 header, the template's `example_texts` as the W2 placeholder
  (`useBriefPlaceholders`). W1 warns through `industryConflicts()` when the industry is
  not one the template was written for and never refuses; the workspace name is never
  read as a category. `MenuUpload` appears where `knowledgeRolesFor(agent)` says so.
  Exit check: `pnpm --filter @portal/web e2e:restaurant` (same stack as `e2e:wizard`,
  plus `DASHBOARD_SUB` for the D3 part).
- Tables drop secondary columns below `sm` (`hidden sm:table-cell`) instead of carrying a
  `min-width`: Chrome sizes the mobile layout viewport from a table's minimum width even
  inside an `overflow-x-auto` wrapper. The 30-day chart is inline SVG, one series, one hue.
- D10 exit check: `pnpm --filter @portal/web e2e:dashboard` against the export, the API
  and worker it was built for, and the local issuer minting the owner of a **live**
  workspace (`docs/decisions/0018-customer-dashboard.md`, Consequences).
- **The dashboard has one SSE stream, opened by the shell** (`DashboardLiveProvider` in
  `PortalShell`, ADR 0019 §1). `useDashboardLive()` registers a page's `onNewCall` and
  returns the state; it opens nothing. A `wallet` frame's `balance_after` is written into
  every `getWallet` cache entry (the pill and D5 move on the frame) and then re-read;
  `walletFrame()` refuses anything without a finite number and an older frame never
  overwrites a newer balance. Nothing else subscribes to `GET /events` under `/app`.
- **Screens under `/app` listen on the shell's stream, they do not open one** (QA-031):
  `DashboardLiveProvider` fans its frames out through `event-bus.ts`, and
  `useLiveEvents()` (`src/dashboard/use-live-events.ts`) registers a topic listener there;
  outside the shell (the wizard) it opens its own stream exactly as `useWorkspaceEvents`.
  Generation, feedback and the after-call card use it.
- **The stream closes on `pagehide` and reopens on a persisted `pageshow`** (ADR 0019
  §2): a document in Chrome's back/forward cache keeps its fetches, six cached dashboard
  documents held the six HTTP/1.1 sockets a host gets, and the seventh page's first
  request hung for ever. `sse.test.ts` pins the abort. Keep `openWhenHidden: true`.
- **Below `lg` the nav is a bottom tab bar** — Home, Calls, Agents, Numbers, More (a
  bottom sheet with Wallet, Settings, Help) — padded for `env(safe-area-inset-bottom)`
  (`viewportFit: 'cover'`), with `<main>` padded to match. The pill lives at the foot of
  the desktop sidebar and compact in the phone header. No hamburger sheet.
- **A list is `DataTable`** (`src/components/dashboard/data-table.tsx`): the table at
  `sm`+, cards below, both rendered and CSS picks. A column names its card slot (`title`,
  `subtitle`, `badge`, `field`, `actions`); nothing important is hidden on a phone. D2 and
  D3 keep their bespoke tables and carry their own card lists. A destructive action is
  `ConfirmDialog` (consequences, optional typed confirmation, busy state). Role gating in
  the UI is `useRole()`; the API enforces it again.
- **D4 is `/app/numbers/?id=&tab=`** (`numberPath()`, `NUMBER_TABS`; Forwarding only for
  a forward target, SIP only for SIP). `useUrlQuery` observes same-route
  `pushState`/`replaceState` (dispatched on a microtask — inline crashed React) so the
  tab bar's Numbers closes an open number; list ↔ detail go through `NumbersNavContext`.
  Routing, hand-off and callers are `PATCH /numbers/:id` (editor+); release is
  owner/admin with the number typed. SIP is read-only (`sip.host`, masked username,
  `has_password`) — provider identity is not on the PATCH shape. D6 is
  `/app/settings/?tab=` (`SETTINGS_TABS`); the audit tab is owner/admin only.
- **What the dashboard does not offer, on purpose** (ADR 0019 §8): payment methods are
  the Stripe Customer Portal only; deleting a workspace is a request staff carry out
  (§17 job; the button files it, ADR 0032 §6); status page and support chat are `NEXT_PUBLIC_STATUS_PAGE_URL`
  (`https:` only, optional) and `NEXT_PUBLIC_SUPPORT_EMAIL` (default `support@oraly.ai`)
  in `src/config.ts`; SMS and the weekly summary have no sender and are not shown;
  Help's status is `GET /health/ready`. Pricing copy on Help comes from `GET /pricing`.
- The balance pill is amber under 20 % of the last pack and red at or below 0
  (`balanceTone()`, §7.2), 20 credits before the first pack.
- D11 exit check: `pnpm --filter @portal/web e2e:dashboard-d11` (124 checks incl. every
  screen, tab and dialog at 390 px) after `e2e:dashboard`, same stack. The D10 suite
  needs its `d10seed_*` calls and ≥ 6 versions on the live workspace's agent.

**Admin console (admin spec §2–§10 — ADR 0021, D12)**

- `/admin/*` is verified against the staff tenant only and a staff token needs the
  `https://portal/mfa` claim (`AuthGuard`); `@StaffRoles(...)` is the admin §2.2 matrix per
  route and `StaffLimitsService` reads `staff_role_limits` on every write (`403
  STAFF_LIMIT_EXCEEDED`, naming who could). Support pauses a workspace only with a ticket
  that exists and belongs to that workspace.
- **Every customer-affecting staff write carries a `staffActionRequest`** (`reason_code`,
  note required for `other`, optional ticket) and lands in `staff_audit_log` **inside the
  write's transaction** (`StaffAuditService.record(input, tx)`: staff, `<area>.<verb>`,
  target, workspace, reason, redacted before/after, IP, request id) plus the workspace's own
  `audit_log` row with `actor_user_id = NULL`, `meta.by = 'staff'`. No audit row, no write.
  That includes `DELETE /admin/flags/:key` (a body on a DELETE, `api.del(path, schema,
  {body})`), both directions of a kill switch, starting a view-as session, a flag save,
  pricing publish / rollback / draft discard (`DELETE /admin/pricing/draft` takes a body
  too) — none of them defaults the reason, and the console never pre-selects one: every
  reason picker starts empty and the button stays disabled until one is chosen (QA-035,
  QA-039, QA-041). The draft save and the cost inputs carry no reason but still audit in
  their own transaction. A write that ends in something no transaction can hold — a
  queue enqueue, a webhook replay, the identity provider after a force logout — records
  its request in the transaction and the outcome as a second row (`job.retry_failed`,
  `webhook.replay_requested` → `webhook.replayed`, `user.force_logout_provider[_failed]`,
  `user.lock_provider_failed`, `job.discard_requested` → `job.discard_failed`). A job
  discard records its request **before** removing the queue job, and a removal the queue
  refuses is a `409` with the row left as it was — never "discarded" with the job still
  queued (QA-038). A lock whose session revoke the provider refuses still locks and answers
  `provider_error` (QA-042).
  `redact()` blanks credential-named fields (`secret`, `password`, `token`, `api_key`…),
  never the substring `key`: a flag's `key` and an `idempotency_key` are identifiers.
- **Pause is one rule at every level** (QA-034): workspace, agent and number pause all
  take `can_pause_tenant` (`StaffLimitsService.assertCan`) and, for support, a ticket of
  that workspace (`assertPauseTicket`); resume takes the capability, no ticket. A staff
  resume puts an agent back to what it was: `live` when published, `draft` when it never
  was (QA-043; the customer's own resume still refuses an unpublished agent).
- **One staff role matrix** (QA-048): `STAFF_ROUTE_ROLES` in `@portal/schemas` is what the
  controllers spread into `@StaffRoles` and what the console's `can()` checks, **and**
  `can()` checks the `staff_role_limits` on top — a limit ticked in SA13 for a role the
  route refuses never enables a button that answers `403 FORBIDDEN_ROLE`.
- **A stored webhook body is a logged read** (QA-033): `GET /admin/webhook-events/:id`
  is not read-only's, recording links, transcripts, the call log and the call summary are
  blanked (`webhook-payload.ts`) unless the role has `can_listen_recordings`, and every
  view writes `webhook.payload_viewed` (outcome and field names, never values). The list
  and the replay answer carry no body.
- **A webhook event's customer is `webhook_events.tenant_id`**, written by
  `WebhookEventsService.attribute()` after the handler (queue and SA12 replay): for a call,
  the workspace `calls` billed it to, on every row of that call still without one (a transfer
  event stored before the row is named when `call_ended` lands); Stripe, our metadata else the
  object's customer. The SA12 list, the Customer 360 Webhooks tab and the replay audit read
  it first and the payload (`webhookTenantHint`) only for a row not attributed yet. The
  payload alone showed "–" for a fail-open or recovered call billed through the agent /
  number fallback (ADR 0021 addendum, 27 Oct).
- Reads cross workspaces on `adminDb`; writes reuse the customer path's services: credits
  through `WalletService.withWallet` (a `credit_adjustments` row references the ledger row,
  same transaction), pause/resume through `runtime-cache.refresh`, switches through
  `PlatformConfigService.setKillSwitch`, replay through `WebhookProcessingService.replay`
  (the handlers are idempotent — that is what makes a replay safe), retry through
  `JobQueues` with the payload `jobs.payload_json` kept by the two enqueue sites.
- **Pricing publish is insert-unpublished → Stripe sync → effective → archive.** The new
  `pricing_configs` row starts with `effective_at = NULL` (never served); `StripePriceSyncService`
  runs the pure `planPriceSync()` (reuse / create / archive, Products keyed by `pack_id`
  metadata, Prices found by lookup key `<env>_pack_<id>_<currency>_v<n>` — one test account serves several environments — before they are created,
  rows persisted as Stripe answers); a failure keeps the version unpublished with the error in
  `stripe_sync_json`, keeps the draft and answers `503 STRIPE_SYNC_FAILED` — publishing again
  resumes that version. Success sets `effective_at` in one transaction with the audit row
  and the draft's deletion, then `invalidateAll()`; `GET /pricing` is the new version on the
  next request (the 60 s SLA is the TTL's bound on a missed drop). **The sync archives
  nothing**: the Prices it supersedes are what checkout sells until the flip, and a sync
  that archived them and then died left every purchase failing on an inactive Price.
  `archiveSuperseded(current)` runs after the flip (and at the start of the next publish or
  rollback, for a version dated ahead) and archives, on Stripe and in `stripe_price_map`,
  only rows of *earlier effective* versions the current one does not sell. The plan is
  always against the version in effect **now** — a rollback planned against its target's
  own rows copied Price ids the abandoned version had archived. `apply_now` caps are refused
  with a future `effective_at` (they would move every tenant's caps today). Blockers: a pack bought in
  the last 12 months cannot be removed; a tier under the margin floor (`retell_cost_inputs`)
  is `422 MARGIN_FLOOR` unless a super admin overrides with a note. Rollback inserts a new
  version with the old config; history is never rewritten. **Rollback takes publish's
  checks** (`blockersFor` + `assertPublishable`, one function for preview, publish and
  rollback, QA-040) and a rollback whose sync failed resumes its unpublished version
  through `pendingOrNewVersion` instead of adding an orphan per attempt. A keyless dev box records
  `skipped`, never `synced`.
- **View-as is an API-minted credential** (`ImpersonationTokenService`, `imp_<payload>.<hmac>`,
  `IMPERSONATION_SIGNING_SECRET` → `RECORDING_SIGNING_SECRET`), one hour, one open session per
  staff member and workspace. On the customer namespace `AuthGuard` reads the session row on
  every request and makes the request look like the workspace owner; `WorkspaceGuard` pins the
  workspace, refuses every non-GET with `403 IMPERSONATION_READ_ONLY` and refuses recordings.
  The only write allowed is `POST /impersonation/end` (`@AllowImpersonationWrite()`). Portal:
  `/impersonate/#session=&key=` (the fragment — a query string reaches CloudFront and S3
  access logs, and the key is an hour of customer reads) keeps it in sessionStorage,
  `POST /admin/impersonations/:id/open` re-mints the link for the console banner once the
  portal tab is gone, `AuthProvider` never touches Auth0
  under it, `ImpersonationBanner` sits in `Providers` above every screen. Both ends are audited
  (`impersonation.started` / `.ended`, `ended_via`), and so is every re-minted key
  (`.reused` for "View as" on an open session, `.reopened` from the banner). Act-as is P2 and has no code path.
- SA3 actions go through `Auth0ManagementService` (customer tenant, `AUTH0_CUSTOMER_M2M_*`) and
  our row: `users.locked_at` is what `AuthGuard` refuses with `403 ACCOUNT_LOCKED`. Unconfigured
  answers `provider: skipped`, never a silent success.
  **Force logout and lock set `users.sessions_revoked_at`**, and `AuthGuard` refuses any token
  issued before that second (401), so a logout ends the session already in a browser, provider
  or no provider; the portal signs out on a 401. Force logout revokes locally **first**; an
  identity-provider failure is `200 {provider: 'failed'}`, not a 503. The customer M2M app needs
  `delete:guardian_enrollments` `delete:sessions` `delete:refresh_tokens` (runbook §1).
- Credit adjustments take an `idempotency_key` (the console makes one per opened dialog; it is
  the adjustment id): a double click, a retry or a second tab moves credits once. A ticket number
  is linked only when `support_tickets` holds it and is otherwise kept in the audit row. The
  per-day cap is checked again **inside the wallet transaction under a per-staff advisory
  lock** (`staff-credit-adjust:<staff id>`, taken after the wallet lock — always wallet →
  staff), so one person adjusting two workspaces at once cannot pass it twice (QA-037).
- **SA9 billing (D13, ADR 0022).** `GET /admin/purchases` (+ `:id`), `POST /admin/purchases/:id/refund`,
  `GET /admin/topups/failed`, `POST /admin/topups/:id/retry`, `POST /admin/customers/:id/auto-topup/disable`,
  `GET /admin/billing/summary`. **A refund is claim → Stripe → settle**: a `refunds` row
  `pending` whose id *is* the request's `idempotency_key` (+ `purchase.refund_requested`, in the
  tx), then `StripeGateway.refundPaymentIntent` with idempotency key `refund-<row id>` (a thrown
  error marks the row `failed` + `purchase.refund_failed` and answers `503 UPSTREAM_UNAVAILABLE`;
  the same key retries the same row — claimed only while still `failed`, `refunds.attempts`
  bumped, the Stripe key `refund-<id>-r<n>` because Stripe replays a stored error under the old
  one for 24 h, and `StripeGateway.findRefund` asked first for a refund carrying our row id, so a
  timeout that did reach Stripe is adopted rather than refunded twice), then under `WalletService.withWallet` a `refund` debit
  (`ref_type = refund`, `ref_id = <refund id>`, pre-checked under the lock so a retried settle is
  a no-op; ADR 0010 overdraft applies), the row `succeeded`, `purchases.status = refunded` when
  Σ refunds == amount, the workspace `audit_log` row and `purchase.refunded`. Credits reversed =
  round2(credits × amount / amount_cents). A repeat of a succeeded key answers the detail with no
  Stripe call; a key reused on another purchase is 409. Role cap is `refund_max_cents` **per
  purchase** — this refund plus what is already refunded or in flight on it, whoever issued it
  (`StaffLimitsService.assertRefund`: null = unlimited, 0 = cannot — out of the box only finance
  and a super admin can refund). **A `refund` debit does not run the auto top-up listener** (it
  would charge the card just refunded; the 15-minute sweep evaluates later). The staff retry is
  `AutoTopupService.evaluate(ws, 'staff', {ignoreCooldown: true})` — the only cooldown bypass,
  never a bypass of in-flight / disabled / no card / threshold, and credits still come only from
  Stripe's confirmation. Disable goes through the same `writeSettings` the customer's PUT uses.
  Plan tier is not recomputed after a full refund (spec silent). Exit check:
  `test/d13-billing.e2e.test.ts` (13 cases, gateway stubbed).
- **SA13 staff & settings (D13).** `staff_users` rows are managed from the console
  (`/admin/staff`, super admin + `can_manage_staff`): an invite creates the row with the
  placeholder `auth_provider_id = invite|<email>` and `AuthGuard.authenticateStaff()`
  binds it to the real `sub` on the person's first request — matched on the
  `https://portal/email` claim the staff Post-Login Action now stamps (redeploy the
  Action: `pnpm auth0:deploy staff`), bound atomically with `updateMany` on the placeholder,
  so a second identity for the same email is refused. The row is read on every request,
  so `active = false` refuses the very next call. Nobody changes their own role or
  deactivates themselves, and the last active super admin is never demoted (409). The
  admin §2.2 matrix is `GET|PUT /admin/staff/limits`, five rows in one transaction,
  audited whole (`staff.limits_updated`); `super_admin.can_manage_staff` must stay true.
  `STAFF_ALLOWED_EMAIL_DOMAIN` is read in one place (`staffEmailDomain()`); unset, the
  inviter's own domain is used. `mfa_enforced` is informational: the claim is required of
  everyone. SA7's provisioning queue (`GET /admin/provisioning`, the `jobs` rows of
  `activate-agent` / `provision-number` / `knowledge-sync` with the pure `activation-state`
  view) and `GET /admin/concurrency` (the `active:{ws}` hashes against `caps:{ws}`; `live:
  null` and `complete: false` on a Redis outage, never zero) are the Telephony page's two
  extra tabs. Exit check: `test/d13-staff.e2e.test.ts` (14 cases).
- Local console sign-in without Auth0: `pnpm dev:issuer:staff` (port 9998, stamps the MFA
  claim), API with `AUTH0_STAFF_DOMAIN=http://localhost:9998`, `pnpm db:seed` creates the
  matching super-admin row. Exit check: `pnpm --filter @portal/api test:e2e` →
  `test/d12-admin.e2e.test.ts` (26 cases: the boundary, limits, audit rows, credits, pauses,
  users, jobs, webhooks, flags, the pricing publish/failure/resume/rollback, view-as).
- **SA4 support tickets (D13)** live in `modules/admin/admin-support.service.ts` on the
  D2 `support_tickets` / `ticket_messages` / `canned_responses` rows (canned responses:
  six starters from `seed-data/canned-responses-v1.ts`, only into an empty table, then
  managed from the composer's `CannedResponsesDialog`, QA-049), and the customer's
  side in `modules/support` (`POST/GET /support/tickets`, `POST /support/tickets/:id/messages`,
  all inside `withWorkspace` — the `ticket_messages` RLS policy is what hides an internal
  note from the customer, not the response shape). Ticket ids are integers; anything else
  in a path is a 404. The SLA clock is one constants object, `support-sla.ts` (first
  response 4 h, urgent 1 h; resolution 3 business days, weekends skipped). A staff public
  reply sets `first_responded_at` and moves open → pending; a customer message reopens
  pending/resolved; closed refuses replies (409) but takes internal notes. Opening a
  ticket, replying, noting and PATCHing are audited (`ticket.created|replied|noted|updated`)
  without a reason code — none of them moves money or changes what a caller hears. **The
  macros do, and carry `staffActionRequest`**: `comp_credits` and `refund_call` go through
  `AdminCustomersService.adjustCredits` with `ticket_id` set and an idempotency key derived
  from the ticket (`derivedUuid('ticket-<id>-comp-<client key>')`; a replayed comp posts no
  second line or audit row) or from the call (`refund-call-<ws>-<call_id>` — a second refund of
  the same call from **any** ticket is `409 CONFLICT` naming the first), `rerun_activation`
  through `ActivationService.start` for the workspace owner (`409 CONFLICT` with no
  generated agent, `409 ACTIVATION_IN_PROGRESS` while one runs; finance is refused). Each
  appends a `system` message and audits `ticket.macro.<name>`. The admin module now imports
  `activation` for that one call; nothing else does. Console: `/support/?id=&new=&tenant_id=`
  (`supportPath()`), the Customer 360 `tickets` tab, and the portal's Help page form +
  "My tickets". Exit check: `test/d13-support.e2e.test.ts` (16 cases).

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
  `ctx = {userId, workspaceId, role, ip}`. Postgres RLS is the second guard, not the first.
  Every `audit_log` row a request writes takes `ip: ctx.ip ?? null` (QA-074); worker rows have none.
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

**Hardening and observability (§6.2, §17 — ADR 0025, D14)**

- **Disposable email is refused twice**: the `customer-pre-registration` Action denies the
  sign-up, and `UsersService.upsert` never creates a `users` row for one (webhook → settled
  `refused: disposable_email`; guard → `403 EMAIL_DISPOSABLE`). Existing rows are never
  refused. One list, `disposable-email-domains-js`, the same exact version in the API and
  the Action — `disposable-email.test.ts` fails when they drift. Subdomains count.
- **`registerRequestLimits`** (`common/http/request-limits.ts`, wired in `main.ts` only) is
  one `onRequest` hook: a state-changing request with a foreign `Origin` is `403
  ORIGIN_NOT_ALLOWED`; more than `API_RATE_LIMIT_PER_MIN` (default 600) per IP (an IPv6
  client by its /64, `clientBucket`) per fixed minute is `429 RATE_LIMITED` with `Retry-After` and CORS headers. **Never** `/webhooks/*`
  or `/health*`. Redis silent = allow. The e2e harness does not register it — its test is a
  real Fastify instance in `request-limits.test.ts`.
- **OpenTelemetry owns traces, Sentry owns errors.** `src/observability/register-{api,worker}.ts`
  is the **first import** of each entrypoint — anything required before it goes untraced.
  Off unless `OTEL_EXPORTER_OTLP_ENDPOINT` / `SENTRY_DSN`. Each BullMQ job is a span
  (`inSpan`, `job-handlers.ts`). Sentry keeps nine default integrations (`SENTRY_KEEP`): its
  HTTP instrumentation cost the inbound path 60 % of its throughput. Do not re-enable it,
  and do not turn on Sentry tracing. The filter reports 5xx; the worker reports a job's
  final attempt; `reportError()` is the only other way in. Browser: `@portal/ui/error-reporting`,
  which strips query strings and fragments from every URL (invite tokens, view-as keys).
- Diagnostics: `POST /admin/system/test-error` and `/test-alert` (super admin, ops) — how
  "Sentry receives it" and "Slack receives it" are checked on staging.
- The §13.9 Redis-down fail-open raises a `redis_down` ops alert (once per outage minute),
  not only a log line (ADR 0025 addendum, 30 Sep).
- DR: `docs/runbooks/pitr-drill.md` + `infra/scripts/pitr-fingerprint.sh` (restore into a
  throwaway instance, `diff` against the live fingerprint at the same cut-off).

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
| `admin:health:{provider}`    | the health strip's Retell / Stripe probe: fresh 60 s, then served while refreshed behind the response, kept 10 min (D12, ADR 0032) |
| `ratelimit:api:{ip}:{min}`   | API requests from one client IP in one epoch minute, TTL 2 min (D14, ADR 0025)                                          |
| `ratelimit:sip-verify:{ws}`  | SIP re-verify checks this hour, per workspace (D16, ADR 0028)                                                           |
| `fwdtest:{e164}`             | the "Test forwarding" ringing for a number, `SET NX` 90 s — the lease and the inbound path's cue (D17, ADR 0029)        |
| `ratelimit:fwd-test:{number}` | forwarding tests this hour, per number (D17)                                                                           |
| `ratelimit:data-export:{ws}` | D6 "Export all data" zips this hour, 5 max (ADR 0032)                                                                    |
| `ratelimit:widget:{key}` / `ratelimit:widget-ip:{key}:{ip}` | website widget calls per widget per hour / per visitor address per 10 min (D17)          |

Keys are built only in `modules/redis/redis.keys.ts`. Cache reads go through `RedisCache`, which never
throws and never waits past its budget (ADR 0010 §6).

## API conventions (§16)

- Errors: `{code, message, fields?[]}`. A zod failure is 422 `VALIDATION_FAILED` with `fields`; the filter matches `ZodError` by shape as well as by class (`isZodError`), because the ESM `@portal/schemas` and the CJS API load two zod builds — `instanceof` alone made every validation error a 500 in `dist/` while tests saw 422 (ADR 0019 §10). Check new error handling against the compiled server, not only vitest. Known codes include `402 NO_CREDITS`, `403 EMAIL_UNVERIFIED`,
  `429 TEST_RATE_LIMIT`.
- Pagination: `?cursor=&limit=`.
- Long operations return `202 {job_id}`; the client subscribes to SSE and falls back to
  `GET /jobs/:id` every 3 s.
- SSE topics: `wallet`, `alerts` (D7: `opened` / `resolved` / `dismissed`), `agent:{id}`,
  `call:{id}`, `activation:{id}`. `GET /events` is an ordinary
  authenticated route (the client is `@microsoft/fetch-event-source`), narrowed with `?topics=`, and
  only ever carries `ctx.workspaceId`'s own channel. **Every open stream is ended on
  shutdown** (`EventsController.beforeApplicationShutdown`): Fastify's close forces only
  idle connections and a hijacked stream is never idle, so one open dashboard tab kept the
  old process alive and the `nest --watch` restart — or a deploy's graceful stop — hanging
  behind it (24 Sep; `test/shutdown.e2e.test.ts`). The client reconnects on `retry: 3000`. `agent:{id}` frame types are named once, in
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
  `GET /activations/:id`; `PUT /wallet/auto-topup`, `GET /wallet/invoices`, `POST /wallet/portal-session`;
  since 24 Sep `POST /wallet/checkout/confirm` (owner/admin, `{session_id}` →
  `{purchase_id, status, credited}`, `404` for a session that is not this workspace's,
  `503 UPSTREAM_UNAVAILABLE` when Stripe cannot be asked).
  Buying, importing, releasing, activating and billing routes are owner/admin; knowledge and
  routing edits are editor and above.
- D7 routes: `GET /alerts/active`, `POST /alerts/:id/dismiss`,
  `GET|PATCH /workspace/notification-settings` (any member; a member edits only their own
  preferences), `GET /health/ready`. The full contract with every code and role is
  `docs/api/openapi.json`.
- D10 routes: `PATCH /calls {ids, handled}` (owner/admin/editor), `POST /calls/export`
  (owner/admin/editor, `text/csv`), `POST /agents/:id/versions/:v/lint` (any role);
  `GET /calls` takes `sort`, `order`, `handled` and answers `total`.
- D11 routes: `GET /audit-log` (owner/admin, `?area=&cursor=&limit=`, a §16 page of
  `auditEntryResponse` — action, target, actor or null, IP, `meta`, time; `area` is the
  part of `action` before the dot). `phoneNumberResponse` carries `sip` (host, username,
  `has_password` — never the password) and `calls_7d`. `inviteResponse.status` is
  `pending` / `expired` / `accepted`, derived on the server's clock (`inviteStatusAt`);
  D6 Team resends an expired one through `POST /invites` (which replaces the row and its
  token), and A8 answers `INVITE_EXPIRED` / `INVITE_USED` / `INVITE_WRONG_EMAIL` apart from
  `INVITE_INVALID` (BUG-010, QA-016). Resend is offered on pending invites too, behind a
  confirmation (the shared link dies). `POST /invites` emails the link and answers
  `email_status` (`sent` / `failed` / `not_configured` on the log sender); the link is still
  shown once to copy. `GET /invites/:token/preview` (no workspace, verified) gives the A8
  join screen workspace, inviter and role — to the invited address only; anyone else gets
  `INVITE_WRONG_EMAIL` and nothing about the workspace.
- D9 routes: `POST /agents/:id/test/web` (201, editor+, verified email; §13.4:
  `402 NO_CREDITS`, `429 TEST_RATE_LIMIT` at 10/h per workspace — a **fixed** window
  (`RedisCache.increment`, `SET NX` + `INCR`, counted only after the platform minted),
  `409 TESTS_PAUSED` under the SA12 `pause_web_tests` switch, `409 CONCURRENCY_LIMIT`
  when every `active:{ws}` slot of the plan is live) answers `{call_id, access_token, rate, balance,
  version_no, max_call_duration_s, live_token, transport…}` and writes no row —
  `call_started` does, from `metadata {tenant_id, agent_id, version_no, tier, test}`. Its
  ceiling is the inbound formula (ADR 0011 §1): min(the version's duration, what the
  balance **after the other live calls' reservations** covers) — never the raw balance,
  which let two tabs each spend the whole wallet. The
  **only WebSocket** on the API is `LiveTranscriptRelay` at
  `/test-calls/v2/monitor-call/:call_id` (bearer subprotocol = `live_token`, a
  `RecordingSigner` token with purpose `live`; `main.ts` attaches it, the worker never
  does). It forwards the platform's close code (`relayedCloseCode`): the SDK asks for the
  monitor a beat before the platform lists the call live and retries a `4004`, but reads
  a bare `1000` as "call over" and never asks again (25 Sep). Stripe's success/cancel URLs depend on the session: with `agent_id` (W7) both go
  to `/onboarding/activate` (`?session_id=` / `?checkout=cancelled`), without it to
  `/app/wallet`.
- Recordings: `GET /calls/:id/recording` mints a signed one-hour link to
  `GET /calls/:id/recording/stream?token=`, which is `@Public()` and proxies the bytes. The Retell
  URL is never given to the browser (ADR 0011 §5). **The link is minted on the origin the
  request arrived on** (`x-forwarded-proto`/`x-forwarded-host`, then `host`), never on
  `API_PUBLIC_URL`: that is the platform's callback URL, in dev an ngrok tunnel whose free
  tier answers a browser with an HTML interstitial, which `<audio>` reported as "could not
  be played" (24 Sep). The proxy also relabels a `.wav` the CDN serves as
  `application/octet-stream` to `audio/wav` (`recordingContentType`); Firefox refuses the
  former outright.
- D12 routes (`docs/api/openapi.json`, tags `admin*`): `GET /admin/me`, `/admin/kpis`,
  `/admin/kpis/funnel`, `/admin/search`, `/admin/system/health`, `/admin/audit` (+ `/export`,
  streamed CSV of the same filters, 10 000 rows, itself audited as `audit.exported`; `staff` /
  `customer` match part of an email or name, or an id exactly — the console never shows a staff id);
  `/admin/customers` (+ `:id`, `/members`, `/wallet`, `/purchases`, `/agents`, `/numbers`,
  `/calls`, `/jobs`, `/webhook-events`, `/audit`, `POST …/pause|resume|credits/adjust|impersonate`,
  `PATCH :id` — name/country/timezone/website, only changed fields audited — and
  `PATCH|DELETE :id/members/:mid` — role admin/editor/viewer or removal, never the owner (409);
  ownership moves only by the owner's own transfer);
  `/admin/impersonations` (+ `DELETE :id`); `/admin/users` (+ `POST :id/verify-email|reset-mfa|lock|unlock|force-logout`);
  `/admin/agents` and `/admin/numbers` (+ `POST :id/pause|resume`); `/admin/calls`;
  `/admin/jobs` (+ `POST :id/retry|discard`); `/admin/webhook-events` (+ `POST :id/replay`);
  `/admin/flags` (+ `PUT|DELETE :key`), `PUT /admin/kill-switches/:key`; `/admin/pricing/draft`
  (GET/PUT/DELETE), `/preview`, `POST /publish`, `/versions` (+ `:version`), `POST /rollback/:version`,
  `/admin/retell-costs` (GET/PUT). Customer side: `GET /impersonation`, `POST /impersonation/end`.
  Staff roles per route are in the manifest (`staffRoles`) and `x-staff-roles`.
- D13 QA rules (28 Sep, ADR 0022): a feature flag resolves `default_on || bucket < rollout_pct`,
  so **default off with rollout 100 % is on for everyone** — the console shows an "Effective"
  column and starts a new flag at 0 %; a NUL byte in any text answers `422` (Postgres 22021,
  mapped in the exception filter), never 500; `GET /admin/calls` and `GET /admin/numbers` search
  the customer's and the agent's name as well as ids and digits; SA1 "Needs attention" carries
  `failed_activations_24h`, `failed_topups_24h` and `onboarding_stuck` (paid, > 7 d, wizard
  unfinished) beside the D12 five; the health strip's counters are `lg:` only (they pushed the
  header past a 768 px viewport).
- ADR 0023 route: `POST /agents/:id/documents/extract` (owner/admin/editor, tag
  `prompting`, `extractDocumentRequest` → `extractDocumentResponse`; `NOT_FOUND`,
  `BAD_REQUEST`, `DOCUMENT_UNREADABLE`, `VALIDATION_FAILED`, and for a photo
  `GENERATION_PAUSED`, `UPSTREAM_UNAVAILABLE`, `NOT_CONFIGURED`). Stateless — the text
  goes into the brief.
- D16 routes: `POST /numbers/:id/sip/verify` (owner/admin, `sipVerifyRequest` → the number, with
  `sip.verification`; `NOT_SIP_NUMBER`, `SIP_VERIFY_IN_PROGRESS`, `RATE_LIMITED`),
  `GET /agents/:id/knowledge/stats?days=7|30|90` (any role). `callDetail` gained `transfer` and
  `knowledge`, `callSummary` `transfer_credits_charged`; `ledgerReason` gained `transfer`.
- D13 routes: `GET|POST /admin/staff`, `PATCH /admin/staff/:id`, `GET|PUT /admin/staff/limits`
  (writes: super admin), `GET /admin/provisioning` (`?status=&tenant_id=`, §16 page with
  `total`), `GET /admin/concurrency` (any staff).
- D13 SA4 routes (tag `admin-support`): `GET|POST /admin/tickets`, `GET|PATCH /admin/tickets/:id`,
  `POST /admin/tickets/:id/messages`, `POST /admin/tickets/:id/macros/:macro`
  (`comp_credits | refund_call | rerun_activation`; writes are super_admin/ops/support/finance,
  read-only reads only), `GET|POST /admin/canned-responses`, `DELETE /admin/canned-responses/:id`
  (super_admin/ops/support). Customer side (tag `support`): `POST /support/tickets` and
  `POST /support/tickets/:id/messages` (owner/admin/editor), `GET /support/tickets` (any member).
- D17 routes (ADR 0029): `POST /agents/:id/test/phone {to, version_no?}` (owner/admin/editor,
  verified; the browser test's checks and hourly window plus `402 PURCHASE_REQUIRED`,
  `409 NO_NUMBER`, `422` on `to` — taken as typed: Eastern Arabic digits, `00`, or national
  for the number's or the workspace's country, read by `checkTestDestination` — `VALIDATION_FAILED` for a number that is not real, else `DESTINATION_COUNTRY` / `DESTINATION_TYPE` / `DESTINATION_IS_AGENT`), `POST /numbers/:id/forwarding/test` (owner/admin/editor,
  verified; answers the number with `forwarding.test`; `NOT_FORWARDING_NUMBER`,
  `FORWARDING_TEST_IN_PROGRESS`, 5/h per number, and a test call's gates:
  `TESTS_PAUSED`, the workspace's `TEST_RATE_LIMIT`, `CONCURRENCY_LIMIT`, `NO_CREDITS`), `GET|PUT /agents/:id/widget` (PUT
  owner/admin), and the public `GET /widget/:key` + `POST /widget/:key/call {page_origin}`
  (`ORIGIN_NOT_ALLOWED`, `RATE_LIMITED`, and one `409 WIDGET_UNAVAILABLE` for every state a
  stranger should not learn). `GET /stats` answers `by_channel: {phone, web}`.
- D18 routes (ADR 0031, tag `outbound`): `GET|POST /calls/:id/callback` (check: any member;
  place: owner/admin/editor, verified email; `{idempotency_key, number_id?}`; codes
  `OUTBOUND_DISABLED`, `KYC_REQUIRED|PENDING|REJECTED`, `OUTBOUND_NOT_CONFIGURED`,
  `CALLER_ID_REQUIRED|UNVERIFIED`, `DESTINATION_INVALID`, `DNC_LISTED`, `NO_PRIOR_CONTACT`,
  `OUTSIDE_CALLING_WINDOW`, `OUTBOUND_DAILY_CAP`, `OUTBOUND_IN_PROGRESS` beside the existing
  ones), `GET /outbound`, `PUT /outbound/settings` and `POST /outbound/kyc` (owner/admin),
  `GET|POST /dnc` (add: editor+), `DELETE /dnc/:id` (owner/admin); staff
  `GET|POST /admin/customers/:id/kyc` and `POST /admin/numbers/:id/caller-id`
  (`STAFF_ROUTE_ROLES.compliance` = super admin, ops).
- ADR 0032 routes (28 Oct QA batch): `POST /agents/:id/duplicate {name?}`,
  `POST /agents/:id/draft/discard` (`NO_DRAFT_CHANGES`), `POST /agents/:id/versions` (save
  as new version) — editor+; `POST /agents` and duplicate answer `WORKSPACE_PAUSED` and,
  once onboarding is complete (duplicate: always), `PLAN_LIMIT` past `max_agents`;
  `PATCH /numbers/:id {transfer_fail_message}`; `GET /wallet/ledger?reason=`,
  `POST /wallet/ledger/export` (owner/admin, CSV, `client: false`); `POST /workspace/export`
  (owner/admin, verified, zip, `RATE_LIMITED`); `GET|POST|DELETE /workspace/delete-request`
  (read: any member; request/withdraw: owner, verified, `{confirm}` = the workspace name —
  files a `data_requests` row + an SA4 ticket + an ops alert and deletes **nothing**);
  `recordingResponse.download_url` (owner/admin) and `…/recording/stream?download=1`
  (download-purpose token only); `VERSION_NOT_TESTABLE` on both test mints.
- Webhook routes take no JWT: `/webhooks/retell`, `/webhooks/retell/inbound/:number_token`,
  `/webhooks/stripe`, `/webhooks/auth`.

## Data model index

Portal (§15): `users, tenants, memberships, invites, audit_log, notification_settings, templates,
agents, agent_versions, voices, knowledge_sources, phone_plans, phone_numbers, calls, credit_lots,
credit_ledger, purchases, packs, webhook_events, jobs, alerts`, plus since D7 `notifications`
(the outbox) and `reconciliation_runs` (global, staff-only), and since D18 `outbound_calls`
and `dnc_entries`.

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

**Auth0**: two tenants, both **Single Page Application** type. Post-User-Registration Action → `POST /webhooks/auth` (shared-secret header, `user.registered`) → upsert `users`. That trigger is fire-and-forget on Auth0's side, so there are two safety nets, both the same idempotent `UsersService.upsert` (module `auth`): the customer Post-Login Action posts `user.login` to the same route on every login (deduped to a 204 after the first), and `AuthGuard` provisions the row itself when a verified token has no row and carries `https://portal/email`. Only that namespaced claim is trusted for provisioning, never a bare `email` claim. Post-Login Actions add `https://portal/email_verified`, `https://portal/email`, `https://portal/name` (customer) and `https://portal/mfa` (staff). Frontend uses `@auth0/auth0-spa-js` (Authorization Code + PKCE — no client secret in the browser, ADR 0008). Both tenants are configured from `infra/auth0/tenant.customer.yaml` and `tenant.staff.yaml` with the Auth0 Deploy CLI (`pnpm auth0:validate|check|export|plan|deploy`, a dev dependency — nothing global to install), Actions source in `infra/auth0/actions/`, procedure in `docs/runbooks/auth0.md`. The deploy CLI matches objects by **name**, so a wrong name creates a second application instead of failing: export and diff before the first deploy. Google's connection `options` stay in the dashboard; the one setting of ours there, `upstream_params.prompt = select_account` (Google's account picker, so "Sign out" on a wrong-email invite can switch accounts), is written by `pnpm auth0:google-picker customer --apply` — the customer tenant still runs on Auth0's development keys, which must be replaced before production. `pnpm --filter @portal/api verify:auth0` is the check against the real tenant — Actions deployed and bound, the shared secret, the access-token claims, and JIT provisioning.

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
pnpm dev               # api, worker, portal, admin. The dev worker builds into dist-worker/
                       # (nest-cli.worker.json): two watchers sharing dist/ with deleteOutDir
                       # wiped it under each other — MODULE_NOT_FOUND …/dist/worker (29 Sep).
                       # The worker is not optional: without it
                       # every 202 job (generate, provision, activate) sits in `queued` for
                       # ever. `GET /health/ready` reports it as "no heartbeat".
pnpm dev:issuer:staff  # D12: a stand-in *staff* tenant on :9998 that stamps the MFA claim, for the console
pnpm dev:stripe        # stripe listen → localhost:4000/webhooks/stripe. The Stripe account's only
                       # registered endpoint is staging's; without this no local purchase is credited
                       # by webhook (W7's confirm and the 15-minute sweep still credit it, later).
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
order: admin SA4/SA7/SA8/SA9 actions (keep read-only tables) → SIP option C →
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
  every D6/D7 table (`test/d7-*.e2e.test.ts`, `backend/db/test/rls.e2e.test.ts`); from D17 — the
  "Call my phone" gates, the forwarding test's hot-path decline and stale-job safety, and
  the widget's public refusals and exit check (`test/d17-channels.e2e.test.ts`); from D18 —
every outbound refusal (no platform request, an audit row, no call or ledger row), the
staff-only verdicts, the cap under concurrent presses, idempotency and billing once
(`test/d18-outbound.e2e.test.ts`); from D9 —
  the test-call mint (draft re-sync, credits, rate limit, kill switch, roles, isolation) and
  the live-transcript relay's authorisation and frame filter (`test/d9-test-call.e2e.test.ts`,
  `live-transcript.relay.test.ts`); from D10 — server-side sort with a stable cursor, the
  total, `handled`/`sentiment`, bulk handled (foreign id, viewer) and the CSV export
  (columns, filters, ids, isolation, formula-safe cells) in `test/calls-api.e2e.test.ts`
  and `modules/calls/csv.test.ts`, plus the portal's URL state, 30-day series, transcript
  and analysis parsers and line diff (`frontend/web/src/dashboard/*.test.ts`); from D11 —
  the audit-log route (newest first, cursor, area filter, roles, isolation, a departed
  actor), the redacted `sip` and `calls_7d` on every numbers route
  (`test/workspaces.e2e.test.ts`, `test/d6-numbers.e2e.test.ts`), the SSE `pagehide`
  abort (`frontend/api-client/src/sse.test.ts`) and the wallet-frame parser plus the
  D4–D7 view logic (`frontend/web/src/dashboard/{wallet-frame,wallet-view,numbers-view,audit-view}.test.ts`).
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
