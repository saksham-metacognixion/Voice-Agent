# 0032 — QA batch, 28 Oct: the D2–D6 spec gaps and three console fixes

Date: 28 Oct 2026. Status: accepted. Covers QA-066, QA-071, QA-072 (reopened) and
QA-077 → QA-083 in the QA tracker. **Supersedes ADR 0019 §8 on "Export all data / delete
workspace"**; amends ADR 0012 (the transfer rule, test-call versions, "Save as new
version"), ADR 0020 §5 (the agent's script, now with a recording notice) and ADR 0021
(the health strip). Builds on ADR 0006 (RLS), ADR 0010 (the ledger), ADR 0014 (outbox,
ops alerts), ADR 0018/0019 (the dashboard), ADR 0029 (test-call mints).

## Context

QA compared the dashboard against the spec's element tables (D2 p. 35, D3 pp. 35–36,
D4 p. 37, D5 p. 38, D6 p. 39, W5 p. 24) and logged what was missing. Two items had been
held back on purpose — QA-079 ("ask Pramod which are MVP") and QA-081 (ADR 0019 §8 had
chosen a `mailto:` for export and deletion) — and the product owner has since asked for
the spec's version of both. Three console bugs came back reopened: the webhooks table
still clipped Replay at 1366 px, a missing record still offered Retry, and every page
still took 4–5 s to settle.

## Decision

### 1. Console (QA-066, QA-071, QA-072)

- **Pinned actions.** The console `DataTable` takes `sticky` per column: the cell is
  pinned to the end edge with its own opaque background (card + the header or hover
  tint as a `::before`). The webhooks and jobs tables pin their actions, let an event /
  job type wrap (`checkout.session.async_payment_succeeded` has no break opportunity),
  and drop the external id / "updated" column under a 60 rem *container*. Replay is never
  clipped, however narrow the table.
- **Not found is not an error to retry.** `LoadError` shows no Retry for `NOT_FOUND` and
  takes an optional `back` (link or button): the customer, user and ticket views name
  their list. `pollUnlessError()` stops a detail page polling a record that answered an
  error. The generated `QueryHookOptions.refetchInterval` accepts a function for it.
- **Nothing on the navigation path waits on a provider.** `/admin/system/health` serves
  the last voice-platform / Stripe probe from Redis (`admin:health:{provider}`, kept
  10 min) and refreshes one older than 60 s behind the response (`probeAction()`,
  single-flight per process); it waits only when nothing is cached. `useStaffMe` and the
  health strip keep their 30 s poll but a 5-minute `staleTime`, so a page (each mounts
  its own shell) does not ask again on navigation. A hard load is still auth → `me` →
  the page, by design: the page's permissions come from `me`.

### 2. D2 call detail (QA-077)

Copy number and "Call from your phone" (`tel:`) use the other party (`otherPartyNumber()`:
`from_number` inbound, `to_number` outbound; nothing for a browser call) — named apart
from D18's agent "Call back". Copy transcript is speaker-labelled text
(`transcriptPlainText()`). "Report a problem" is one `ReportCallButton` for the drawer and
Help: editors and up open a ticket (`POST /support/tickets`, category `calls`,
`linked_call_id`); a viewer, who cannot open tickets, keeps the `mailto:`. **Recording
download** is owner/admin: `recordingResponse.download_url` carries a `RecordingSigner`
token of purpose `download`, and `…/recording/stream?download=1` accepts only that
purpose and answers `Content-Disposition: attachment`. A playback token cannot download
and a download token cannot play; the platform URL still never reaches the browser.

### 3. D3 agents (QA-078, QA-079)

