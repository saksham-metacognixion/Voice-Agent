# ADR 0014 — Recurring operations, notifications, the API contract and the staging stack (D7)

- Status: accepted
- Date: 2026-09-22
- Deciders: Saksham
- Scope: §13.11 (scheduled jobs), §5.3 (recurring deductions), §5.4 (low-balance alerts, auto
  top-up), §14.2 (reconciliation), §14.3 (concurrency), §15 `alerts` / `notification_settings`,
  §16 (the contract), §13.12 (environments), ADR 0004 (the EC2 stack).
- Builds on: [ADR 0010](0010-wallet-ledger-and-pricing-config.md) (wallet lock, FIFO, expiry),
  [ADR 0011](0011-call-runtime-and-queues.md) (`active:{ws}`, the queues),
  [ADR 0013](0013-provisioning-activation-and-billing.md) (numbers, auto top-up).

## Context

D1–D6 built everything a request can trigger. D7 is what has to happen when nobody is asking:
the monthly number rental, credits lapsing, the customer being told their balance is low, the
nightly check that the voice platform and our `calls` agree, the concurrency watch, the
morning digest. Every one of these runs on a timer, on a worker that may be restarted or
duplicated, against money. The questions ADR 0013 asked of activation apply to each: what if
it runs twice, what if two workers run it at once, what if the process dies halfway, what if
the provider succeeded but we timed out.

Also due on D7: the CI/CD pipeline that publishes the backend image, the EC2 compose stack with
TLS, and the API contract the frontend days (D8+) will build against.

## Decisions

### 1. Schedules are upserted by id, swept of strangers, and each tick runs under a lock

`SchedulerRegistrar.register()` upserts every entry of `SCHEDULES` (BullMQ job schedulers are
keyed by id, so a restart or a second worker updates rather than duplicates), removes any
scheduler in Redis whose id is no longer in the code (a renamed schedule would otherwise fire
forever into a handler nobody registered), reads the count back and logs it. The e2e suite
registers three times, plants a stranger, and asserts the count from a fresh connection.

BullMQ never hands one tick to two workers, but a tick that outlives its interval meets the
*next* tick on another worker. Every tick therefore takes `lock:schedule:{name}` (`SET NX`,
TTL twice the interval or one hour) and skips with a log line when it is held. Redis
unreachable means the lock cannot be proven and the tick is skipped: every schedule is a
backstop that runs again, so a missed tick is cheaper than a doubled one. The lock is released
only while it still holds the tick's own token.

### 2. Rental is a ledger row per (number, period), advanced in the same transaction

`number-rental` runs hourly. A platform-bought number (`type ≠ custom_sip`) whose
`next_rental_at` has passed is charged `pricing.recurring.number_rental_credits` — from the
published config, never a constant — as a `rental` ledger row with
`ref_type = number_rental`, `ref_id = <number id>:<period ISO>`. A partial unique index on
that `ref_id` makes the period idempotent the way the call debit is idempotent on its
`call_id`. The debit and the advance of `next_rental_at` (+1 calendar month) happen in one
wallet transaction under the per-workspace advisory lock, and the row is re-read under the
lock, so a number released between the sweep and the lock is skipped and two workers cannot
both see the period as due.

The wallet's one rule for recurring charges (never debit past the grace) is `decideRental()`:
if `balance − rental < −grace` the number goes **overdue** instead — `rental_overdue_since`
is set, `next_rental_at` stays where it is (the period is still owed), a `rental_overdue`
alert opens on day 0 and at each `rental_warning_days` day, and `number-release` (daily)
releases the number once `release_after_days_at_zero_balance` have passed — platform first,
row `released` after, exactly the DELETE path, so a platform failure leaves the row
`releasing` and the next day retries. A top-up in between charges the owed period on the
next hourly run and clears the overdue clock and its alerts.

### 3. Alert state lives in `alerts`, keyed, with a resolution

`alerts` gains `key`, `resolved_at` and `meta_json`, and a partial unique index
`(tenant_id, key) WHERE resolved_at IS NULL`. Opening an alert is an `INSERT … ON CONFLICT DO
NOTHING`; while the row is open the same key cannot open again, which is the whole anti-spam
rule for a schedule that runs every fifteen minutes. `resolve()` closes it when the condition
clears, and the next crossing opens a fresh row. Dismissal (`POST /alerts/:id/dismiss`) hides
the banner and does not touch the state machine. `GET /alerts/active` is the D1 banner and
the `alerts` SSE topic carries `opened` / `resolved` / `dismissed`.

