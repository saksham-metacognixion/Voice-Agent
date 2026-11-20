# ADR 0011 — Call runtime: credit reservations, the queue hand-off, and the recording proxy

- Status: accepted
- Date: 2026-09-16
- Deciders: Saksham
- Scope: `backend/api/src/modules/{calls,events,jobs,runtime-cache,webhooks,scheduled}`,
  `shared/schemas/src/{calls,events,business-hours}.ts`. Implements spec §13.9, §13.10, §13.11,
  §14 and §16 (D4).
- Evidence: `backend/api/test/calls.e2e.test.ts` (22 cases), `test/calls-api.e2e.test.ts` (25),
  `test/load/inbound.k6.js` (189 639 authorisations at 6 319/s, p95 **8.4 ms**, p99 12.7 ms,
  zero non-2xx, every one of them on the allow path).

## Context

The spec fixes the call path's *rules* — six ordered checks in under 300 ms, Redis only,
`call_ended` as the only billing event, idempotency on `call_id`, both outcomes written by an
enqueued job — and ADR 0003 §12 fixes what to answer when Redis is missing. Six things were left
to the implementation, and each is decided here so D5+ does not re-decide them.

## Decisions

### 1. `active:{ws}` is a hash of reservations, not a counter

§15 calls it an "active call counter". A counter answers the concurrency check and nothing else,
and it cannot be made idempotent: an `INCR` from an authorisation, a second from `call_started`,
and a missing `DECR` from a lost `call_ended` all drift, and the drift is invisible until a
customer's calls start declining on `cap`.

It is a **hash**, one field per live call: `call_id → "<reserved credits>|<expires at ms>"`.

- Concurrency is `HLEN` of the live fields, so writing the same call twice reserves once. An
  authorisation writes with `HSET`, `call_started` with `HSETNX` (it must not shrink a
  reservation the authorisation already sized), `call_ended` releases with `HDEL`.
- Each field carries what that call may still spend, so check 4 can ask the question it actually
  means: *balance minus what the other live calls may still spend* must stay above −grace. A
  counter cannot answer that, and without it five simultaneous calls on a 6-credit balance are
  each authorised for six credits' worth of talking.
- Each field carries its own expiry, so a call whose `call_ended` never arrives frees its slot
  rather than holding it until the whole key's TTL. The key's TTL (max duration + 5 min, §15)
  stays as the outer bound.
- **The write is a Lua script, not a `HSET`** (`calls/reserve.script.ts`). `decide()` reads the
  cache and then answers; between the two, another call for the same workspace is doing exactly
  the same thing, and both would see the same free slot and the same credits. Redis runs a script
  to completion, so the cap and the balance ceiling are re-checked *as* the field is written —
  the same two predicates, so a lost race comes back as the decline it would have been a
  millisecond later, and the caller turns it into that decline reason. Twenty simultaneous calls
  against a cap of three let exactly three through (`calls.e2e.test.ts`).
- The only value that can still be generous under a race is `max_call_duration_ms`, which was
  sized against the balance read a moment earlier. It is bounded by the grace overdraft, which is
  what the grace is for (§5.4).
- A call that never went through the inbound path — a browser test, an outbound call, or an
  inbound call whose reservation was lost to a Redis blip — is sized by `call_started` the way
  `decide()` would size it: min(the agent's own `max_call_duration_s`, what is left of the wallet
  after the other live calls). Reserving Retell's two-hour ceiling instead is 120 credits at the
  standard rate — more than most wallets hold, so a single browser test would decline every
  inbound call on `balance` while the credits were still there. The field's expiry still spans the
  call's whole possible duration: the slot is about concurrency, the credits about money
  (amended 16 Sep 2026, D4 review).

### 2. An unidentifiable number is a fail-open, on the same policy as a Redis outage

ADR 0003 §12 covers Redis being down. Three more cases end the same way: a body with no
`to_number`, a `to_number` no `num:{e164}` knows, and a token that does not match the record. All
three mean *there is nothing to authorise against*, and none of them is the caller's fault.

They answer `200 {}` — the number's `latest_published` agent takes the call, bounded by its own
`max_call_duration_ms` — and enqueue a `refresh-number` job so the cache repairs itself.
A call let through this way carries **no metadata**. The answer is literally `{}`, so Retell uses
the bound agent and `call_ended` arrives with no `tenant_id` — and "let `call_ended` bill as usual"
(ADR 0003 §12) needs a second way to say whose call it is, or the call is free and invisible. The
lifecycle handler therefore falls back, in order, to the Retell agent that took the call and then to
the number it was dialled on (`to_number` inbound, `from_number` outbound; `phone_numbers.e164` is
unique, so a hit is ours). Both are Postgres reads in a job, never on the 300 ms path
(amended 16 Sep 2026, D4 review).

