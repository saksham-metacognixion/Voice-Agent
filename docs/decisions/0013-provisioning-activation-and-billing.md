# ADR 0013 — Knowledge, numbers, activation and billing (D6)

- Status: accepted
- Date: 2026-09-21
- Deciders: Saksham
- Scope: §11 (phone number options), §13.8 (activation job), W4 knowledge, §5.4 auto top-up,
  D5 "Invoices" and "Payment methods", §17 (SIP credentials at rest), and the parts of §16 those
  touch.
- Builds on: [ADR 0003](0003-retell-findings.md) §4, §7, §8 (numbers, version binding, knowledge
  bases), [ADR 0006](0006-tenancy-rls-and-append-only.md), [ADR 0010](0010-wallet-ledger-and-pricing-config.md)
  (wallet lock, grants), [ADR 0011](0011-call-runtime-and-queues.md) (queues, `num:{e164}`),
  [ADR 0012](0012-prompting-pipeline-and-agent-lifecycle.md) §3 (the publish lease).

## Context

D6 is everything between "the customer paid" and "the phone rings and the agent answers":
knowledge sources, the W6 number choice, buying or importing the number, binding it, and the
moment the agent is called *live*. Every one of those steps talks to the voice platform or to
Stripe, none of them may run inside a Postgres transaction (ADR 0006), and every one of them
will at some point run twice — a worker restart, a timeout after the provider had already
acted, BullMQ redelivering a stalled job. The decisions below are about what must still be
true when that happens: one number bought, one knowledge base, credits granted once, the agent
never live before its number can answer.

## Decisions

### 1. Activation is a durable step machine on the `jobs` row, not a transaction

§13.8 describes `activation_jobs.steps_json`. The data model (§15) has one `jobs` table with a
`steps_json` column and a one-active-job-per-agent index (ADR 0012 §5), and the prompting jobs
already use it as their state. Activation is a `jobs` row of type `activate-agent` whose
`steps_json` holds one record per step:

```
publish → provision → bind → mark_live → notify
```

The worker resumes at the first step that is not `completed` or `skipped`, and persists each
step's outcome before starting the next. `agents.status` is written by `mark_live` alone, after
`bind` has completed, so there is no path on which an agent is live while its number cannot
answer. A republish of an agent that already has an active number skips `provision` and `bind`.

The customer-facing state (`pending → publishing → provisioning → binding → marking_live →
live | failed`) is derived from the records (`activation-state.ts`, pure and unit-tested), sent
on `activation:{job_id}` as SSE frames and served by `GET /agents/:id/activation` and the
`GET /jobs/:id` whitelist. Provider identifiers, `last_error` and `requested_by` never leave the
server; the one failure sentence a customer reads is `customer_reason`.

### 2. Every external step looks before it acts

The platform has no idempotency keys for `create-phone-number` or `add-sources`, so identity
is embedded in what we create and looked up before we create again:

| Step | Identity the retry looks for |
| --- | --- |
| buy a number | platform nickname `num-<20 hex of phone_numbers.id>`, via `list-phone-numbers` |
| import a SIP number | the E.164 itself, via `get-phone-number` (a `custom` number is adopted) |
| bind | read the binding and the inbound webhook URL; `update-phone-number` only on a mismatch |
| knowledge base | platform name `kb-<20 hex of agent id>` (Retell caps names at 40 chars), via `list-knowledge-bases`; a Redis lock per agent around the create |
| knowledge source | the row id in the text title / filename, or the URL, via `get-knowledge-base` |
| publish | `AgentPublishService.publish` — the lease and `already_published` (ADR 0012 §3) |

The platform's answer (`e164`, `retell_meta_json`, `retell_source_id`, `agents.retell_kb_id`)
is persisted immediately after the call returns and before the next call, and the row that
represents the resource exists *before* the provider call (`phone_numbers.plan_id` and
`knowledge_sources` are created first). A crash anywhere therefore leaves a row that names
what to look for.

### 3. Three attempts, and only for failures worth retrying

