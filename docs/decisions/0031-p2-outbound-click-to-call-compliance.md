# 0031 — D18: outbound click-to-call behind its compliance gates

Date: 28 Oct 2026. Status: accepted (engineering); **§3 and §4 need a legal read before
customers use outbound**. Builds on ADR 0011 (§1 reservations, §4 rate captured once, §7
call recovery), ADR 0029 (D17: "Call my phone", `MintSlot`, `checkTestDestination`),
ADR 0006 (RLS, two roles), ADR 0021 (staff writes and their audit). Plan: D18 in
`docs/plan/tasks.csv` ("Outbound, but only behind the compliance gates TCPA/CRTC
require", spec tag §17). Exit check: outbound is blocked for a tenant without KYC and a
verified caller ID.

## Context

D17 already places outbound legs: "Call my phone" and the forwarding test. Both ring the
customer's own phone and are tests (ADR 0029 rejected "Call my phone to any number" as
"an outbound dialler without D18's gates"). D18 is the first outbound call to someone
other than the customer: the D2 call detail's click-to-call.

None of the gates existed: no business verification, no caller ID verification, no
do-not-call list, no calling-window rules, no outbound cap. The admin data model had
`blocklists` (type `phone`), unused, and a seeded `outbound_calls` feature flag (off).
The portal spec PDF is not in the repo; the extract names no outbound route beyond
Appendix A's `create-phone-call`. What the platform takes was read from retell-sdk 6.0.1:
`create-phone-call` accepts `agent_override.agent.voicemail_option` per call
(`null` = no detection; `hangup`; `static_text`; `prompt`), and its docs say a number
bought from the platform dials **US destinations only**.

## Decision

### 1. Who may call out: business verification and verified caller IDs

- **KYC is a workspace state**: `tenants.kyc_status` ∈ `none | pending | verified |
  rejected`, `kyc_json` (legal name, registration number and country, address, contact,
  optional national DNC registration id), submitted/decided times and a customer-facing
  rejection sentence. The customer submits (`POST /outbound/kyc`, owner/admin → `pending`);
  **staff decide** (`POST /admin/customers/:id/kyc`, super admin and ops — the new
  `STAFF_ROUTE_ROLES.compliance` — with a reason code, `staff_audit_log` + the workspace's
  `audit_log` in the write's transaction). Rejecting a verified business withdraws it and
  stops the next callback. No KYC vendor is integrated; the check is staff reading the
  submission (an owner decision whether to add one).
- **A caller ID is a verified number of the workspace**: `phone_numbers.caller_id_verified_at`
  + `_via` (`purchase` | `staff`). A number bought on the platform is ours and is verified
  when `bind` attaches it (migration backfills live ones). A SIP import is verified only by
  staff (`POST /admin/numbers/:id/caller-id`, after an LOA or a carrier bill), who may also
  revoke any number. `via = staff` is never overwritten by provisioning, so a revoke sticks.
- **Enforced in Postgres too.** The customer role has table-level `UPDATE` on `tenants`
  and `phone_numbers` (settings, routing), so RLS alone would let a bug on a customer path
  mark itself verified. A `BEFORE UPDATE` trigger (`app.guard_outbound_verdicts`) refuses a
  verdict or a caller-ID change from any role that is `portal_app` and not `portal_admin`;
  the customer may only move KYC to `pending`. Same idea as the append-only triggers.

### 2. One entry point, one decision

- **Outbound is a callback.** `POST /calls/:id/callback {idempotency_key, number_id?}`
  rings the other party of a D2 call (the caller of an inbound call, the callee of an
  outbound one). No route takes a typed destination, so nobody can be dialled who is not
  already in the workspace's call history, and there is no other path to a non-test
  outbound call to bypass. `GET /calls/:id/callback` answers the same verdict without
  placing anything, which is how D2 shows why the button is off and when the window opens.
- **The gates are a pure function**, `decideOutbound()` (`modules/outbound/outbound.decide.ts`),
  in this order: the `outbound_calls` flag → workspace not paused → KYC → settings and time
  zone usable → caller ID → the call's agent live and published → destination valid (not
  withheld, real, not premium-rate) → its country has calling rules → not one of the
  platform's numbers (D17's rule) → not on a do-not-call list → prior contact → inside the
  calling window → a paid pack → credits → today's cap. "Who may call" comes before "whom",
  "whom" before "when", "when" before "how much".
