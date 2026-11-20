# 0035 — The 29 Oct audit's §6.1 defects: recording off, retention, caller countries, first-month rental, `{{business_open}}`

Date: 3 Nov 2026. Status: accepted. Amends ADR 0003 (the agent spec's storage setting),
ADR 0011 (what the lifecycle handlers keep), ADR 0013 §13.8 (the bind step), ADR 0014
(the schedule list) and ADR 0028 (the hours variables). Spec: §5.3, §9.7, §13.8, §13.9,
§17, D3 Settings, D4, D6 Data & privacy.

## Context

The 29 Oct portal audit (`docs/audits/voice-agent-portal-phase-audit.md` §6.1) found
five places where the shipped behaviour contradicted the spec, all of them behind a
screen that said otherwise:

1. **Recording** — `RetellGateway.agentBody` sent `data_storage_setting: 'everything'`
   for every agent; D3's "Recording on/off" only decided whether the agent *said* it was
   recording. A customer who turned recording off was still recorded.
2. **Retention** — `tenants.retention_days` was saved by D6 and read by nothing. No
   schedule purged anything; `RetellGateway.deleteCall` had no caller; the D6 copy promised
   "Older recordings and transcripts are deleted automatically."
3. **Allowed caller countries** — `phone_numbers.allowed_countries` was sent to the
   platform once, at purchase, as `undefined` when empty, never on a PATCH or a SIP import,
   and `decide()` never looked at it. D4 said "Calls from anywhere else are refused."
4. **First month of rental** — `NumberProvisioningService.bind` set `next_rental_at` a
   month out and debited nothing. Spec §13.8 step 2: "first month charged now: −15
   credits". Fifteen credits lost per new number.
5. **`{{business_open}}`** — `decide()` set it to the literal `'true'`. An "always" number
   told the agent the business was open at 3 am; the after-hours template and guardrail 7
   could not work.

Two test problems came with them (§6.2): the D17 destination test minted NANP numbers
whose exchange could start with 0 or 1 (invalid one run in nine), and the restaurant
browser script still expected W3 → W4 from before ADR 0024.

## Decision

### 1. Recording off is the platform's storage setting

`AgentSpec.recording` (required) maps to `data_storage_setting` through
`dataStorageSettingFor()`: `everything` records, `basic_attributes_only` keeps no
transcript, recording or log on the platform. It is the only one of the three values
that stops a recording being made — `everything_except_pii` still records. The value
comes from the version's `recording_enabled` through `runtimeAddOns()`, so the draft
sync before a browser test and the publish carry the same switch, and a draft with
recording off is honoured on its test call while the live agent still records.

The webhook still carries the call's facts, so metering is unchanged. The lifecycle
handlers add a belt: `CallsService.recordingToKeep()` drops a `recording_url` the
payload carries when the version the call ran (`metadata.version_no`, else the live
agent column) has recording off — a call minted before the sync that switched it off, or
a replayed event, never puts a player in D2.

The workspace's `retention_days` is mirrored to the agent as
`data_storage_retention_days` at every sync. That is the platform's own backstop; the
enforcement is ours (§2).

**Assumption to verify on staging:** with `basic_attributes_only` the platform still
delivers the transcript in `call_ended` / `call_analyzed`. The deprecated
`opt_out_sensitive_data_storage` was documented as "can still be accessed securely via
webhooks"; the new field's documentation says only what is *stored*. If a recording-off
agent's calls arrive without a transcript, D2 shows none for them — acceptable under
the customer's own choice, but the D3 copy should then say so.

### 2. Retention is an hourly purge, provider first

`data-retention` (`'40 * * * *'`, lock 50 min) runs `CallRetentionService.purgeExpired()`:
up to 500 rows a tick whose `COALESCE(ended_at, created_at)` is older than their own
workspace's `retention_days`, oldest first, through one SQL join (the window differs per
workspace). Per row:

1. `delete-call` on the platform — skipped for a declined call (never existed there);
   404 = already gone. Any other answer leaves `purged_at` null, writes `purge_attempts`
   and `purge_error` on the row, and pages ops (`retention_purge_failed`) at the third
   failure. The next tick tries again. A call is never marked purged while the platform
   may still hold it.
2. One transaction: `transcript_text`, `transcript_json`, `recording_url` → null,
   `purged_at` = now, and every stored `webhook_events` body for the call rewritten
   through the same matcher SA12 uses (`common/webhook-payload.ts`,
   `redactWebhookPayload(payload, PURGED)`) — transcript, recording and log fields
   replaced by `[purged: retention]`, ids and costs kept.

What stays: duration, credits, outcome and `analysis_json`. The spec names transcripts
and recordings; the analysis is the customer's captured business data (the lead's name,
the outcome) and their ledger history references the row.

Nothing restores purged data: the lifecycle handlers skip transcript and recording
facts for a row with `purged_at` (so an SA12 replay, or a late real delivery, writes
nothing back); `call-recovery` only asks about rows younger than a day; the recording
routes answer 404 for a row without a link.

Migration `20261103100000_calls_retention_purge`: three columns and a partial index on
`created_at WHERE purged_at IS NULL`.

### 3. Allowed caller countries are enforced on the hot path