`ACTIVATION_JOB_OPTIONS` is three attempts with exponential backoff from five seconds.
`classifyError()` decides what a retry may fix: a platform 5xx/429/408/409, a network error or a
Postgres timeout is retryable; a platform 4xx, a lint failure, a missing plan, no paid purchase
or a plan limit is permanent and ends the job on the first attempt. The final failure marks the
workflow `failed`, the number row `failed` (kept, with its `e164` if one was bought, so support
sees what the platform holds), publishes one `failed` frame, and raises one `activation_failed`
ops alert with workspace, agent, job, failed step, attempt count, error kind and platform
status — never a credential (`OpsAlertService.redact`).

### 4. Provisioning jobs get their own queue

A fifth BullMQ queue, `provisioning`, carries `knowledge-sync`, `provision-number` and
`activate-agent`. Each is several platform round trips (a KB ingest is ~12 s, ADR 0003 §8) and
neither `calls` (the write-behind on the 300 ms path) nor `prompting` (LLM round trips with a
tight p95) may queue behind them.

### 5. Option B is a bought number plus a customer-side state

Carrier forwarding cannot be provisioned by us. The number we buy is `active` and answers on
its own; `phone_numbers.forwarding_status` starts `waiting_for_customer` and the customer
confirms it (`PATCH /numbers/:id {forwarding_confirmed}`) after dialling the carrier codes from
`GET /numbers/forwarding-guide`. Activation reaches `live` — the agent is genuinely reachable
on the new number — and the view carries `forwarding.status` so the UI does not claim the
business line is forwarded until it is. Verifying the forwarding by call is D16.

### 6. SIP passwords are envelope-encrypted, opened once, on the stack

`phone_plans.sip_json.password` is an envelope: a fresh AES-256-GCM data key per secret, wrapped
by a master. Staging and prod wrap with AWS KMS (`SIP_CREDENTIALS_KMS_KEY_ID`, encryption
context `purpose=sip_credentials`); dev and tests wrap with a local 32-byte key
(`SIP_CREDENTIALS_LOCAL_KEY`), refused when `APP_ENV=prod`. The plan id is the additional
authenticated data, so an envelope moved to another row does not open. There are two call
sites: `PhonePlansService` / `NumbersService.import` seal on the way in;
`NumberProvisioningService.importSip` opens immediately before `import-phone-number` and the
plaintext lives in that frame only. Responses carry `has_password`; the Retell double records
the import call with the password redacted so even test output is clean.

### 7. Auto top-up credits nothing on the create call

`AutoTopupService.evaluate` runs on every debit (`WalletService.onLedgerWrite`) and from the
15-minute `auto-topup` schedule. Under the per-workspace wallet lock it re-reads the balance,
refuses when a top-up is already pending (30 min) or a card was declined recently (6 h), and
creates the pending purchase. Outside the lock it creates the off-session PaymentIntent with
`idempotencyKey = topup-<purchase id>`. Credits are granted in exactly one place —
`fulfilPaymentIntent`, from `payment_intent.succeeded` or from the schedule retrieving the
intent from Stripe when a webhook was lost — under the same lock, only when the purchase is
still `pending` and the amount and currency match. A Checkout PaymentIntent (no `kind:
auto_topup` metadata) is ignored on this path; `checkout.session.completed` owns it.

### 8. Invoices are a mirror with monotonic status

`invoices` rows are written only by the `invoice.*` handlers, keyed on the Stripe invoice id.
`webhook_events` gives one processing per event id; `last_event_created` plus a status rank
(`draft < open = payment_failed < paid = void = uncollectible`) stops a reordered or replayed
event from moving an invoice backwards. An invoice whose customer maps to no workspace is
stored with `tenant_id NULL` for reconciliation and is visible to nobody.

### 9. A paid Checkout is settled from Stripe's answer, not only from the webhook — 24 Sep 2026

Found on a dev box: a customer paid a Growth pack, Stripe sent them back to
`/onboarding/activate?session_id=…`, and the page sat on "Still waiting for the payment
confirmation" for ever. Stripe had the money (`status=complete`, `payment_status=paid`) and the
purchase was `pending`. The only webhook endpoint registered on the Stripe account is
`api-staging.oraly.ai`, and `stripe listen` was not running, so `checkout.session.completed`
never reached this API. Nothing in the design could recover from that: fulfilment had exactly
one entry point, the webhook, and the W7 copy "we check the payment first" only read our own
table.