`INBOUND_REDIS_DOWN_POLICY=closed` flips these to `reject` along with the Redis-down case, because
an operator who wants busy tones during an incident wants them for every unauthorised call.

A signature that does not verify is the same answer for a different reason: a 401 would cost the
caller three Retell retries and about two seconds of ringing, and Retell would then answer with the
bound agent anyway (ADR 0003 §1). So the inbound route logs loudly, answers `200 {}` and writes
nothing — a forged request achieves nothing, and a real one with a mis-badged key still gets the
call answered. `POST /webhooks/retell` (the lifecycle route) is the opposite: it *does* answer 401,
because nothing is ringing and a stored-but-unverified event would poison metering.

### 3. Stripe moves behind the queue, and the 500-on-failure exception disappears

ADR 0010 §5 left Stripe processing inline with a deliberate 500 on failure, "until the D4 queue
lands". It has landed. Both providers now follow one rule: verify → store in `webhook_events` →
duplicate is 204 → enqueue → 200. Retries, backoff and the dead-letter set are BullMQ's, with eight
attempts over roughly ten minutes.

`WebhookEventsService.store()` keeps returning `retry` for a stored-but-unprocessed row, and the
`webhook-sweeper` job (every 60 s) re-enqueues anything stored more than a minute ago that was never
processed — which closes the one gap the queue introduces: the row commits, then the `add()` fails
because Redis is the thing that is down.

Deterministic job ids (`wh-<event id>`) are what make the re-enqueue safe, and they are also the one
thing that can defeat it: BullMQ keeps a failed job for a week (SA12 "Jobs"), and it keeps its id
with it, so an `add()` for a job that has already exhausted its eight attempts is a silent no-op —
the sweeper would report a re-enqueue every minute and nothing would run. A job found finished,
failed and out of attempts is removed and added again; a job still being retried, or one that
completed, is left alone (amended 16 Sep 2026, D4 review).

Consequence for tests: anything asserting on a webhook's effects has to wait for the job. The D3
billing suite now waits on `webhook_events.processed_at`.

### 4. The rate is captured on the row, and a row is created by whichever event arrives first

`calls.rate` and `calls.config_version` are written once — by the inbound write-behind, or by
`call_started`, or by `call_ended` if it is the first thing we see — and never overwritten. Every
later event bills against the row. A pricing publish mid-call therefore cannot re-price that call,
which is what §14.2 asks for and what `calls.config_version` exists to prove a year later.

Out-of-order delivery follows from that: `call_ended` before `call_started` creates a finalised
row, and the late `call_started` will not reopen it. `call_analyzed` before either creates an
**unbilled** row and leaves it that way — only `call_ended` bills, and a call with no `call_ended`
is the reconcile job's problem (§13.11), not the analysis handler's.

### 5. Recordings are proxied through a signed link, never redirected to Retell

`GET /calls/:id/recording` mints a one-hour HMAC token bound to (workspace, call, expiry) and
returns a URL on our own API. `GET /calls/:id/recording/stream?token=…` is `@Public()` — an
`<audio src>` cannot send `Authorization`, so the token is the credential — verifies it, and pipes
the bytes from Retell with `Range` passed through.

A redirect would hand the browser Retell's own signed URL: a bearer credential for customer call
audio, with a lifetime and an audience we do not control. The stored Retell URL expires, so a stale
one is refreshed through `get-call` at stream time, outside any transaction.

"Pipes" is literal: the bytes are relayed as a stream, counted as they pass and cut off past
200 MB. Buffering the response to check `content-length` first would hold a whole recording in the
API heap — one process serves every workspace — and would not even be a guard, because a chunked
upstream declares no length at all (amended 16 Sep 2026, D4 review).

Until §20 item 9 is decided, the link is owner/admin/editor; a viewer still sees the call, the
transcript and the analysis. `RECORDING_SIGNING_SECRET` must be set wherever the API runs as more
than one process, or a link minted by one is refused by its sibling.

**Addendum, 24 Sep 2026 — the link's origin.** The minted link used `API_PUBLIC_URL` when
set, on the premise that it is "what Retell and the browser both reach". In dev it is not:
`API_PUBLIC_URL` is the ngrok tunnel Retell calls back on, and ngrok's free tier answers a
browser user agent with an HTML interstitial (`ERR_NGROK_6024`), so `<audio>` received a web
page and reported "The recording could not be played" on every D2 call. The link is now built
from the request's own forwarded proto and host (Caddy sets them; `trustProxy` is on), which
is by construction an origin the calling browser can follow; `API_PUBLIC_URL` is not consulted.
The same pass fixed a second latent problem: the platform's CDN labels its `.wav`
`application/octet-stream`, which Firefox refuses for media, so the proxy now derives
`audio/wav` (or the type the extension implies) when the upstream header says nothing
useful, and names the download to match. Both are pinned in `calls-api.e2e.test.ts`.

