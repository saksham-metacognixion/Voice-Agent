# 0029 — D17: "Call my phone", the forwarding test and the website widget

Date: 27 Oct 2026. Status: accepted. Builds on ADR 0003 (D9 addendum: browser calls minted
by our API), ADR 0008 (S3 + CloudFront), ADR 0011 (§1 reservations, §2 fail-open),
ADR 0019 §8 ("Test forwarding" deferred to P2), ADR 0028. Spec: W5 element table (p. 24,
"Call my phone … hidden until first purchase; costs credits; Phase 2"), D4 Forwarding
(p. 37, "Test forwarding (Phase 2: we call their original number and verify it lands)"),
§11.2, §11.5 ("Embeddable 'Talk to us' button using Retell's web-call SDK. No telephony
cost. Separate channel in analytics"), §16 (`POST /agents/:id/test/phone {to}` (P2)).

## Context

D17 (`docs/plan/tasks.csv`) gives customers two more ways to hear their agent and a
website channel. Exit check: a widget call is recorded with `channel = web` and appears
in D2.

Before D17 every browser call was a test: `CallsService` wrote
`is_test = metadata.test === true || channel === 'web'`, the D1/D2 new-call toast
skipped every `web` frame, and D2 labelled every web call "Browser test". A website
visitor is a real caller on the `web` channel, so that rule had to change first.

## Decision

### 1. "Call my phone" — `POST /agents/:id/test/phone {to, version_no?}`

- **The browser test's checks, shared, not copied.** `TestCallService` now has `target()`
  (workspace not paused, agent, version with a script) and `ready()` (rate for the
  version's tier, balance after the other live calls' reservations, the plan's free line,
  the 10/h window, draft re-sync, the ADR 0011 §1 ceiling). The web and phone paths call
  both. The phone path shares the **same** hourly window.
- **On top:** a paid purchase (`402 PURCHASE_REQUIRED`), because §5.4 makes the trial
  browser-only and W5 hides the button until the first pack. A live number to call from
  (`409 NO_NUMBER`): the one bound to this agent, else the workspace's oldest.
- **The destination is the customer's own phone, not anyone's** (`checkTestDestination`,
  pure): real for its country (`libphonenumber-js/max`), in the from-number's or the
  workspace's country, not premium-rate/shared-cost/UAN/pager/voicemail, and not any
  number on the platform **nor a line forwarded to one** (`phone_numbers.e164` or
  `forwarding_from`, checked across workspaces on `adminDb`: either rings an agent, and an
  Option B customer's own business line loops the agent back to itself on both legs,
  billed until the ceiling). Each reason is its own 422 code on `to` —
  `DESTINATION_COUNTRY`, `DESTINATION_TYPE`, `DESTINATION_IS_AGENT`, and
  `VALIDATION_FAILED` only for a number that is not real — so the portal can tell the
  customer it is the target, not the typing. This is a test button. Outbound dialling with consent rules is D18.
- **The version is an override**, `override_agent_id` + `override_agent_version`, so the
  number stays bound to `latest_published` (§9.9). Metadata
  `{tenant_id, agent_id, version_no, tier, test: true, number_id}`: billed by `call_ended`
  at the version's rate like any test call, outbound in D2, and the after-call card fills
  as for a browser call. An unanswered call ends unconnected and bills zero.
- The audit row (`agent.test_phone_call`) carries the destination **country**, never the
  number. Every owner and admin reads the audit log.

### 2. The forwarding test — `POST /numbers/:id/forwarding/test`

The customer's existing line forwards to our number (Option B). We ring that line **from**
our number. If forwarding is on, the carrier sends the call straight back to our number,
where the §13.9 path sees it.

- **The marker is the lease and the cue.** `fwdtest:{e164}` = `{test_id, number_id,
  workspace_id, original}`, written `SET NX` with a 90 s TTL (`409
  FORWARDING_TEST_IN_PROGRESS` while held). The inbound path reads it **in the MGET it
  already makes** for `num:{e164}`, `pricing:current` and `kill:reject_inbound`. That is
  one more key and no extra round trip on the p95 < 300 ms path.
- **A match is turned away first.** The token must match, and the caller must be our own
  number (most carriers keep the original caller) or the customer's line (carriers that
  pass the forwarding number, §11.2). Such a call is answered with
  `RetellGateway.inboundDecline()` before every other check. It gets a busy tone, no call
  object, no cost and no `calls` row. It never becomes our agent talking to our agent, and
  the outbound leg ends `dial_busy`, billed zero (§14.2). The hot path only enqueues
  `forwarding-test-landed` (`calls` queue, 250 ms budget, like the write-behind).