- Then the writes, each atomic: the **daily cap** under a per-workspace advisory lock
  (`outbound:<ws>`), counting `outbound_calls` rows of the workspace's local day in
  `pending|placed` and inserting this one; then the plan's **line** through `MintSlot`
  (ADR 0029); then the platform. A refusal at any of them, or a provider failure, marks the
  attempt `failed` (it no longer counts) and frees the line.
- **Every refusal is audited**, `audit_log` `call.outbound_blocked` with the reason code,
  the destination masked to country code + last two digits, its country, the caller ID and
  agent ids, the IP and the request id (`ctx.requestId`, new). A provider failure is
  `call.outbound_failed`; a placed call `call.outbound_placed`. A refused attempt writes no
  `outbound_calls`, `calls` or ledger row and never reaches the platform.
- **Idempotency**: `outbound_calls (tenant_id, idempotency_key)` is unique and re-read under
  the cap lock. The same key again returns the same call (nothing new rung); while it is
  being placed, `409 OUTBOUND_IN_PROGRESS`; after a failure the same key may try again; a
  key reused for another call is `409 CONFLICT`.

### 3. Do-not-call and prior contact

- **Two lists are checked**: the workspace's own (`dnc_entries`, unique per number; 47 CFR
  64.1200(d) and CRTC UTR Part II require a business to keep and honour one) and the
  platform's (`blocklists` type `phone`, staff-maintained, honouring `expires_at`). D2 adds
  the other party of a call in one click (editor and up); removing an entry is owner/admin.
  The refusal does not say which list matched.
- **No national registry is integrated** (US National DNC Registry needs a SAN and a
  31-day re-scrub; Canada's National DNCL a registration). Instead, **a callback goes only
  to someone who called the workspace within `prior_contact_days`** (default 90) — any real
  inbound phone call, answered or missed. That inquiry is what the established business
  relationship exemption rests on (TSR/TCPA: 3 months after an inquiry; CRTC: 6 months), so
  the stricter of the two is the default. The workspace and platform lists still apply
  on top: an EBR never overrides a request not to be called. **Engineering's reading, not
  legal advice** — confirm before launch; loading registry extracts into `blocklists` is the
  path if counsel wants registry scrubbing too.

### 4. Calling windows

- Rules live in the versioned pricing config, `outbound.countries[CC]`: the zones the
  country's numbers can ring in, a window per weekday (null = no calls), and closed dates.
  Defaults: **US** 08:00–21:00 every day (47 CFR 64.1200(c)(1)); **CA** weekdays
  09:00–21:30, weekends 10:00–18:00 (CRTC Telemarketing Rules). A country without a rule
  cannot be called (`DESTINATION_COUNTRY`); staff add one with a pricing publish.
- **A call is allowed only when it is inside the window in every zone of the destination's
  country.** A number does not say where its owner is (mobile numbers keep their area code),
  so this is the conservative reading of "the called party's local time". It narrows the US
  window to 2 pm–9 pm Eastern. Narrowing by area code is possible later (a maintained NANP
  area-code → zone table) but is a legal-risk trade, not made here. Each zone is judged on
  its own wall clock (`localClock`, Intl): its weekday, its holiday date, its DST. Nothing
  models DST, which proved itself in the tests: tzdata 2026c keeps British Columbia and
  Alberta on permanent daylight time, and the evaluator followed without a change.
- The next permitted minute is found by stepping five minutes up to eight days ahead, then
  back to the minute; past that it is not named. State holidays and stricter state rules
  (Florida, Texas…) are `closed_dates` / narrower windows staff can configure; none ship.
- The workspace's business hours do not restrict outbound; the destination's law does.

### 5. Caps, voicemail, metering

- **Daily cap per plan tier**, `outbound.daily_caps` (trial 0, starter 20, growth 50, scale
  150, pro 400, volume 1000), counted per workspace-local day (`tenants.timezone`), every
  attempt that reached the platform counting whether or not it was answered.
- **Voicemail** is a workspace setting (`tenants.outbound_settings_json`, `PUT
  /outbound/settings`, owner/admin): `hang_up` (default — a machine is not the person who
  asked to be called back, and every second is billed), `leave_message` (≤ 300 characters,
  spoken as `static_text`) or `off`. Sent per call as `agent_override.agent.voicemail_option`,
  so the agent and its published version are untouched. Unparseable stored settings refuse
  (`OUTBOUND_NOT_CONFIGURED`) rather than fall back silently.
- **Metering is unchanged.** The call runs the agent's **published** version (explicit
  `override_agent_version`, numbers stay `latest_published`) at the live tier, billed by
  `call_ended` at the tier rate — no separate outbound rate — through the same ledger row
  idempotent on `call_id`. The API writes the `calls` row (`registered`, direction
  `outbound`) as soon as the platform answers (`CallsService.recordOutboundPlaced`,
  `skipDuplicates`), capturing the rate and config version once as the row's creator; the
  lifecycle events move it on, and `call-recovery` settles it if they never come.
  Metadata `{tenant_id, agent_id, version_no, tier, test: false, number_id, outbound_id}`.