### 6. SSE is one Redis channel per workspace, with the topic filter in the client's query

`events:{ws}` carries every frame for a workspace; a process subscribes while it holds at least one
SSE client for it and unsubscribes with the last one. The stream a client gets is its own
workspace's channel and nothing else, so another workspace's events are unreachable by
construction rather than by filtering. `?topics=` narrows what a client is sent.

A lost frame is a display problem, never a billing one: `publish()` is bounded at 500 ms, never
throws, and a client that missed something repairs it by re-reading `GET /calls/:id` or
`GET /wallet`. Frames are therefore small, and the server never replays.

**Addendum, 24 Sep 2026 — streams end on shutdown.** `app.close()` (SIGTERM through
`enableShutdownHooks`) waits for Fastify, and Fastify forces only *idle* keep-alive
connections closed; a hijacked SSE response is never idle. One dashboard tab left open was
enough to keep the old API process alive indefinitely, so a `nest --watch` restart never
happened in dev and the same would hold for a compose stop in staging. `EventsController`
now tracks every open stream and ends them all in `beforeApplicationShutdown()`, which runs
before the HTTP server is closed; the ended sockets are then idle and Fastify drops them.
`@microsoft/fetch-event-source` reconnects after the `retry: 3000` the stream opened with.
The relay already did the same for its WebSockets (`OnModuleDestroy`).
`test/shutdown.e2e.test.ts` opens a stream and races `app.close()` against a timer.

### 7. A lost lifecycle webhook is recovered from `get-call` (addendum, 24 Sep 2026)

**Observed.** A 43-second web test call on 24 Sep 2026 (`call_3860566ea7a8e1f9ef6ad67d24d`)
delivered `call_started` and nothing else. The tunnel was up, the agent's `webhook_url` and
`webhook_events` were right, the calls either side of it got all three events within a second,
and `get-call` showed it `ended` and analysed. The platform simply never sent `call_ended` or
`call_analyzed`. Nothing on our side noticed: the row stayed `in_progress` for ever, the call was
never billed, the W5 card said "Calculating…", the `active:{ws}` field only lapsed on its own
expiry, and SA12 replay had nothing to replay because nothing was stored. `reconcile-calls` would
report the call the next night, but it reports and does not repair.

**Decision.** A 14th §13.11 schedule, `call-recovery`, every 5 minutes, under the usual
`lock:schedule:{name}`:

- It picks rows still `registered`/`in_progress` created 3 minutes to 24 hours ago, and rows
  `ended` 10 minutes to 6 hours ago with no `analysis_json`, newest first, 100 of each per tick.
  Two partial indexes (`calls_unsettled_created_at_idx`, `calls_unanalysed_ended_at_idx`) keep
  that off a scan of `calls`.
- It skips any call whose missing event is already in `webhook_events`: a stored but
  unprocessed event is the `webhook-sweeper`'s and BullMQ's.
- It asks `RetellGateway.retrieveCallFacts()` (`get-call`, parsed with the same `retellCallFacts`
  schema the webhooks use, a 404 as `null`). Once the call is `ended`/`error`/`not_connected`
  and ended at least 2 minutes ago, it **stores the answer as the missing webhook** (same
  `(provider, external_id, event_type)` key, the payload marked `recovered_by: call-recovery`)
  and enqueues it. `call_analyzed` is stored the same way when the answer carries
  `call_analysis`.

**It moves no money itself.** The ordinary `call_ended` handler bills, so every §14.2 rule holds
unchanged: `call_ended` is the only event that moves credits, the debit is idempotent on
`call_id`, and the rate is the one captured on the row. A real delivery that turns up after the
recovery is a duplicate of a processed event (204), not a second charge.

**Not covered.** A call with no row at all — its `call_started` was lost too — is invisible to
this query. `reconcile-calls` still lists it as `missing`; settling that from the nightly
`list-calls` is a later step if it ever happens in practice.

**Portal.** The W5 after-call card waits 10 minutes rather than 2 (a 5-minute tick, 3 minutes
after the row is written), polls every 15 s after the first 2 minutes, and says the result is
late rather than telling the caller to try a longer call.