Stripe's own guidance for Checkout is to fulfil from **both** the webhook and the return URL,
retrieving the session by id, and to make fulfilment idempotent. We now do that, through the
handlers that already exist:

- `StripeGateway.retrieveCheckoutSession(id)` → the same `CheckoutSessionFacts` the webhook
  reduces `data.object` to.
- `BillingService.confirmCheckout(ctx, sessionId)` behind `POST /wallet/checkout/confirm`
  (owner/admin). It finds **this workspace's** pending purchase by `stripe_session_id`
  under RLS — a foreign or unknown id is a 404 before any Stripe call — retrieves the
  session, checks `identify()` still names that purchase, and hands it to `fulfil()`
  (`expired` → `abandon()`). Same amount/currency check, same wallet lock, same
  `already_paid` short-circuit, same post-commit `onPurchaseCredited` that starts the
  activation. Answers `{purchase_id, status, credited}`; Stripe unreachable is
  `503 UPSTREAM_UNAVAILABLE` and the row stays `pending`.
- `BillingService.reconcilePendingCheckouts()` at the top of the `auto-topup` tick (§7 already
  did the same for top-up PaymentIntents): pending, non-top-up purchases with a session
  created more than 5 minutes and less than 48 hours ago, oldest first, 100 per tick. Paid →
  credited, expired → abandoned, still open → left alone. Beyond 48 hours the row is SA9's.
- W7 posts `session_id` once on mount and on "Check again". The URL still proves nothing to
  the page; it proves nothing to the API either — Stripe's answer does.

Three writers, one fulfilment, so ordering does not matter: the e2e suite confirms, confirms
again, then delivers the real webhook for the same session and still finds one lot and one
ledger row. The dev box needs `pnpm dev:stripe` for the webhook path regardless; the two new
paths make a stopped forwarder a delay, not a lost sale. In staging and prod the webhook is
the normal path and the confirm is what makes the return screen immediate.

## Alternatives considered

- **One transaction around publish + provision + bind.** Ruled out by ADR 0006: four to six
  provider calls inside an interactive transaction would exhaust the pool at a handful of
  concurrent activations, and a Postgres failure after the number was bought would roll back
  the row that names it.
- **Marking the agent live at publish and provisioning afterwards.** Simpler to write, and the
  ordering the brief forbids: `num:{e164}` would advertise a live agent for a number that does
  not exist yet, and a failed purchase would leave a "live" agent nobody can call.
- **A separate `activation_jobs` table.** The spec's name, but a second copy of the `jobs`
  machinery (the partial unique index, the sweeper, `GET /jobs/:id`, the reconciliation of dead
  rows) for one job type. The type and the `steps_json` shape carry the distinction.
- **Crediting a top-up from the create response's `succeeded`.** One code path fewer, and one
  more place credits could be granted twice if the webhook also arrived. One path, one lock.
- **Storing the SIP password with a single symmetric key.** Rotating that key would mean
  re-encrypting every row; the envelope rotates the master by re-wrapping data keys, and the
  KMS master never leaves the HSM.

## Consequences

- Five queues, not four; `SCHEDULES` has `auto-topup` live. `pnpm test` asserts both.
- `phone_numbers.e164` is nullable. Every reader that keys on it (`runtime-cache`) skips a row
  without one, and `refreshNumber` uses `findFirst`.
- `knowledge_sources.tenant_id` exists and the table uses the standard tenant policy; the
  status enum is `pending | syncing | ready | failed | deleting`.
- A knowledge base created after an agent was published reaches the platform LLM at the next
  publish (the LLM object is versioned with the agent, ADR 0003 §7). In the wizard, W4 comes
  before W7's activation publish, so first-time knowledge is always attached; adding knowledge
  to a live agent needs a republish, which the D3 Knowledge tab should trigger (D10).
- Number rental (`next_rental_at`, 15 credits/month) is stamped at bind; the `number-rental`
  schedule that charges it is D7.
- `ACTIVATION_BACKOFF_MS` exists so the e2e suite can run retried scenarios in under a second
  per retry. It is not a production setting.