## Alternatives considered

- **A dialler that takes any number.** Needs consent records and a registry subscription
  to be defensible; the callback scope needs neither and is what the D2 task asks for.
- **Redis counter for the daily cap.** Fast and atomic, but a restart or eviction resets it
  and the cap is a compliance limit; the Postgres row is also the attempt's record.
- **A tenant's own time zone for the window.** The rule is about the called party.
- **Area-code time zones.** See §4.
- **Gating "Call my phone" too.** It rings the customer's own phone (ADR 0029); not a call
  to a consumer.

## Consequences

- New tables `outbound_calls`, `dnc_entries` (RLS, in the RLS matrix); columns on
  `tenants` and `phone_numbers`; the guard trigger. Routes: `GET|POST /calls/:id/callback`,
  `GET /outbound`, `PUT /outbound/settings`, `POST /outbound/kyc`, `GET|POST /dnc`,
  `DELETE /dnc/:id`, `GET|POST /admin/customers/:id/kyc`, `POST /admin/numbers/:id/caller-id`.
- The `outbound_calls` flag stays off (rollout 0) until legal signs off §3–§4; the gates are
  live regardless of the flag's state.
- **Not verified against the live platform**: `voicemail_option` per call, and whether a
  platform-bought number may dial Canada (its docs say US only — a Canadian callback from a
  bought number may fail upstream and is reported as `UPSTREAM_UNAVAILABLE`). One staging
  call each before customers use it.
- Exit checks: `test/d18-outbound.e2e.test.ts` (17 cases; the first is the D18 exit check),
  `modules/outbound/{calling-window,outbound.decide}.test.ts`, the RLS matrix.

## Addendum — 28 Oct 2026: an attempt the platform never answered

Review of the first cut found that an attempt could be lost two ways, and that a retry
could ring someone twice:

- **No answer is not a failure.** The platform has no idempotency keys, so a timeout, a reset
  or a 5xx from `create-phone-call` may have rung the person. Only a 4xx (other than 408)
  marks the attempt `failed`, and only then may the same key try again. Anything else leaves
  it `pending` (`failure = unconfirmed`), counting toward the cap, and its key answers `409
  OUTBOUND_IN_PROGRESS`.
- **The webhook binds the attempt.** Every callback carries `metadata.outbound_id`; the first
  lifecycle event for the call (`CallsService.bindOutboundAttempt`) marks that attempt
  `placed` with its `call_id`, so the key replays that call. This also covers a restart
  between the claim and the answer.
- **Write-off.** A `pending` attempt with no call `UNCONFIRMED_ATTEMPT_MS` (5 min) after it was
  last touched stops counting, and the next claim writes it off as `failed` under the
  workspace lock. There is no sweeper: the claim, the count and the replay all apply the same
  cut-off. If the platform also drops every lifecycle webhook for a call that did ring, a
  retry after five minutes can ring once more. That is accepted.
- **The line before the claim.** `MintSlot` is taken before the attempt is recorded, so a
  press that loses the race for the plan's last line is a refusal with nothing written but the
  audit row, as §2 says. Under concurrent presses, such a press now answers
  `CONCURRENCY_LIMIT` rather than `OUTBOUND_DAILY_CAP`.
- **Per-number hand-off.** The callback sends the caller ID's `transfer_number_N` and its fail
  message as dynamic variables, as an inbound call to that number carries
  (`numberTransferVariables`). Every number the call can transfer to is redacted out of the
  message, including the brief's defaults. The runtime cache and "Call my phone" now use the
  same reader.
- **Platform list.** `blocklists` values are matched through `normalisePhone`, as the inbound
  path matches them.
- **Verdicts on insert.** `guard_outbound_verdicts` also runs BEFORE INSERT
  (`20261028150000_outbound_verdicts_on_insert`).