**On demand, for the call someone is watching (later on 24 Sep 2026).** The schedule alone
still left a W5 card on "Calculating…" for up to eight minutes: the 3-minute age floor plus
a 5-minute tick. The platform delivers `call_ended` in the same second as `call_analyzed`,
seconds after hang-up, so a watched call with nothing stored 20 s after it ended has lost its
webhook. `GET /calls/:id` therefore queues `recover-call` (`webhooks` queue,
`jobId = recover-<call_id>`, 20 s delay, freed when it settles) whenever it serves a row that is
`registered`/`in_progress`, or `ended` without analysis, and less than a day old. The fixed id
while it waits is the throttle: a card polling every 3 s costs one `get-call` per 20 s. The job
runs `CallRecoveryService.recoverOne()`, the same per-call step as the schedule with a 15 s
ended-ago grace instead of 2 minutes, so it stores the missing event and bills nothing itself.
A real delivery that races it is a duplicate under the same key.

**Review, later on 24 Sep 2026: an ask is remembered, and a call the platform has no
record of is settled.** Two rows the platform can never answer for were re-asked every tick
for the whole window: a `registered` row whose caller hung up before the platform created
the call (`get-call` 404 for 24 hours — and the row rang in D2 the whole time), and an
`ended` short call the platform never analysed (72 `get-call`s over 6 hours). Newest-first
with a batch of 100 let such rows starve a call whose webhook was actually lost. Now:

- Every ask is written to the row — `calls.recovery_checked_at`, `calls.recovery_checks`
  (migration `20260924150000_call_recovery_checks`). A provider error is not an ask. The
  schedule skips a row asked within `RECOVER_RECHECK_MS` (15 min) and orders by
  `recovery_checked_at ASC NULLS FIRST`, newest first within that: rows never asked come
  first, and a genuinely long call is re-asked four times an hour, not twelve.
- An `ended` row with no analysis is asked `RECOVER_ANALYSIS_MAX_CHECKS` (3) times and
  then left alone. `recoverOne()` counts towards the same cap, so it waits a minute after
  the call ended, and a minute after its own last ask, before spending one — the platform's
  analysis lands within a minute of the call, and asked every 20 s from the card's first poll
  the three would be gone before it could have arrived.
- A 404 on an unfinished row **stores the `call_ended` the platform never sent**, marked
  `recovery_reason: not_found`: `call_status: not_connected` for a `registered` row (no
  `call_started` ever came), `error` for an `in_progress` one once the platform has said so
  twice (`RECOVER_NOT_FOUND_CHECKS_IN_PROGRESS`). Neither carries timestamps, so the
  ordinary handler bills zero, frees the `active:{ws}` slot and ends the row. The money
  rules are untouched: still the one handler, still idempotent on `call_id`.
- `recoverOne()` returns before `get-call` when everything the row is missing is already
  stored and only waiting for the queue.
- The predicate and the windows live in one place, `modules/calls/call-recovery.rules.ts`
  (`unsettledCallKind`, `RECOVER_WINDOW_MS`…), used by both `GET /calls/:id` and the
  service, so the route cannot queue what the worker would discard.

**Also fixed here: `calls.agent_version` is our version number.** The lifecycle handlers had
copied the platform's `agent_version` into it, so a draft test call read `0` and the platform's
counter reached the wire, against the rule that `retell_agent_version` stays server-side. It is now
`metadata.version_no` when the call carries it (every W5 test call), else the platform version
translated through the published `agent_versions` row that recorded it, else `null`.

## Alternatives considered

- **A counter for `active:{ws}`** — rejected, see 1. It cannot express "what the live calls may
  still spend", and its drift is silent.
- **Reserving credits in the ledger at authorisation** — a real hold, reversed at `call_ended`.
  Rejected: it puts Postgres on the 300 ms path, doubles the ledger's row count, and makes every
  balance answer a question about pending holds. The reservation is a cache entry precisely because
  it is a forecast, not a movement; the ledger stays a record of what happened.
- **Verifying the inbound signature and 401-ing on failure** — rejected, see 2.
- **Redirecting to Retell's recording URL** — rejected, see 5.
- **One queue for everything** — rejected: a slow webhook backlog would stall the write-behind that
  keeps Postgres off the hot path. Three queues (`webhooks`, `calls`, `scheduled`), with the
  scheduled one at concurrency 1 because its jobs sweep tables.

## Consequences

- `num:{e164}` is now a documented record shape (`NUMBER_RECORD_VERSION`), and an older version
  reads as a miss rather than as bad data. `runtime-cache.refresh(workspaceId)` rebuilds it, and
  every mutating path must call it; the 5-minute schedule is the backstop, and the worker warms
  everything on boot.