Low balance (§5.4): thresholds are `low_balance_thresholds_pct` of the last paid pack (the
trial size before any purchase), crossed at *or below*; `decideLowBalance()` is pure and
unit-tested. Evaluated on every ledger write (a debit may cross, a grant may clear) and by the
15-minute sweep. Concurrency (§14.3): `decideConcurrency()` reaches the threshold at
`ceil(cap × CONCURRENCY_ALERT_PCT / 100)` live reservations in `active:{ws}` — 8 of 10 at the
default 80% — opens once, resolves below, and a workspace whose hash has expired away is
resolved by a second pass over the open alerts. Redis unreachable decides nothing — and
that includes a SCAN that did not answer or did not finish: `RedisCache.scanKeys()` returns
`null` or `complete: false` rather than a shorter list, because an empty result read as "no
live calls" would resolve every open alert and clear the platform incident while the calls
are still live, and the next tick would page ops again for the same crossing (review, 21 Sep
2026).

### 4. Every customer message goes through an outbox

`notifications` is one row per message we decided to send, `dedupe_key` unique:
`INSERT … ON CONFLICT DO NOTHING` is the claim, and only the process that inserted the row
sends. A crash between the claim and the send leaves a `pending` row that `retryFailed()`
re-sends from the stored body — so the failure mode of a dying worker is a late email, never
two. Keys: `low_balance:<alert id>:<user>`, `rental_overdue:<alert id>:<user>`,
`number_released:<alert id>:<user>`, `daily_digest:<ws>:<local date>[:<user>]`. Recipients
come from `memberships` × `notification_settings` (own row, else the workspace default, else
the §15 defaults); the email sender is Resend over `fetch` when `RESEND_API_KEY` is set and a
log line otherwise, and bodies never carry a token or a secret.

### 5. The daily digest is hourly and per timezone

`daily-digest` runs **hourly**. Each tick asks every workspace two questions in its own
`tenants.timezone`: is it past `DIGEST_LOCAL_HOUR` (default 8), and has the digest for my
*previous local day* gone out? The window is the interval between two local midnights
(`local-day.ts`, Intl-based, unit-tested on both DST transitions and on half-hour zones), so
the fall-back day is 25 hours and the spring-forward day 23. One UTC midnight run would have
mailed Kolkata at 05:30 and Vancouver at 16:00. Recipients are members whose effective
`new_message` is `daily`; no recipient or no activity is recorded as `skipped` under the same
key so the decision is not re-made every hour.

### 6. Reconciliation is a row per window, alerting once

`reconcile-calls` (02:30 UTC) lists yesterday's UTC day from the platform — paged, with a
page cap that marks the run `partial` rather than reporting drift against a truncated list —
and compares it with our non-declined `calls` in the window. `reconcile()` is pure and
deterministic: ids missing on our side (calls never billed), ids the platform does not know,
seconds on matched calls, and `combined_cost` cents vs `retell_cost_cents`. `drift_pct` is
the larger of the id drift and the seconds drift; the threshold is
`RECONCILE_DRIFT_THRESHOLD_PCT` (default 5). The run is upserted on
`(window_start, window_end)` in `reconciliation_runs` with the ids to investigate; the ops
alert is gated by `alerted_at` with a conditional update, so a rerun — or two workers — page
once per window. A provider error is a `provider_error` run and its own alert, never "every
call is extra".

### 7. Auto top-up accepts a success after a failure

Reviewing the webhook orderings for D7's tests found one unsafe case: Stripe may deliver
`payment_intent.payment_failed` (an earlier attempt) after `payment_intent.succeeded`, or the
reconcile sweep may abandon a purchase moments before the success arrives.
`fulfilPaymentIntent` now credits a purchase that is `pending` **or** `abandoned` when the
intent succeeded and the amount matches; `paid` stays idempotent. Stripe has the money either
way; the credits follow.

### 8. The contract is a manifest joined with the controllers' own metadata

