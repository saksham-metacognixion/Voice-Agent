# 0028 — D16: transfer billing, per-number hours, knowledge use, SIP re-verify, Arabic over fr-CA

Date: 27 Oct 2026. Status: accepted. Builds on ADR 0010 (the ledger), ADR 0011 (call
runtime, `call-recovery`), ADR 0013 §6 (SIP envelopes), ADR 0019 §8 ("Re-verify" deferred
to P2), ADR 0024 (republish with `refresh`) and ADR 0026 (Arabic in the portal). Spec:
§5.1, §14.1, §11.3, §13.9; admin §5 ("Transferred-leg credits/min (P2) 0.25, after
`transfer_bridged`").

## Context

The first P2 batch (D16, `docs/plan/tasks.csv`): bill a transferred call as two legs,
per-number business hours with an override editor, knowledge-use statistics per call, a
SIP re-verify flow, and a full fr-CA catalogue. On 27 Oct, mid-task, the owner changed the
fifth item: the product is now sold to Arabic speakers, so **Arabic replaces fr-CA**.
Arabic already existed (ADR 0026); D16's obligation became Arabic parity for every new
string, not a third locale.

What the platform actually sends was read before building, not assumed:

- **Transfer events** arrive bare: `{event, event_timestamp, call: {call_id}}` (four
  `transfer_started` rows stored on 26 Oct). Nothing but the event's own time dates a
  bridge. The call object later carries `transfer_end_timestamp` and
  `transfer_destination`; `disconnection_reason` can be `transfer_bridged`.
- **Knowledge use**: `latency.knowledge_base.num` counts look-ups (one per agent
  response); `knowledge_base_retrieved_contents_url` is a signed CDN file, one entry per
  look-up — `{response_id, kb_ids, contexts: string[]}` — with each passage headed
  `{FileName: <8 hex>-name.ext}`, `{Title: name [<8 hex>]}` or `{Site Title: …}` (read from
  five real dev calls). The 8 hex are our `knowledge_sources.id`, because the sync names
  files and texts that way.
- **SIP**: `update-phone-number` takes `termination_uri`, `auth_username`,
  `auth_password`, `transport`; `get-phone-number` returns `sip_outbound_trunk_config`
  without the password. The platform never checks credentials at import.

## Decision

### 1. Transfer billing: a second ledger row, folded from the stored events

- **Ledger reason `transfer`**, `ref_type = call_transfer`, `ref_id = call_id`, under the
  partial unique index `credit_ledger_transfer_debit_once_idx` — the call debit's shape,
  so a replay collides instead of billing twice. Added in its own migration (Postgres
  will not use a new enum value in the transaction that added it).
- **The agent leg is untouched**: `call_ended` bills `start → end` at the tier rate, as
  before. The transferred leg is `bridge → end` at `rates.transferred_leg_per_min`, read
  from the **pricing version the call was rated under** (`calls.config_version`), captured
  once into `calls.transfer_rate`.
- **The leg is a fold over every stored `webhook_events` row for the call**
  (`foldTransfer`, pure): earliest `transfer_bridged`, latest platform
  `transfer_end_timestamp` else `transfer_ended`'s time, `transfer_cancelled` or an end
  without a bridge = `cancelled` (never billed). A lost `transfer_bridged` is dated from an
  agent leg that ended with `disconnection_reason = transfer_bridged`. Order-independent
  and idempotent by construction.
- **Settlement runs on every transfer event and after every lifecycle event**
  (`CallsService.settleTransfer`). A transfer event for a call with no row yet is settled
  as `transfer_deferred` — **not retried**: the sweeper would re-enqueue it forever for a
  call that is not ours. It is folded in when `call_started`/`call_ended`/
  `call_analyzed` (or `call-recovery`) creates the row.
- `calls.credits_charged` stays the agent leg; `transfer_credits_charged` is the second
  projection. D1 "credits used", D2's list, the CSV and the admin usage KPIs count both.
- The agent spec now subscribes to `transfer_bridged` and `transfer_cancelled`. A live
  agent picks that up at its next publish; `pnpm --filter @portal/api agents:republish
  --apply` republishes every live agent with `refresh` once per environment after deploy.

### 2. Per-number hours: date overrides, strict writes, one evaluator

- `businessHours.date_overrides` (optional, so every stored schedule still parses):
  `{date, intervals}`; no intervals = closed all day. Precedence on a date: closed date →
  override → weekday (`intervalsOn`). A closed date also shuts the early hours the previous
  evening would have run into — before D16 it did not.
- Writes (`PATCH /numbers/:id`, the phone plan, `PATCH /workspace`) use
  `businessHoursInput`: an IANA zone Intl knows (an unknown one fails open at §13.9, so it
  is refused at the door), ≤ 4 non-overlapping intervals a day, real and unique dates. The
  workspace timezone is validated the same way. Reads stay lenient.
- `isOpen`/`localClock`/`nextOpeningAt` moved to `@portal/schemas`; the API's
  `runtime-cache/hours.ts` re-exports them, so D4's "open now / closed now" preview is the
  decision a caller gets.
- Mode precedence is unchanged: `custom` reads the number's own schedule (and zone),
  `business` the workspace's, `always` none. **`business` with no workspace hours answers
  around the clock** (`no_schedule`, fail-open by design); the D4 warning claimed the
  opposite and was corrected.

### 3. Knowledge use: counted per call, attributed per source, never on the money path

- `calls.kb_retrievals` (look-ups), `kb_hits` (look-ups that found something; NULL =
  unknown), `kb_usage_json` (`{detail: complete|count_only, sources: [{source_id, kind,
  hits}]}`, per source once per look-up). NULL retrievals = the call never consulted it.
- Computed by the `call-knowledge` job (`calls` queue, `kb-<call_id>`, 5 s delay so
  `call_ended` and `call_analyzed` share one run) — the signed URL is re-read from the
  stored webhook, never put in a job payload. The count is written first; the file
  upgrades it to `complete`; nothing downgrades a complete row; values are SET, never
  incremented.
- The file is fetched by `RetellGateway.fetchKnowledgeRetrievals`: https only, a public
  address only, 5 s, 2 MB, no redirects.
- `GET /calls/:id` answers `knowledge` (names resolved at read time; a source deleted
  since keeps its hits, loses its id). `GET /agents/:id/knowledge/stats?days=7|30|90`
  aggregates real callers' calls (tests excluded), every current source listed at zero
  if unused, the rest `other_hits`.

### 4. SIP re-verify: one OPTIONS transaction, then the platform, synchronously

- `POST /numbers/:id/sip/verify` (owner/admin, verified email; body optional
  `{host, username, password}`). Synchronous on purpose: a candidate password lives on the
  request's stack only, never in a job payload in Redis.
- **Lease** `phone_numbers.sip_verify_started_at` (conditional UPDATE, 90 s, cleared only
  by its holder) → `409 SIP_VERIFY_IN_PROGRESS`; the number reads `pending` while held.
  Budget: 10 checks per workspace per hour (`ratelimit:sip-verify:{ws}`, counted after
  the lease) → `429 RATE_LIMITED`.
- **Trunk** (`SipProbe`): one SIP OPTIONS over TCP (TLS on 5061, Retell's default
  transport otherwise), digest-answered (MD5/SHA-256, qop auth) with the candidate
  credentials. The host is resolved and only a **public address** is dialled (no VPC, no
  metadata service, no loopback), ports < 1024 refused. Outcomes: `auth_accepted`, `open`
  → verified; `answered` (no challenge), `forbidden` (IP allow-list) → warning, the
  password unconfirmed; everything else (`auth_rejected`, `auth_required`, `unreachable`,
  `timeout`, `dns_failed`, `non_public`, `port_not_allowed`, `tls_failed`, `not_sip`) →
  failed, platform untouched.
- **Platform**, only when the trunk did not fail: `get-phone-number` (404 →
  `not_on_platform`), then `updateSipTrunk` with the candidate details — the platform
  never returns a password, so re-sending ours is the only way to know it holds the
  right one. Errors → `provider_error`.
- **Store**: `sip_verification_json` (status, reason, per-check words, `credentials_updated`
  — no secret); new credentials are sealed into `phone_plans.sip_json` only when the
  check did not fail, so a typo never replaces working ones; an audit row
  `number.sip_verified` with field-changed flags, never values. This is a third call site
  of `SipCredentialsCipher` (open and seal), after import and provisioning.
- No "remove the username": the platform's update cannot clear one.

### 5. Arabic, not fr-CA

No `fr-CA` locale is wired in; every D16 string ships in `en.json` and `ar.json` with full
Arabic plural forms. `messages.test.ts` gained a check every locale runs: no straight
apostrophe before `{`/`}`, which ICU reads as a quote and prints the placeholder literally.

## Alternatives considered

- **Retrying a transfer event until its call row exists.** Rejected: the sweeper
  re-enqueues unprocessed rows forever, and the four stored transfer events on dev belong
  to calls this environment never saw.
- **Billing the transfer leg from `call_ended`'s duration.** The agent leg's end is the
  bridge for a cold transfer; the transferred leg's end is a separate fact
  (`transfer_end_timestamp`). One number cannot be both legs.
- **Pricing the leg from the config current at the bridge.** Would let a publish between
  the call's start and its transfer re-price the call — the §14.2 rule `calls.rate` exists
  for.
- **SIP re-verify as a 202 job.** Needs the candidate password at rest (a job payload, or
  a pending envelope column) for the length of a queue wait. A ≤ 20 s request does not.
- **A TCP connect as the SIP check.** Proves a port is open, not that credentials work;
  only a digest challenge answers "is this password right".
- **A `call_knowledge_hits` table.** Per-source aggregation works over `kb_usage_json`
  with `jsonb_array_elements`, without another RLS-guarded table.

## Consequences

- A transferred call has two ledger rows and two credits columns; anything that sums
  call usage must count `reason IN ('call', 'transfer')`.
- Transfer billing for an agent published before D16 relies on the
  `disconnection_reason = transfer_bridged` fallback until it is republished
  (`agents:republish --apply`, once per environment, after the deploy).
- Knowledge attribution depends on the sync's naming (`sourceFilename`, `sourceTitle`);
  changing those names breaks it for new calls. A website source is attributed only when
  the agent has exactly one.
- A trunk that only trusts the platform's IP addresses reports `warning`, not `verified`;
  the copy says calls should still go through.
- Exit checks: `test/d16-transfer-knowledge.e2e.test.ts` (8), the D16 cases in
  `test/d6-numbers.e2e.test.ts` (8) and `test/d6-knowledge.e2e.test.ts` (1); unit:
  `transfer.test.ts`, `kb-usage.test.ts`, `sip-probe.test.ts` (a real loopback SIP trunk),
  `shared/schemas/src/business-hours.test.ts`, `frontend/web/src/dashboard/hours-view.test.ts`.
