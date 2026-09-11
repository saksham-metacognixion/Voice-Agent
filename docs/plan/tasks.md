# Task board — 21 tasks, one per working day

Rendered from `tasks.csv`. Auth0 (ADR 0002), AWS EC2 backend hosting (ADR 0004); Retell findings are ADR 0003. Tasks marked **(updated)** changed after the ClickUp import.

## Day 0

### D0 — Bootstrap repo + monorepo scaffold **(updated)**

Due Fri 11 Sep · 6h · Urgent · `phase:p0` `area:infra` `spec:§12.1` `spec:§13.1` · depends on —

Stand up the repo and the empty monorepo so every later day has somewhere to write code.

- CLAUDE.md
- ADR 0001 tech stack
- Spec text extract + page index
- tasks.csv + plan README
- .gitignore
- git init + first commit
- Turborepo + pnpm workspace
- shared/config (eslint, tsconfig, tailwind preset)
- shared/schemas (zod)
- backend/db (Prisma init)
- backend/api (NestJS + Fastify adapter, /health, worker.ts entrypoint)
- frontend/ui (shadcn init)
- frontend/api-client
- frontend/web (Next.js App Router)
- frontend/admin (Next.js App Router)
- docker-compose: postgres + redis
- GitHub repo + CI (lint, typecheck, test)

**Exit:** pnpm turbo build lint test green; docker compose up healthy; /health returns 200

## Week 1 — Foundation + Backend

### D1 — Accounts, data layer, auth guards **(updated)**

Due Mon 14 Sep · 8h · Urgent · `phase:p0` `area:backend` `area:infra` `spec:§6` `spec:§13.12` `spec:§15` `spec:§17` · depends on D0

Provision every external account and land the full database + auth foundation in one pass.

- Accounts: Retell, Stripe (test), Anthropic
- Auth0 x2 (customer tenant, staff tenant) + M2M apps
- AWS account: IAM user for CI, EC2 staging instance (t3.small) + Elastic IP, SSM Parameter Store, KMS key; Neon (dev branch); Vercel x2
- cloudflared tunnel for webhooks
- .env.example committed
- Prisma schema: all Portal §15 tables
- Prisma schema: Admin §8 P1 tables
- Migration: RLS policies on workspace_id
- Migration: two DB roles (app RLS-enforced, admin BYPASSRLS)
- Migration: credit_ledger REVOKE UPDATE/DELETE + RAISE EXCEPTION trigger
- Migration: audit_log append-only
- JWKS verification guard, issuer chosen by route namespace
- X-Workspace-Id + membership + role guards
- Error envelope {code, message, fields}
- Cursor pagination helper