`num:{e164}` carries `allowed_countries` (optional field, no record version bump —
absent reads as empty, as `transfer_fail_message` does). `decide()` check 3b, after the
blocklist and before the wallet and the cap: when the list is non-empty, the caller's
country is read from `from_number` alone by `callerCountry()` (libphonenumber, E.164
only — a national number is not guessed) and anything outside the list **or unreadable**
(withheld, `anonymous`, the carriers' `+266696687`, malformed) is declined as
`country`. A toll-fraud control that lets an unreadable caller through is not a control;
an empty list keeps today's behaviour, the withheld included.

`country` is a new `DeclineReason` (schema, Prisma enum, migration
`20261103090000_decline_reason_country`, D2 copy in three locales, the inbound metrics).
The decline is the ordinary busy tone with a "Missed" row and reason; a warning line logs
the workspace, the number and the caller's country with the number masked
(`common/mask.ts`), never the full number. The platform's own list stays as a first
line at purchase; our check is the one a direct call to the webhook cannot bypass.

### 4. The first month of rental is charged as the number goes active

`firstMonthRentalDue(row)` (`rental-rules.ts`, pure): a bought number with a rental,
never charged (`last_rental_at` and `next_rental_at` null) and not yet active or paused.
When it is, `bind()` runs `chargeFirstMonth()` **after** the platform binding and in one
wallet transaction under the workspace lock: the row re-read under the lock, the balance
checked with `decideRental()` (the hourly sweep's own rule, now in `rental-rules.ts`), a
`reason = rental` debit with `ref_id = <number id>:<period>` (the activation instant,
under `credit_ledger_rental_debit_once_idx`), then `status = active`, `last_rental_at` =
period, `next_rental_at` = period + 1 month. The amount is the published config's.

A wallet that cannot cover it past the grace throws `insufficient_credits` — permanent,
attempt one — and the transaction rolls back: the row stays `provisioning` and never goes
active unpaid; the activation fails with "Top up at least 15 credits…"; a retry after a
top-up meets the bound number and charges then. A row whose first charge did commit
carries `last_rental_at`, so a retried step, a staff resync or a duplicate job never
charges twice. SIP imports owe nothing (the type is the rule). The activation's
`assertBillingState` and `POST /numbers/buy` refuse up front, before a platform number is
bought for nothing. The hourly `number-rental` sweep is unchanged and picks up the
anniversary `bind` set.

### 5. `{{business_open}}` comes from the workspace hours, on every channel

`businessVariables(hours, now, tz)` (`runtime-cache/hours.ts`) answers
`business_open`, `next_open_time` and `current_time` from `isOpen()` — overnight hours,
closed dates, date overrides, the schedule's own zone, DST through `Intl`; no hours =
open. `num:{e164}` carries the *workspace's* hours as `business_hours`, separate from
the answering schedule `hours`, so an "always" number and a "custom"-hours number still
tell the agent the truth. The inbound path, the W5 browser test, "Call my phone" and
the website widget all send it (spec §9.7: "for web tests, computed at token
creation"). The agent's defaults at sync stay `'true'` — they are placeholders the
per-call variables override.

### 6. The two tests

`nanpNumber()` in `test/d5-fixtures.ts` mints a valid NANP number (exchange and line
from 2–9) and replaces every `+1450` + seven random digits in the suite. The restaurant
browser script follows W3 → W5 → (unpaid: the knowledge page sends the workspace back,
the API refuses a menu on the trial) → the browser test → paid but not live: still no
knowledge page → go-live → W7 lands on the knowledge page → the menu → the live screen.
`dev-seed-workspace.ts --live` completes onboarding the way `mark_live` does, without
buying a real number (that path is `test/d6-activation`).

Two more harness weaknesses surfaced while running the whole suite repeatedly on one
database: `d12-admin`'s own number was `+1450555` + four run-id characters (a unique-index
collision after enough runs) and its `afterAll` deleted every pricing version when
`beforeAll` had failed before reading the one to keep (`gt: 0`), which emptied
`pricing_configs` for every suite after it. Both fixed in the suite; a shared dev database
still needs `pnpm db:seed` after an aborted run, and the SA12 kill switches are shared
state between suites (CLAUDE.md, "Working agreements").

## Alternatives considered

- **Hiding the recording in D2 only.** The audit's point: the platform still held it.
- **`everything_except_pii` for "off".** Still records.
- **A nightly purge.** Hourly at 500 rows drains a backlog without a long night run and
  catches a shortened retention within the hour.
- **Purging `analysis_json` too.** Not what the spec's retention names; the captured
  fields are the customer's business records. Revisit if counsel reads §17 wider.
- **Enforcing countries only through the platform's list.** Sent once, never updated,
  and bypassable by anything that reaches the webhook directly.
- **A separate `rental` activation step.** Changes the wire step enum, the portal copy
  in three locales and SA7's view for what is one row write; charging inside `bind` keeps
  "active" and "paid" in one transaction.
- **Marking a number `rental_overdue` instead of failing the bind.** Would leave a
  bought, bound number answering calls it never paid for.

## Consequences

- `pnpm --filter @portal/api agents:republish --apply` once per environment after the
  deploy: a live agent's storage setting and retention only change at its next sync.
- Verify the recording-off transcript assumption (§1) on staging with one call before
  cutover; note the outcome here.
- `test/d19-retention.e2e.test.ts` (6 cases), the country / `business_open` / recording
  cases in `test/calls.e2e.test.ts`, the first-month cases in `test/d6-activation.e2e.test.ts`,
  the storage-setting case in `test/agent-settings.e2e.test.ts`, and the pure rules in
  `caller-country.test.ts`, `hours.test.ts`, `inbound.decide.test.ts`,
  `retell.gateway.test.ts`, `number-rental.test.ts`.
- Audit §6.1 #6–#12 (MFA rule, token lifetime, publish confirm, margin floor seed, the
  three Low items) are untouched by this ADR; they are tasks 8–16 on the 3 Nov timeline.