- The real run against Retell and Stripe test mode is recorded at the bottom of this file once
  it has been done.

## The real run — 21 Sep 2026, Retell dev workspace + Stripe test mode

`pnpm --filter @portal/api verify:d6` (`scripts/d6-staging-verify.ts`; the real `AppModule`
on :4000 behind the ngrok tunnel, BullMQ workers in-process, Auth0 doubled, everything else
real). Workspace `e2812cb2-01df-4b58-9047-a643d2f65317`, Stripe customer `cus_VIdtewm9BDdq0g`
with a saved `pm_card_visa`, a paid Growth purchase (500 credits).

- Knowledge: text source → `create-knowledge-base` (`knowledge_base_941ce9bbdba1c02c`) →
  `complete` in 1.7 s, source `kb_source_f383dc2286fe90bc`. The first attempt of the
  day found the 40-character name cap (ADR 0003 §8 addendum).
- Activation `acc0b898-fe00-4820-b0af-b2238699cfd6`, one attempt, watched on `activation:{id}`:

| time (UTC) | frame | status | step | progress |
| --- | --- | --- | --- | --- |
| 08:30:00.123 | `started` | `pending` | — | 0 |
| 08:30:00.131 | `progress` | `publishing` | publish | 0 |
| 08:30:01.194 | `progress` | `provisioning` | provision | 20 |
| 08:30:10.351 | `progress` | `binding` | bind | 40 |
| 08:30:10.643 | `progress` | `marking_live` | mark_live | 60 |
| 08:30:10.679 | `progress` | `marking_live` | notify | 80 |
| 08:30:10.688 | `live` | `live` | — | 100 |

  Bought `+14128992132` (US), bound to `agent_183c859c53d64dacf07da33e4c` @ `latest_published` with
  `inbound_webhook_url` = our token route; `agents.status = live`, plan `executed`,
  `onboarding_completed_at` set. Publish → live took 10.6 s, almost all of it the number
  purchase.
- The call: `create-phone-call` from the D2 spike number `+16204459730` (the spike agent on
  the caller leg) to the new number. Our inbound webhook authorised it (`calls` row
  `call_5b1b1fe15ad14611cd2a6e546ab` registered at rate 1.0), the agent answered from
  the published version, `call_ended` billed **74 s →
  1.24 credits**, `call_analyzed` stored the analysis.
- Auto top-up: threshold set above the balance, one debit → pending purchase
  `b7582da9-d9f9-4946-a40e-bb30aea8d59c` → off-session PaymentIntent
  `pi_3UI2dMC8uQC6VEv519Z7NNYR` → `payment_intent.succeeded` through `stripe listen`
  → purchase `paid`, **+500 credits, one `topup` ledger row**, balance 996.52.
  No invoice row: an off-session PaymentIntent creates no Stripe invoice (Checkout's
  `invoice_creation` does), so `invoices` is exercised by the e2e suite, not by this run.
- Two things the run taught:
  1. **The caller leg was billed to the callee.** The spike agent's outbound call
     (`call_1e30de1a…`, `from` the spike number, `to` ours, no `metadata.tenant_id`) also posts
     to our webhook, and the D4 fallback (`CallsService`, "our number in this call:
     `to_number` inbound, `from_number` outbound", then the other) resolved it to the new
     workspace and debited a second 1.24. In prod every agent posting to the webhook is ours
     and P2 outbound calls will carry `metadata.tenant_id`, so this only bites a shared dev
     workspace — but the fallback should stop at the direction-correct number. Left for D7 as
     a D4 fix, not a D6 change.
  2. `tsx` (esbuild) emits no decorator metadata, so a Nest DI graph booted under it resolves
     constructor parameters to `undefined`. Anything that boots `AppModule` from a script runs
     from a `tsc` build (`tsconfig.scripts.json`); the earlier scripts instantiate services by
     hand and never noticed.
- Teardown releases the number through `DELETE /numbers/:id`, deletes the knowledge base and
  the agent's platform objects; the workspace stays (ledger history, §17). The first full run's
  teardown failed on a bodiless DELETE sent with `content-type: application/json` (Fastify
  400) and was cleaned up by hand; the script no longer sends the header without a body.