There was no OpenAPI, and converting every controller to DTO classes would have rewritten
D1–D6 for no behavioural gain. Instead `backend/api/src/openapi/manifest.ts` lists every route
once with the `@portal/schemas` export names of its body, query and response, its deliberate
error codes and its prose; `discover.ts` reads method, path, `@Public`, `@NoWorkspace`,
`@Roles`, `@RequireEmailVerified` and `@HttpCode` from Nest's decorator metadata. The join
refuses a route in one and not the other, a role mismatch, or a schema name that does not
exist. From the join: `docs/api/openapi.json` (zod → OpenAPI via nestjs-zod's converter, error
responses by status with `x-error-codes`, `x-auth`, `x-roles`) and
`frontend/api-client/src/generated/endpoints.ts` (one typed function per operation over the
existing `ApiClient`, parsing the response with the same zod schema, plus a TanStack hook
each). `pnpm --filter @portal/api openapi:check` regenerates in memory and fails CI on drift.

### 9. The staging stack and the worker's CPU cap

`infra/docker-compose.prod.yml`: `api` (uncapped — it owns the §13.9 hot path), `worker`
(`cpus: '1.0'`, `memory: 1g`, healthchecked through a heartbeat file the worker touches every
30 s), `redis` (AOF, `noeviction`, compose-internal), `caddy` (Let's Encrypt for `API_DOMAIN`,
SSE with no buffering, HSTS). Configuration is written on the instance by
`infra/scripts/deploy.sh` from SSM Parameter Store `/voice-agent/<env>/*`; nothing is in the
repo or in CI. CI builds the image on every PR, publishes it to GHCR on pushes to `develop` and
`main` (`sha-<7>`, the branch, `latest` on main), and deploys `develop` to staging over SSM Run
Command when the repository's `staging` environment has `STAGING_INSTANCE_ID`, `AWS_REGION`
and the `ci` user's keys. `GET /health/ready` reports Postgres, Redis and the worker heartbeat
(503 when Postgres or Redis is down) so the deploy script can gate on it.

## Alternatives considered

- **One UTC digest run with a per-workspace offset column.** Simpler to schedule, wrong on DST
  days and for every workspace whose offset is not whole hours; the hourly sweep costs one
  cheap query per workspace per hour.
- **Rental as a Stripe subscription.** Would move the money question to Stripe, but the unit is
  credits, not dollars (§5.1), and the release-after-N-days rule has no Stripe equivalent.
- **Alert dedupe in Redis.** Fast, but the state has to survive a Redis restore from snapshot;
  a partial unique index is the same idea with the right durability.
- **`@nestjs/swagger` with `createZodDto`.** The conventional Nest route; rejected for D7
  because it rewrites every controller and still cannot state error codes or roles, which are
  the parts of the contract the portal branches on.
- **Deploy over SSH.** A long-lived key in a third party; SSM Run Command is IAM-authenticated
  and logged (ADR 0004).

## Consequences

- Twelve of the thirteen §13.11 schedules are live; `kb-sync` stays a skeleton — the platform
  re-crawls URL sources itself and nothing in P1 needs the schedule.
- New tables `notifications`, `reconciliation_runs`; new columns on `alerts` and
  `phone_numbers`; one new partial unique index on `credit_ledger` (rental periods). Migration
  `20260922080000_d7_recurring_ops_notifications`.
- New module `notifications` (§13.1); `numbers` gains `NumberRentalService`; `calls` gains
  `CallReconciliationService` and `ConcurrencyMonitorService`; `jobs` gains `WorkerHeartbeat`.
- New routes: `GET /health/ready`, `GET /alerts/active`, `POST /alerts/:id/dismiss`,
  `GET|PATCH /workspace/notification-settings`. New SSE topic `alerts`.
- New environment knobs, all defaulted: `RECONCILE_DRIFT_THRESHOLD_PCT`, `CONCURRENCY_ALERT_PCT`,
  `CONCURRENCY_PLATFORM_LIMIT`, `DIGEST_LOCAL_HOUR`, `WORKER_HEARTBEAT_FILE`; `RESEND_API_KEY`
  turns emails on.
- **Staging is not yet deployed.** The AWS account has no instance, Elastic IP, SSM parameters
  or domain for this project, and the only credentials on the development machine belong to
  another project's deploy user (ADR 0004's "what we need access to" list still stands). The
  stack, the deploy script, the CI job and the runbook (`docs/runbooks/staging.md`) are complete
  and validated (`docker compose config`, a local image build); the first deploy is the runbook's
  checklist once the instance exists.
- `pnpm openapi:generate` is now part of adding or changing a route: CI fails until the
  manifest and the two generated files agree with the controllers.