**Exit:** Migration applies on Neon; cross-tenant read blocked in test; customer JWT rejected on /admin/*

### D2 — Retell round-trip + §21 verification (P0 exit) **(updated)**

Due Tue 15 Sep · 8h · Urgent · `phase:p0` `area:backend` `spec:§13.1` `spec:§21` · depends on D1

Prove the Retell contract end to end and answer every open question before code depends on it.

- RetellGateway: create-retell-llm, create-agent, list-voices
- RetellGateway: create-web-call, create-phone-number, create-knowledge-base
- Bare page doing a browser test call (retell-client-js-sdk)
- Buy inbound number; set agent webhook_url + number inbound_webhook_url via tunnel
- Capture real payloads as fixtures (call_inbound, call_started, call_ended, call_analyzed)
- Verify: decline mechanism for inbound webhook
- Verify: agent_override.agent.max_call_duration_ms honoured
- Verify: call_cost object shape and units
- Verify: language multi behaviour + true multilingual voices
- Verify: agent version tags (latest_published) + publish API
- Verify: KB ingestion limits and refresh
- Verify: TTS preview endpoint
- Decide Redis-down policy (fail-open vs fail-closed)
- Write ADR 0003 Retell findings

**Exit:** Every §21 item answered in ADR 0003; fixtures committed; manual brief → number → call works

### D3 — Wallet, Stripe, config cache, metering tests

Due Wed 16 Sep · 8h · Urgent · `phase:p0` `area:backend` `spec:§5` `spec:§13.7` `spec:§14` · depends on D2

Money in and money out: prepaid credits, Stripe purchase, and the pricing config the whole system reads.

- wallet module: append-only ledger writes
- wallet: FIFO lot consumption by expires_at
- wallet: bal:{ws} Redis cache + rebuild on mismatch
- Stripe Checkout Session (client_reference_id, metadata, setup_future_usage)
- POST /webhooks/stripe with raw-body signature verification
- Exactly-once via webhook_events unique (provider, external_id, event_type)
- Handle checkout.session.completed / async_payment_succeeded / expired
- Credit lots + ledger rows + plan tier update on paid
- config-cache: pricing_configs, feature_flags, kill_switches to Redis
- GET /pricing and GET /flags with cache invalidation
- Metering unit tests from D2 fixtures (idempotency, 0-charge, rounding)

**Exit:** Test purchase credits the wallet; ledger debit for a real call within ±5% of the pricing page

### D4 — Call path: SSE, queues, inbound authorisation, metering

Due Thu 17 Sep · 8h · Urgent · `phase:p1` `area:backend` `spec:§13.9` `spec:§13.10` `spec:§14` · depends on D3

The latency-critical path: authorise inbound calls in under 300 ms and bill them exactly once.

- events module: SSE endpoint + Redis pub/sub fan-out
- BullMQ queues + Job Schedulers skeleton in worker
- runtime-cache module with refresh(workspaceId)
- webhooks lifecycle handler: store raw → duplicate 204 → enqueue
- POST /webhooks/retell/inbound/:number_token
- Six ordered checks: workspace paused, number paused, blocklist, balance > -10, active < cap, hours
- max_call_duration_ms = min(planMax, remainingCredits/rate*60000)
- Allow/decline response; calls row written by enqueued job with decline_reason
- k6 load test for p95 < 300 ms
- calls: call_started reserve + INCR active:{ws} + capture rate/config_version
- calls: call_ended bills (only billing event), DECR, alerts
- calls: call_analyzed stores analysis_json + retell_cost_cents (never bills)
- SSE call:{id}
- GET /calls, GET /calls/:id, recording signed proxy, GET /stats

**Exit:** k6 p95 < 300 ms; replayed webhook is a no-op; declined call shows as Missed with a reason

### D5 — Workspaces, agents, prompting

Due Fri 18 Sep · 8h · High · `phase:p1` `area:backend` `spec:§9` `spec:§13.2` `spec:§13.3` · depends on D4

Tenancy plus the brief → prompt engine that makes the product feel like magic.

- workspaces: POST /workspaces transaction (tenant, owner membership, trial credits, settings, audit)
- Invites + members + roles + transfer ownership
- POST /webhooks/auth for user.created
- voices: daily cache job + POST /voices/:id/preview
- agents: create from templates/*.json, PATCH draft, versions list/select
- agents: publish via RetellGateway, pause, delete
- Prompt lint rules (§9.5)
- prompting: generate job (202 + job_id) on claude-sonnet-5 structured output
- prompting: feedback patch job (source=feedback)
- Platform guardrails appended and non-editable (§9.4)
- SSE agent:{id} events

**Exit:** Generate returns zod-valid JSON with p95 ≤ 10 s; publish updates the Retell agent version

## Week 2 — Backend + Portal

### D6 — Knowledge, numbers, activation, billing

Due Mon 21 Sep · 8h · High · `phase:p1` `area:backend` `spec:§11` `spec:§13.8` · depends on D5

Everything between paying and having a live phone number.

- knowledge: POST/GET/DELETE sources (url, file, text) + kb-sync job
- numbers Option A: buy new number (country, area code, toll-free)
- numbers Option B: forwarding guide per carrier
- numbers Option C: SIP import with envelope-encrypted credentials
- PUT /agents/:id/phone-plan
- PATCH /numbers/:id and DELETE /numbers/:id
- activate-agent job: publish → provision → bind → mark live → notify
- activation_jobs.steps_json + SSE activation:{id}
- Retry 3x with backoff, then failed + ops alert
- billing: auto top-up off-session PaymentIntent
- billing: invoices list + Stripe portal session

**Exit:** Activation job provisions a real number end to end on staging and marks the agent live

### D7 — Schedulers, notifications, tests, staging deploy (backend P1 complete) **(updated)**

Due Tue 22 Sep · 8h · High · `phase:p1` `area:backend` `area:infra` `spec:§13.11` `spec:§5.3` `spec:§5.4` · depends on D6

Close out the backend: recurring money movement, alerts, and a deployed staging API.

- Scheduler: number-rental (hourly, 15 credits/number)
- Scheduler: credit-expiry (daily, 12-month lots)
- Scheduler: low-balance-alerts (20% / 5% / 0)
- Scheduler: auto-topup on ledger change
- Scheduler: reconcile-calls (nightly vs list-calls, alert > 5% drift)
- Scheduler: concurrency-monitor (5 min, alert at 80%)
- Scheduler: number-release (30 days at zero balance)
- Scheduler: daily-digest per workspace timezone
- notifications module + Resend transactional email
- Integration tests: webhook ordering, replay, decline reasons, RLS cross-tenant
- OpenAPI generation → @portal/api-client typed hooks
- docker-compose.prod.yml (api, worker, redis, caddy) + CI image push to GHCR + deploy to EC2 staging

**Exit:** Schedulers register exactly once across restarts; CI green; staging API reachable over TLS on the EC2 Elastic IP

### D8 — Portal shell, auth screens, wizard W1–W3 **(updated)**

Due Wed 23 Sep · 8h · High · `phase:p1` `area:frontend` `spec:§6` `spec:§7` · depends on D7

The customer's first three minutes: sign up, then describe the business and hear a voice.

- Auth0 Universal Login via @auth0/nextjs-auth0 for A1 signup, A2 login, A3 verify email; own page for A4 setup workspace
- A5 MFA, A6 forgot/reset, A7 workspace switcher, A8 accept invite
- Route guards per §6.4 onboarding gating
- Global shell §7.2: left nav, workspace switcher, status chips, balance pill
- @portal/api-client + TanStack Query hooks
- next-intl scaffold (en keys) + PostHog events
- W1 template picker
- W2 brief: 13 fields, autosave 1.5 s, BriefCard, Generate with SSE/polling
- W3 voice and languages: VoicePicker, filters, tier badges, preview
- Deploy web to Vercel staging

**Exit:** Sign-up through W3 works on staging, including a real Generate

### D9 — Wizard W4–W7 + live

Due Thu 24 Sep · 8h · High · `phase:p1` `area:frontend` `spec:§8` `spec:§12.3` · depends on D8

Test, buy a number, pay, go live — the rest of the 15-minute promise.

- W4 knowledge sources with processing status polling
- W5 TestCallPanel via retell-client-js-sdk (mic, live transcript, timer, credits)
- W5 ImprovePanel: plain-language feedback → new draft version
- W5 after-call card filled from call_analyzed
- W6 PhoneOptionCards (A/B/C) + CarrierForwardingGuide + TransferTargetsEditor
- W7 PackSelector + Stripe Checkout redirect + return handling
- W7 ProvisioningProgress on SSE activation:{id}
- /onboarding/live success screen

**Exit:** Browser test call, test-mode checkout, and activation all visible in the UI

### D10 — Dashboard D1–D3

Due Fri 25 Sep · 8h · High · `phase:p1` `area:frontend` · depends on D9

The three screens an owner opens every day.

- D1 Home: alert banner, credits card, today card, agent card
- D1: setup checklist, recent calls, 30-day minutes chart
- D2 Calls: list with URL-synced filters, sort, pagination
- D2: CSV export, bulk mark handled, new-call toast via SSE
- D2 detail drawer: summary, captured fields, transcript, recording, details
- D3 Agents list + tabs: overview, brief (with Advanced prompt editor + lint), voice
- D3 tabs: knowledge, test, versions (diff, publish, restore), settings

**Exit:** A real inbound call appears in D1 and D2 live via SSE

## Week 3 — Admin + Launch

### D11 — Dashboard D4–D7 + mobile

Due Mon 28 Sep · 8h · High · `phase:p1` `area:frontend` `spec:§12.5` · depends on D10

Finish the dashboard and make every screen work on a phone.

- D4 Numbers: list, routing, hand-off, callers, forwarding guide, SIP, danger zone
- D5 Wallet: balance, auto top-up, usage chart, ledger, invoices, payment methods
- D5: BalancePill live on SSE wallet topic
- D6 Settings: workspace, team, notifications, security, data & privacy, audit log
- D7 Help: docs links, support chat, status embed
- Mobile: left nav to bottom tab bar, tables to cards under 640 px

**Exit:** All dashboard screens usable at 390 px width

### D12 — Admin API + admin shell **(updated)**

Due Tue 29 Sep · 8h · High · `phase:p1` `area:admin` `area:backend` · depends on D7

Everything staff need to run the business without touching the database.

- GET /admin/kpis and /admin/kpis/funnel
- Customers list + 360 (overview, members, wallet, purchases, agents, numbers, calls, notes, audit)
- POST credits/adjust with mandatory reason code + audit row
- Pause / resume tenant, number, agent
- Users basics: verify email, reset MFA, lock, force logout
- Jobs list + retry/discard; webhook_events + replay
- Feature flags CRUD + kill switches
- Pricing draft, preview with margin check, publish, rollback
- Stripe Price sync on pricing publish
- View-as impersonation (read-only, audited)
- Staff Auth0 tenant + https://portal/mfa claim enforcement + issuer assertion on boot
- Admin shell: cmd-K global search, health strip, impersonation banner

**Exit:** Staff without MFA rejected; a pricing publish is visible in the portal within 60 s

### D13 — Admin screens P1 subset + P1 exit review

Due Wed 30 Sep · 8h · High · `phase:p1` `area:admin` `spec:admin§4` · depends on D12, D11

Ship the admin screens needed to run 10 design partners, then time the full journey.

- SA1 Overview KPIs + funnel + needs-attention
- SA2 Customers list + 360 tabs
- SA3 Users
- SA4 Support tickets (minimal: list, reply, close)
- SA5 Pricing: draft → preview → publish
- SA7 Telephony: numbers inventory, concurrency, provisioning queue
- SA8 Global calls
- SA9 Billing: purchases, refunds, failed top-ups
- SA12 System: jobs, webhook events, flags, kill switches
- SA13 Staff & settings
- SA14 Global audit log
- P1 exit: timed sign-up → live run on staging

**Exit:** Sign-up to live phone number under 15 minutes, timed, on staging

### D14 — Integration + security gate

Due Thu 1 Oct · 8h · Urgent · `phase:p1` `area:infra` `spec:§17` `spec:§18` · depends on D13

The one buffer day: prove it is correct, safe and observable before real money flows.

- End-to-end staging run: sign-up → wizard → checkout → activation → real inbound call → ledger → D1/D2
- Decline paths: balance, cap, hours, blocklist, paused all show as Missed
- Overdraft grace (-10) behaviour
- Clock-advanced run of number-rental and credit-expiry
- Pen test: RLS, X-Workspace-Id spoofing, customer JWT on /admin/*
- Rate limits, CSRF/origin checks, disposable email blocking
- Redis-down chaos test against the documented policy
- Neon PITR restore drill
- OpenTelemetry traces + Sentry + Slack alerting
- WCAG 2.1 AA: keyboard nav, live regions, contrast

**Exit:** Zero cross-tenant findings; alerts fire in Slack; restore drill succeeds

### D15 — Production cutover — MVP live **(updated)**

Due Fri 2 Oct · 8h · Urgent · `phase:p1` `area:infra` `spec:§13.12` `spec:§19` · depends on D14

Go live and put the first design partners on real phone numbers.

- EC2 prod instance (t3.medium) + Elastic IP + compose stack up
- Retell live API key + live agents (no dev- prefix)
- Stripe live keys + live webhook endpoint
- Auth0 production tenants (customer + staff) + custom auth domains
- Webhook URLs repointed to api.<domain>
- Domains: app.<domain>, admin.<domain>, api.<domain>
- Status page live
- docs/runbook.md written
- Onboard first design partners
- Watch PostHog funnel for 24 h

**Exit:** First design partner takes a real call on a real number; funnel visible

## Week 4 — P2

### D16 — P2: transfer billing, per-number hours, KB stats, SIP re-verify, fr-CA

Due Mon 5 Oct · 8h · Normal · `phase:p2` `area:backend` `area:frontend` `spec:§5.1` `spec:§14.1` · depends on D15

First P2 batch: billing accuracy, per-number control, and French.

- Transfer billing split using transfer_bridged / transfer_ended (0.25 cr/min leg)
- Per-number business hours with override editor
- Knowledge base usage stats (KB hits per call)
- SIP re-verify flow
- fr-CA full message catalogue

**Exit:** A transferred call is billed as two legs; fr-CA renders across the portal

### D17 — P2: call-my-phone, forwarding test, web widget

Due Tue 6 Oct · 8h · Normal · `phase:p2` `area:backend` `area:frontend` `spec:§11.5` · depends on D16

Give customers two more ways to hear the agent, plus a website channel.

- POST /agents/:id/test/phone with balance and cap checks
- Forwarding test: call the original number and verify it lands
- Embeddable web widget button using the Retell web SDK
- Web channel separated in analytics and call list

**Exit:** Widget call is recorded with channel=web and appears in D2

### D18 — P2: outbound click-to-call + compliance gating

Due Wed 7 Oct · 8h · Normal · `phase:p2` `area:backend` `spec:§17` · depends on D17

Outbound, but only behind the compliance gates TCPA/CRTC require.

- Click-to-call from D2 call detail
- KYC business verification flag
- Verified caller ID requirement
- DNC list check
- Calling windows enforcement
- Per-day outbound caps
- Voicemail detection setting

**Exit:** Outbound is blocked for a tenant without KYC and verified caller ID

### D19 — P2: calendar/CRM tool calls, multi-agent per number

Due Thu 8 Oct · 8h · Normal · `phase:p2` `area:backend` `area:frontend` · depends on D18

Let the agent actually do things during the call.

- Google Calendar tool via Retell general_tools
- HubSpot tool via Retell general_tools
- Multi-agent per number routed by business hours
- D3 knowledge usage tab

**Exit:** A test call creates a real calendar appointment

### D20 — P2: admin P2 — full scope complete

Due Fri 9 Oct · 8h · Normal · `phase:p2` `area:admin` `spec:admin§11` · depends on D19

Finish the admin console so finance and support can work unassisted.

- Promo codes CRUD
- Custom deals (negotiated pricing per tenant)
- SA6 Agent stack: templates editor, generation playground, migrate-all
- SA10 Comms: announcements, banners, broadcasts, maintenance mode
- SA11 Trust: fraud queue, blocklists, flagged calls, deletion requests
- Act-as impersonation (write, time-boxed, audited)
- Approval workflow for over-limit staff actions
- Reports: revenue, COGS, deferred liability, breakage

**Exit:** Every Admin §11 P2 item demoable; full scope complete