- **Duplicate** (`POST /agents/:id/duplicate {name?}`, editor+) copies the source's
  **draft** — not its newest row, which after a discard is the draft thrown away — into
  v1 of a new draft agent (`source = manual`, as W1's v1): brief with documents, analysis
  fields, settings, script, greeting, closing, card, scenarios, lint, stack version. Not
  copied: numbers, knowledge sources, the widget, history, platform objects (created at
  the copy's first test call or publish, as for W1). `copyAgentName()` keeps the suffix.
- **Room for an agent** (`assertRoomForAgent`, per-workspace advisory lock): a paused
  workspace creates nothing; the plan's `max_agents` holds for Duplicate always and for
  `POST /agents` **once onboarding is complete** — W1 makes a new draft agent whenever
  the person picks another template, and a trial allows one. `POST /agents` had listed
  `PLAN_LIMIT` / `WORKSPACE_PAUSED` in the manifest without checking either.
- **Discard draft** (`POST /agents/:id/draft/discard`) is a pointer move, like "Restore as
  draft": `draft_version = published_version`, no row written, the discarded draft stays
  in Versions. `409 AGENT_NOT_PUBLISHED` / `NO_DRAFT_CHANGES`. Offered on Overview only,
  where no autosave can fork the restored version again.
- **Save as new version** (`POST /agents/:id/versions`) appends a copy of the draft as the
  new draft, so the previous row is overtaken and the immutability trigger freezes it. A
  draft that is already frozen writes nothing (`created: false`).
- **Denoise and PII removal travel with the version** (`agentSettings.denoise`,
  `.pii_removal`), gated by `denoise` / `pii_removal` (`PLAN_LIMIT` with the gate as the
  field; turning one off is never gated). `runtimeAddOns()` re-applies the gate at every
  sync, so a workspace that loses the gate has the add-on sent off while the version keeps
  the choice. Denoise = `noise-and-background-speech-cancellation`; PII = post-call
  `pii_config` over SSN, passport, driver's licence, card, bank account, password, PIN,
  medical id, date of birth and customer account number — **not** name, phone, email or
  address, which a message-taking agent exists to capture and `captured_checks` reads.
- **Analysis fields are editable** (gate `analysis_fields`, ≤ 15, unique names). Template
  fields are not locked: nothing keys on their names (`isPhoneFieldName` matches any
  phone-like field). Once edited, `settings.analysis_fields_edited` makes the list the
  customer's and a regenerate keeps it.
- **No per-agent voicemail toggle.** An inbound agent leaves no voicemail; detection is
  per outbound call and lives in D18's outbound settings, which the Settings tab links.

### 4. D4 hand-off (QA-083)

`phone_numbers.transfer_fail_message` (≤ 500, CHECK as backstop) travels in `num:{e164}`
and reaches the call as the **`transfer_fail_message` dynamic variable**, always supplied
— empty from the agent's defaults, the number's value on inbound (from the record the hot
path already reads, no extra round trip), the calling number's on "Call my phone" — since
the platform leaves an unsupplied `{{variable}}` as literal braces. `TRANSFER_RULE` reads
it word for word when set and keeps its old words otherwise; braces are stripped from the
customer's text so it cannot summon `{{transfer_number_N}}`, and the number's own targets
are replaced by "our staff" (BUG-005). The rule change reaches a live agent at its next
sync: **`agents:republish --apply` once per environment.**

### 5. D5 ledger (QA-080)

`?reason=` is kept in the URL; `POST /wallet/ledger/export {reason?}` (owner/admin — a
file of the whole billing history is billing under §6.1) streams CSV, 500 rows per
`withWorkspace`, 10 000 max. Amounts stay numbers (the formula guard would make a
negative debit text a spreadsheet cannot sum); text cells keep the guard.

### 6. D6 Data & privacy (QA-081) — supersedes ADR 0019 §8

- **Export all data** (`POST /workspace/export`, owner/admin, verified) streams a zip
  synchronously: no object storage is configured, so an async job would have nowhere to
  leave the file. Safe because every file is capped (10 000 rows; 2 000 versions), read in
  short batches, compressed as it streams (a small `node:zlib` writer — `jszip` is a dev
  dependency and absent from the `--prod` image), and limited to 5 an hour per workspace
  (`ratelimit:data-export:{ws}`). It leaves out platform ids and the carrier, inbound
  tokens, SIP details, Stripe ids, invite token hashes and knowledge file bodies. The
  `data_requests` (`export`, executed) and audit rows are written before the first byte.
- **Delete workspace** is a *request*, owner only, verified, with the workspace name typed
  (`POST /workspace/delete-request {confirm}`): one open `data_requests` row (`delete`,
  due in 30 days — the usual privacy-request window), a high-priority `account` ticket
  staff see in SA4, an audit row and an ops alert. **Nothing is deleted, released or
  forfeited by the route**; carrying it out remains staff's §17 anonymisation job. The
  owner can withdraw (`DELETE`) until then; the ticket is reopened with the withdrawal.
  `data_requests` gains a tenant-isolated `portal_app` window: SELECT/INSERT on its own
  rows, UPDATE of `cancelled_at` only, a CHECK that refuses a customer `delete` row
  marked executed, no DELETE.
- **PII-removal default** (`tenants.pii_removal_default`, gated) and the recording default
  are now applied to new agents (the latter never was, though the tab said so).
- **Recording notice** (`tenants.recording_notice`, **on by default**,
  `recording_notice_text` optional): a recording agent says it before its greeting. Added
  at sync like the documents block (`prompting/recording-notice.ts`), never stored;
  default text per agent language (full locale → base → English), idempotent. Every
  recording agent starts saying it at its next sync — that is the spec's "auto-insert" and
  the safe default for consent; a workspace turns it off on the Privacy tab.

### 7. W5 (QA-082)

`TestCallPanel` offers a version picker when more than one version is testable — the
current draft and anything ever published (`testableVersions()`); the browser test and
"Call my phone" both use it. **`409 VERSION_NOT_TESTABLE`**: the platform holds one
editable draft that every sync rewrites, so testing an older never-published draft rang
the newer script without an error. W5's Continue waits for "I'm happy with how my agent
sounds"; "Skip testing" warns and continues (`w5_happy` / `w5_skipped`).

## Alternatives considered

- **Keep the `mailto:` for export and deletion** (ADR 0019 §8). Its reason — "a button
  that cannot work" — no longer holds: the button files a tracked request with a due date
  and a ticket, and deleting still waits for staff.
- **An async export job.** Nowhere to store the file until object storage exists; revisit
  then, behind the same route.
- **A version source value `duplicated`.** A Postgres enum migration for no reader; the
  audit row names the source agent and version.
- **Enforce `max_agents` from W1 on.** Locks a trial out of picking a second template.

## Consequences

- Per environment after the deploy: `pnpm db:deploy` (three migrations) and
  `pnpm --filter @portal/api agents:republish --apply` (the transfer rule, the recording
  notice, the add-ons).
- Staff have no screen for `data_requests` and no deletion job yet (SA11, P2); the
  ticket and the ops alert are how a request is seen.
- The seed gives Growth the `denoise` gate where the spec says Scale+; changed in SA5 if
  the owner agrees, not in the seed.
- Exit checks: `test/agents.e2e.test.ts`, `test/agent-settings.e2e.test.ts`,
  `test/d6-numbers.e2e.test.ts`, `test/calls.e2e.test.ts`, `test/calls-api.e2e.test.ts`,
  `test/d9-test-call.e2e.test.ts`, `test/d11-data-requests.e2e.test.ts`,
  `test/d17-channels.e2e.test.ts`; the portal's `e2e:wizard` (the W5 gate) and
  `e2e:dashboard-d11` (D5 export, D6 data requests).