- **Record version 2 carries the rate.** The first version read the rate from `pricing:current`,
  which was wrong for a reason that only showed up in a running system: that key carries the 60 s
  config TTL (admin §5.2 promises the portal re-reads within 60 s) while `runtime-cache-refresh`
  runs every five minutes, so it was absent for roughly four minutes of every five. A decision
  without a rate skips the `remainingCredits/rate` half of the duration formula *and* reserves
  zero credits, so concurrent calls stopped subtracting each other's spend — measured on a
  5-slot plan with 20 credits and a 10-credit grace, five calls could bill 50 credits and leave
  the balance at −30, three times the overdraft the grace is supposed to bound. `rate_per_min`
  and `config_version` now sit beside `plan_max_ms`, so both halves of the formula are written by
  one refresh and expire together. Raising `CONFIG_TTL_S` was rejected: `flags:global` and
  `flags:{ws}` share it, and slowing a kill switch to five minutes is a worse trade. The rate here
  is only ever a ceiling — `calls.rate` is still captured by the worker from the live config, so a
  stale record cannot misprice a call. `rate_unknown` also joins `balance_unknown` and
  `caps_unknown` as a trigger for the write-behind `warm-workspace` job.
- **The SA12 `reject_inbound` veto has its own key, `kill:reject_inbound`.** It was read from
  `flags:global` and so had the identical defect the rate had, one layer along: that key carries
  the 60 s `CONFIG_TTL_S` and is only repopulated by `refreshAll()` on the five-minute schedule,
  so it was absent for roughly four minutes in five — and a miss on this path reads as "switch
  off", which is the correct failure mode and therefore a completely silent one. An operator
  declaring an incident would have watched calls keep connecting. The switch is now projected to
  its own key on every flip (`PlatformConfigService.setKillSwitch`) and republished by
  `runtime-cache-refresh`, with `REJECT_INBOUND_TTL_S` an order of magnitude longer than that
  cadence. Deliberately outside the `flags:` namespace, which `delPattern` wipes wholesale on
  every publish. The note above about not slowing kill switches to five minutes stands: this
  makes the switch faster, not slower — it now takes effect on the next call rather than never.
- **`decide()` excludes the call's own reservation.** Retell re-sends `call_inbound` with an
  identical `call_id` up to three times (the `decline_timeout` fixtures), and the timeout retry is
  precisely the case where attempt 1 already reserved. `reserve.script.ts` had always excluded
  `field ~= callId`; `decide()` had not, so a retry could be declined on `cap` for the slot being
  held for it, or sized from credits it was itself holding. The two predicates must agree, or the
  decision refuses what the script would have written.
- The §13.9 path reads exactly four keys in two round trips (`num:{e164}`, `pricing:current` —
  now only a fallback for a record written before version 2,
  `kill:reject_inbound`, then `caps:{ws}` + `bal:{ws}` + `active:{ws}`) and writes its reservation
  with a third, atomic call — all under one 150 ms budget.
  Measured p95 is 8.4 ms at 6 319 requests/second, more than an order of magnitude inside the SLO.
- `computeCharge()` gained one fallback: a payload missing a timestamp but carrying `duration_ms`
  bills the seconds Retell measured rather than giving the minutes away.
- Fixture capture on the inbound route is opt-in (`CAPTURE_INBOUND_FIXTURES`). A load run with it
  on writes one file per request — 52 000 in a 30-second run, which is how the rule was learned.
- **A deterministic job id is only as good as the read-back.** BullMQ's `Queue.add()` builds the
  Job it returns locally and overwrites only its id from Redis, so a refused duplicate is
  indistinguishable from a fresh add. `JobQueues.add(..., verify)` reads the stored job back and
  compares its timestamp; `enqueueWebhook` is the caller that pays for it, because a `wh-<id>` job
  that burned its eight attempts holds its id in the failed set for a week — `webhook-sweeper`
  would have re-enqueued it every 60 s, BullMQ would have refused every time, the sweeper would
  have counted a success, and that `call_ended` would never have billed.
- **Cache repairs free their ids the moment they settle** (`REPAIR_JOB_OPTIONS`). `warm-<ws>` and
  `refresh-number-<e164>` dedupe on a deterministic id so a burst of hot-path misses enqueues one
  job; under the default `removeOnComplete: {age: 3600}` that dedup outlived the repair by an
  hour, swallowing later misses on the same workspace. They are idempotent and re-driven every
  five minutes, so nothing is kept by holding the id.
- Three §13.11 jobs are live (`runtime-cache-refresh`, `webhook-sweeper`, `credit-expiry`); the
  other nine are registered skeletons so the schedule exists and the day that owns each fills it in.