- **Outcome on the row:** `phone_numbers.forwarding_test_json`
  `{test_id, status: calling|landed|not_landed|failed, started_at, finished_at,
  caller_id: ours|original}`. `landed` sets `forwarding_status = ready`, the state the
  customer's "I have switched it on" sets. The delayed `forwarding-test-expire` (75 s,
  long enough for "forward when I don't answer") moves a still-`calling` test to
  `not_landed`. A job for another `test_id` is a no-op, and so is an expiry after the
  test settled. **A landing overrules `not_landed`** for the same test: the marker
  outlives the ring window (90 s against 75 s) so a late forward is still turned away on
  the inbound path, and that turn-away is proof the forwarding works — first written as
  "a late landing cannot flip it back", which reported a working forward as broken
  whenever the carrier rang the customer's phone for 75–90 s. A `calling` row read 60 s past its window
  reads `not_landed` (`forwardingTestOf`), in case the expire job was lost.
- **Landing frees the marker at once**, compare-and-delete on the exact value
  (`releaseLock`). A real caller in the next seconds whose carrier shows the forwarding
  line is then not mistaken for the test. During the ring window that remains possible
  for **one** call. That trade is accepted and written down.
- The outbound leg has a 60 s ceiling (the platform's floor) and `metadata.test`. The one
  way the test costs credits is someone answering the customer's phone, and the D4 copy
  says so.
- Synchronous up to the ring, like D16's SIP re-verify. The portal re-reads the number
  every 3 s while it reads `calling` (the page's own cache entry, so the badge moves too).
  5 tests/h per number; editor and above, verified email.

### 3. The website widget (§11.5)

- **Settings on the agent:** `agents.widget_key` (`wk_` + 32 hex, unique, minted the first
  time it is turned on, kept when it is turned off, replaced on `rotate_key`),
  `widget_enabled`, `widget_origins` (≤ 10, normalised to origins; https, plus http for
  localhost only). `GET /agents/:id/widget` is open to any member. `PUT` is owner/admin,
  because it lets the public spend the workspace's credits. Audited as
  `agent.widget_updated`.
- **Public routes:** `GET /widget/:key` (business name, agent name, language — nothing
  else) and `POST /widget/:key/call {page_origin}`. Both are `@Public()` and run on
  `adminDb`, because the workspace is only known once the key resolves (the webhook case,
  ADR 0006). The key is public by design, so it authorises nothing. A call starts only
  when all of the following hold:
  - the widget is on;
  - the page's origin is on the list (if there is one) → else `403 ORIGIN_NOT_ALLOWED`;
  - the visitor (5 per 10 min per IP) and the widget (60/h) are under budget → else
    `429 RATE_LIMITED`. The budget counts attempts, not successes, because the caller is a
    stranger. The visitor's window is counted first and the widget's only for an attempt
    that passed it, so one address cannot spend the widget's hour for everyone;
  - the SA12 `reject_inbound` switch is off;
  - the workspace is not paused;
  - the agent is `live` and published;
  - the balance after the other live calls is positive and a line of the plan is free.
  Every refusal after "no such widget" is **one** code, `409 WIDGET_UNAVAILABLE`, with one
  sentence. Whether a business is out of credits is not a stranger's to learn. Business
  hours are a number's setting and do not apply.
- **The call:** the **published** version, explicit (`agent_version` = the published row's
  platform version), at the **live** tier and ceiling (`agents.tier`,
  `max_call_duration_s`), sized by the ADR 0011 §1 formula. Metadata
  `{tenant_id, agent_id, version_no, tier, test: false, widget: true}`. No `calls` row is
  written here: `call_started` creates it and `call_ended` bills it, exactly as for W5.
- **The slot is taken at the mint**, not left to `call_started`: right after minting,
  `WidgetService` writes the call's `active:{ws}` field with the inbound path's
  `RESERVE_SCRIPT`, which re-checks the plan's lines and the wallet atomically (ADR 0011
  §1). Strangers press a public button at once, none has reached `call_started`, and a
  read-only check let every one of them see every line free and the whole wallet. A press
  that loses the race gets `WIDGET_UNAVAILABLE` and no token; the minted call is never
  joined and ends unconnected, billed zero. `call_started` finds the field and leaves it
  (`HSETNX`); `call_ended` frees it. The browser test does not do this: it is the
  customer's own wallet, behind a login and 10/h.
- **`is_test` is now what we minted:** `isTestCall()` = `metadata.test` when it is a
  boolean, else `channel === 'web'`. W5 and "Call my phone" say `true`, the widget says
  `false`, and an inbound call carries no `test` and is not a browser call. The portal's
  toast and caller label follow the same rule (`webCaller()`: "Browser test" vs "Website
  visitor").
- **Delivery is an iframe, not a script that runs in the customer's page.**
  - `public/widget.js` (hand-written, no build, no dependency) adds one `position: fixed`
    iframe of `/embed/?key=` from the origin it was loaded from, with
    `allow="microphone; autoplay"`.
  - The frame reports the size it needs by `postMessage`. The loader accepts only
    `{type: 'oraly-widget:size'}` from that frame's window and origin, and clamps it to
    400 px.
  - `/embed/` is a static page of the portal. `Providers` gives it theme and language only:
    no Auth0, no workspace, no PostHog on a stranger's page. Its API client sends no token
    and no workspace. It speaks the agent's language, Arabic when the agent's is.
  - The browser call reuses W5's pattern (`RetellClient` with a `fetch` that answers
    create-web-call from our API) and its lifecycle guard, with no live transcript and no
    credits on screen.
  - Opened on its own (D3's "Preview") `/embed/` only shows the button: a call from there
    would be a real, billed website call counted as a visitor, and refused anyway once
    the widget lists its sites (no parent origin). The owner talks to the agent from the
    Test tab.
  - `page_origin` is `location.ancestorOrigins[0]` (unforgeable by the embedding page in
    Chrome and Safari), else the referrer's origin. A list with no readable origin refuses.
- **CloudFront:** `/embed/*` gets its own behaviour with `EmbedHeadersPolicy`: the managed
  SecurityHeaders set **without** `X-Frame-Options`, which would blank the frame on every
  customer site. Every other path keeps `SAMEORIGIN`. `deploy-frontend.sh` uploads
  `widget.js` with `max-age=300` instead of `no-store`, since every page view of every
  embedding site fetches it.

### 4. A separate channel in analytics

`GET /stats` answers `by_channel: {phone, web}` (calls, minutes, credits), real callers
only, defaulted so an older portal still parses. D1 "Today" shows Phone and Website once
the widget has had a caller. D2's channel filter reads "Website" (it already filtered on
`channel`), a widget call's caller reads "Website visitor", and the new-call toast fires
for it ("From your website").

## Alternatives considered

- **A script bundle that runs in the customer's page** (shadow DOM, the SDK bundled). Its
  one advantage is that the browser's own `Origin` header would enforce the allow-list.
  Rejected:
  - it needs a second build pipeline for a ~400 KB SDK bundle;
  - it needs CORS and the §6.2 origin check opened to every website;
  - the host page's CSS and scripts can reach it.
  The frame comes from the portal's origin, which both checks already allow.
- **`frame-ancestors` per widget.** CloudFront serves a static page; a per-key header
  needs a function per request. The allow-list check at mint time covers the same abuse.
- **Answering the forwarded test call with the agent and matching on `call_started`.**
  The outbound leg's agent and the inbound agent would talk to each other for a minute,
  billed twice. The decline costs nothing.
- **Recognising the test call in `decide()`.** It is not one of the six §13.9 checks and
  it writes no `calls` row; a separate early return keeps `decide()` what the spec lists.
- **"Call my phone" to any number in an allowed country.** That is an outbound dialler
  without D18's gates (DNC, calling windows, verified caller ID).
- **Distinct public error codes for no credits / busy / paused.** They would leak a
  business's state to anyone with the snippet.

## Consequences

- **Not verified against the live platform.** No real call was placed while building this:
  - `create-phone-call` with `override_agent_id` from a number that has no outbound agent;
  - a carrier forwarding a call that our own number placed back to that number;
  - a widget call from a real site.
  All three are covered by the fake gateway and e2e only. Each wants one manual run on
  staging before customers use it.
- `pause_web_tests` pauses "Call my phone" too. The widget follows `reject_inbound`, not
  `pause_web_tests`.
- The CloudFront change needs a stack update (`infra/aws/frontend-stack.yaml`) per
  environment before the widget works on a customer's site. Until then the frame is
  blocked by `X-Frame-Options`.
- A carrier that shows the forwarding line as the caller turns away at most one real
  caller per test, during the ring window.
- Exit checks: `test/d17-channels.e2e.test.ts` (12 cases: call-my-phone 4, forwarding 3,
  widget 5, the last being the D17 exit check). Unit: `call-my-phone.test.ts`,
  `forwarding-test.test.ts`, `frontend/web/src/dashboard/caller.test.ts`.
