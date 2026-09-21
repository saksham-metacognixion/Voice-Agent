# ADR 0003 — Retell findings from the P0 spike (§21)

- Status: accepted
- Date: 2026-09-15
- Deciders: Saksham
- Evidence: `backend/api/test/fixtures/retell/` (23 webhook payloads, redacted) and
  `backend/api/test/fixtures/retell/api/` (API responses), all captured today against the real
  account with `pnpm --filter @portal/api spike:retell`. Nothing below is from memory or from a
  docs page alone; where a docs statement was not exercised it is marked *docs only*.

## Context

Spec §21 lists what must be verified against Retell before code depends on it, and
`docs/architecture.md` §9 defers the Redis-down policy to this document. The spike built the
`RetellGateway` (`backend/api/src/modules/retell/`), created an LLM, agents, a knowledge base
and phone numbers, ran seven phone calls (a second, temporary number with a "never hangs up"
caller agent dialled the spike number so inbound behaviour could be exercised without a person)
and one browser call from headless Chrome with a fake microphone, and read every payload back.

Total spend: two numbers ($2/month each; the caller number is already deleted) and about
$1.20 of call minutes.

## Decisions and findings, one per §21 item

### 1. Inbound webhook: decline vs override, and whether a declined call costs anything

**Decline = HTTP 200 with `{"call_inbound":{"reject":true}}`. Nothing else declines.**

| Our answer | What Retell did | Caller heard | Call object | Cost |
| --- | --- | --- | --- | --- |
| 200 `{}` | answered with the number's bound agent | agent | yes | normal |
| 200 `{call_inbound:{override_agent_id, dynamic_variables, metadata, agent_override}}` | answered with our agent, variables and metadata applied | agent | yes | normal |
| 200 `{call_inbound:{reject:true}}` | hung up before any agent | **busy** (`dial_busy` on the caller leg) | **none** — `GET /v2/get-call` on the `call_id` from the webhook is 404 | **0** |
| 403, empty | retried 3× ~0.8 s apart, then **answered with the bound agent** | agent, ~2 s late | yes | normal |
| 500, empty | same as 403 | agent, ~2 s late | yes | normal |
| no answer within 10 s | retried at 10 s intervals (3 attempts, 20 s), then **the caller leg timed out** (`dial_no_answer`) | ~30 s of ringing, no answer | yes, 0 ms, `user_hangup` | 0 |

Consequences for §13.9:

- The six checks decide between `RetellGateway.inboundAllow()` and `inboundDecline()`. A
  4xx/5xx is *not* a decline; it is a slow allow with the number's defaults.
- All three retries carry the **same `call_id` and `event_timestamp`**, so the `calls` row and
  the `webhook_events` unique key dedupe them.
- The declined caller hears a busy tone, not a message. §21's "fallback agent" alternative
  (override to an agent that says "we are closed") is possible — it is the allow shape with a
  different `override_agent_id` — and costs a normal call. **Decision:** busy for `balance`,
  `cap`, `blocked` and `paused`; the `hours` decline may later become a P2 "closed" agent
  because it is the only one where the caller did nothing wrong (open item, not blocking).
- Retell's webhook egress IP is `100.20.5.228` (seen in `x-forwarded-for`); not relied on.

### 2. `agent_override.agent.max_call_duration_ms` from the inbound webhook

**Honoured.** Test 2 answered with `max_call_duration_ms: 60000` (the minimum Retell accepts);
the inbound leg ended at 60 004 ms with `disconnection_reason: max_duration_reached`
(`call_ended-inbound-max_duration_reached.json`) while the caller leg, capped at 150 s, saw
`user_hangup`. The same override on `create-web-call` and `create-phone-call` also works
(`call_ended-web-max_duration_reached.json`, `call_ended-outbound-max_duration_reached.json`).

Retell's window is **[60 000, 7 200 000] ms**; `clampDuration()` in the gateway enforces it.
Below 1 credit remaining the call is therefore still allowed for one minute — inside the
10-credit grace (§5.4), so acceptable. `dynamic_variables` and `metadata` from the answer
arrive in `call_started` and every later event (`call_started-inbound.json`), which is how
§14.2 tenant isolation resolves `metadata.tenant_id`.

### 3. `call_cost` shape and units

Present in `call_ended` and `call_analyzed` (identical), and in `GET /v2/get-call`. Empty
(`product_costs: []`, `combined_cost: 0`) in `call_started`.

```json
{
  "product_costs": [
    { "product": "retell_voice_engine",       "unit_price": 0.0916667, "cost": 6.9666692 },
    { "product": "elevenlabs_tts_03_2026",    "unit_price": 0.0666667, "cost": 5.0666692 },
    { "product": "gpt_5_mini",                "unit_price": 0.0133333, "cost": 1.0133308 },
    { "product": "us_twilio_telephony",       "unit_price": 0.025,     "cost": 1.9 },
    { "product": "gpt_5_6_terra_text_testing","unit_price": 2.08,      "cost": 2.08 }
  ],
  "total_duration_seconds": 76,
  "total_duration_unit_price": 0.1966667,
  "combined_cost": 17.0266692
}
```

- **Units: US cents, floating point.** `unit_price` is cents per second; `cost` and
  `combined_cost` are cents. `retell_cost_cents` (§15) stores `combined_cost` rounded to 0.01.
- `total_duration_seconds` is **rounded up** (75 549 ms → 76). Our metering uses
  `end_timestamp − start_timestamp` (§14.2), not this field.
- Per minute at the spike stack (gpt-5-mini + ElevenLabs flash v2.5 + Twilio US): voice engine
  $0.055, TTS $0.040, LLM $0.008, telephony $0.015 = **$0.118/min**, against §4.1's estimate.
  A browser call has no telephony line: $0.103/min.
- **Post-call analysis is a flat per-call charge, not per minute:** `gpt_5_6_terra_text_testing`
  cost 2.08 ¢ on every call, including a 60 s browser call (17 % of that call's cost). It is
  the default `post_call_analysis_model`. **Decision:** `post_call_analysis_model` is part of
  the tier stack in `agent_stack_configs` and defaults to a cheaper model; the gateway passes it
  through. Not hard-coded (CLAUDE.md, Configuration).
- `call_ended` also fires for calls that never connected (`call_status: not_connected`,
  `disconnection_reason: dial_busy | dial_no_answer`, `duration_ms: 0`, cost 0) — the
  §14.2 zero-charge rule has real fixtures now (`call_ended-outbound-not_connected-*.json`).

### 4. Toll-free and non-US telephony rates *(docs only, pricing page 15 Sep 2026)*

Retell lists **$0.015/min for US, US toll-free, Canada, and every international country it
offers** (India, Australia, Germany, Spain, UK, Mexico, France, Japan, Italy, Indonesia,
Philippines, Malaysia, Thailand). Numbers are **$2.00/month**; "verified" numbers $10/month.
SIP trunking is $0. `create-phone-number` accepts `country_code: 'US' | 'CA'` only and
`toll_free: boolean` ("toll-free numbers incur higher costs" — the number, not the minute).

**Decision:** one telephony rate in `retell_cost_inputs`, no per-country selector on the pricing
page for launch (§20 item 4 stays open; India would need a number imported via SIP, not bought).
Toll-free was not purchased; its monthly price is confirmed on the invoice when first needed.

### 5. Retell workspaces / sub-accounts

Workspaces exist and are a full isolation boundary (own API keys, own balance and invoices,
own concurrency and KB quota) but **are dashboard-only: no API to create, delete or switch
them.** One-per-tenant would mean a human in the sign-up flow and a payment method per tenant.

**Decision: one Retell workspace per environment (dev, staging, prod), never per tenant.**
Tenant isolation is ours (Postgres RLS, `metadata.tenant_id`, `num:{e164}`), which is how the
architecture already reads. Consequences: the 20-call concurrency pool and the "first 10
knowledge bases free, then $8/KB/month" allowance are shared across all tenants of an
environment (§14.3 caps must sum below the pool; see 8 and 10).

### 6. `language: multi`, truly multilingual voices, locale list

- `language` accepts a single locale, **an array of locales** (`['en-US','fr-CA']` was accepted
  and stored verbatim, `create-agent.json`), or the deprecated scalar `'multi'` (stored as ten
  fixed locales). **Decision:** always send the array; W3's "Main language + additional
  languages" maps to it directly, main language first (Retell falls back to the first entry
  when detection fails).
  _Reviewed again 21 Sep 2026, against a request to follow §W3's literal text ("if ≥ 1
  also-speaks → `language: multi`") while the spec owner was unavailable. Kept the array,
  for three reasons that are measurements rather than taste: (1) `multi` is a fixed ten
  locales — en-US, es-ES, fr-FR, de-DE, hi-IN, ru-RU, pt-PT, ja-JP, it-IT, nl-NL — and
  **fr-CA is not among them**, so a Quebec customer choosing fr-CA + en-US would get an
  agent that cannot speak its primary language (`test/fixtures/retell/api/d5-create-agent.json`
  shows what Retell stores for the array: `["fr-CA","en-US"]`); (2) Retell marks `multi`
  deprecated; (3) the array is what §W3's own copy promises the customer ("also speaks").
  This ADR is the override CLAUDE.md's "spec wins unless a decision overrides it" refers
  to. The literal reading is a one-line change in `AgentRetellService.agentSpec` guarded
  by `agent-retell.test.ts` ("what W3 promises actually reaches Retell"); if the spec owner
  wants it, flip the branch, the tests and this note together._
- Exact locale list for the W3 select (63): `en-US en-IN en-GB en-AU en-NZ de-DE es-ES es-419
  hi-IN fr-FR fr-CA ja-JP pt-PT pt-BR zh-CN ru-RU it-IT ko-KR nl-NL nl-BE pl-PL tr-TR vi-VN
  ro-RO bg-BG ca-ES th-TH da-DK fi-FI el-GR hu-HU id-ID no-NO sk-SK sv-SE lt-LT lv-LV cs-CZ
  ms-MY af-ZA ar-SA az-AZ bs-BA cy-GB fa-IR fil-PH gl-ES he-IL hr-HR hy-AM is-IS kk-KZ kn-IN
  mk-MK mr-IN ne-NP sl-SI sr-RS sw-KE ta-IN ur-IN yue-CN uk-UA` (SDK 6.0.1 enum; launch
  offers en-US, en-GB, en-AU, en-IN, fr-CA, fr-FR, es-419, es-ES and hides the rest).
- Multilingual-ness is a property of the **voice model, not the voice**: `list-voices`
  returns no language field. Per Retell's provider table *(docs only)*: ElevenLabs
  `eleven_flash_v2_5` (32 languages incl. fr, es, hi, pt), `eleven_v3` (all), `eleven_flash_v2`
  (**English only**); Cartesia `sonic-3*`, OpenAI, MiniMax, Inworld cover their full set on
  every model. **Decision:** the tier stack pins `voice_model = eleven_flash_v2_5` for ElevenLabs
  voices and W3 filters the catalogue by provider ∈ {elevenlabs, cartesia, openai, minimax,
  inworld} when more than one language is selected. Catalogue today: 301 voices (cartesia 88,
  elevenlabs 65, minimax 39, openai 34, inworld 29, fish_audio 25, platform 21); all have
  `preview_audio_url`.

### 7. Agent version tags (`latest_published`) and the publish API

Verified behaviour of the version model:

| Step | Result |
| --- | --- |
| `create-agent` | version 0, `is_published: false` |
| `POST /publish-agent-version/{id} {version:0}` | v0 `is_published: true`; **200 with an empty body** (SDK 6.0.1 `agent.publish()` throws on it — gateway uses the raw response) |
| `update-agent` while latest is published | **422 "Cannot update published agent other than version title"** |
| `create-agent-version {base_version:0}` | v1 draft, `base_version: 0` |
| `update-agent` | edits v1; v0 unchanged (`get-agent?version=0`) |
| `list-agent-versions` | `{items:[…], has_more}` newest first, with `custom_analysis_fields` and `assigned_tags` per version |

**The finding that changes code:** a number bound with `inbound_agents:[{agent_id, weight:1}]`
and no `agent_version` runs **`latest`, drafts included** — test 1's inbound call ran the
unpublished v1 (`call_inbound.agent_version: 1`). After `update-phone-number` with
`agent_version: 'latest_published'` the same call runs v0 (`call_inbound-decline_403-attempt1.json`,
`call_started` on that call: `agent_version: 0`). `create-web-call` takes `agent_version` as a
number or tag the same way.

**Decisions:**

- Numbers are always bound with `agent_version: 'latest_published'`. The gateway does this;
  nothing else may bind a number. Publishing therefore needs no `update-phone-number`.
- The §9.9 flow is: `create-agent-version(base = published)` → `update-agent` (draft) →
  `update-retell-llm` → `publish-agent-version`. The Retell LLM is versioned with the agent
  (`response_engine.version`), so the draft agent snapshots the LLM it was edited against.

  **Amended 17 Sep 2026 — the order is enforced, not advisory.** While the latest agent
  version is published, the LLM version it points at is published too, and
  `update-retell-llm` answers **400 `Cannot update published LLM`**. `create-agent-version`
  is what bumps `response_engine.version` (v0 → v1 on the same `llm_id`) and hands back an
  editable LLM. Measured on a live agent: branch → `update-retell-llm` OK → `update-agent`
  OK → publish OK, and the published v0 still reports `response_engine.version: 0`.
  `AgentRetellService.syncDraft` had `update-retell-llm` first, which meant **every
  republish of an already-published agent failed**; `FakeRetellGateway` models the agent's
  immutability but not the LLM's, so no test caught it. Reproduce with
  `pnpm --filter @portal/api verify:d5-retell`.
- Roll back = publish an older version number again is **not** how Retell works (versions
  are immutable and publish targets a draft). Roll back = `create-agent-version(base = old)`
  → publish. Same outcome, one extra call; `agents.published_version` records our version_no.
- Custom tags (`prod`, `staging`, up to 10 per agent, each with its own dynamic-variable set)
  are a dashboard feature; no tag-management endpoint is in SDK 6.0.1. Not used.
- Keep `webhook_url` per agent (set on create) — it survives new versions (`create-agent-version.json`).

### 8. Knowledge base ingestion limits and refresh

Exercised: create with one text + one URL → `status: in_progress` → `complete` in **12 s**;
`add-sources` → `status: refreshing_in_progress` (the KB stays usable). Sources come back
with `source_id`, `type ∈ {text, url, document}` and, for text, a `content_url`. Delete works
per source (`delete-knowledge-base-source`).

Limits *(docs only)*: 25 files × 50 MB per KB; URL crawl is a single page unless
`auto_crawling_paths` is used (depth not documented); `enable_auto_refresh: true` refreshes URL
and connected-file sources **daily**, `last_refreshed_timestamp` shows when; chunking 600–6000
chars. Pricing: **first 10 KBs per workspace free, then $8/KB/month, plus $0.005/min when a call
uses one.**

**Decisions:** W4 accepts ≤ 20 sources per KB, files ≤ 20 MB, URLs as single pages, with
`enable_auto_refresh: true` and a "Refresh now" that deletes-and-re-adds the URL source. The
KB quota of §5.2 (0/1/3/5 per plan) is the customer's; the platform's shared "10 free" pool
is a COGS input in `retell_cost_inputs`, not a customer-facing limit. One KB per agent.

**D6 addendum (21 Sep 2026, real run):** `create-knowledge-base` answers `400 knowledge base
name too long` above 40 characters. Our deterministic names are therefore `kb-<20 hex of the
agent id>` and `num-<20 hex of the number id>` — 27 and 28 characters with the `dev-` prefix,
still unique, still the retry's lookup key (ADR 0013 §2).

### 9. TTS preview for "Hear my greeting"

**There is no text-to-speech preview endpoint** in the API, the SDK or the docs; the dashboard
plays static `preview_audio_url` clips, which every catalogue voice has. **Decision:** W3 plays
the provider preview clip. "Hear my greeting" in the customer's own words is P2, implemented as
a 15-second `create-web-call` against the draft (it *is* a call: ~$0.03 and a `calls` row with
`is_test`), not as a TTS call.

### 10. Website widget, and concurrency

*(docs only)* Retell ships a **Website Widget** (`<script>` tag, `data-public-key` +
`data-agent-id`, voice and chat, plus a "callback" mode that phones the visitor). White-label
needs a token obtained from Retell. It uses Retell's *public key* system with direct
browser→Retell calls, so it bypasses our API: no `calls` row, no balance check, no metering
until `call_ended`, and the Retell brand unless white-labelled.

**Decision:** do not use Retell's widget. §11.5's widget is ours — `retell-client-js-sdk` behind
our `POST /agents/:id/test/web`-style endpoint, which is exactly what the D2 test page proves
(a 60 s browser call, `call_started-web.json`).

Concurrency: **web calls, inbound, outbound and batch calls all draw from one pool per
workspace**. Ours is 20 today (`get-concurrency.json`: `base_concurrency 20`,
`concurrency_purchase_limit 180` → up to 200 at $8/slot/month). `concurrency_limit_reached`
calls wait ~40 s for a slot, then go to the number's `fallback_number` or drop. **Decision:**
`active:{ws}` counts web and phone calls alike (§14.3); the sum of plan caps that can be live at
once is monitored against `concurrency_limit`, and purchasing more is an ops action, not code.

### 11. `post_call_analysis_data` types

**All four §9.8 types work:** `string` (with `examples`), `enum` (`choices`), `boolean`,
`number`, plus Retell's `system-presets`. Results arrive in `call_analyzed` →
`call_analysis.custom_analysis_data` (`call_analyzed-inbound.json`:
`{"caller_name":"Sam","call_reason":"question","callback_requested":false,"party_size":1}`).

Two things to design around: **absent values come back as the type's zero value**, not null
(`""`, `0`, `false`) — `analysis_json` consumers treat those as "not captured"; and a
`not_connected` call still gets a `call_analyzed` with `custom_analysis_data: {}`. Fields are
also echoed per version in `list-agent-versions` as `custom_analysis_fields`.

### 12. Redis-down policy for the inbound hot path (§13.9)

Facts from 1 above: a hung webhook is a **dead line** (ringing, then nothing, for ~30 s); a fast
non-2xx is an **answered, unauthorised call** on the number's `latest_published` agent with that
agent's own `max_call_duration_ms`; a `reject` is a busy tone. Retell decides nothing about our
customer; whatever we return in under 10 s is what happens.

**Decision: fail open, fast and bounded.**

1. Every Redis read on the path runs under one **150 ms** budget. On timeout or connection
   error the handler returns **200 `{}` immediately** (not a 5xx — that adds three retries and
   ~2 s of ringing for the same outcome, and not `reject` — that turns an outage into missed
   calls for every customer at once).
2. The call then runs the number's `latest_published` agent with the plan's
   `max_call_duration_ms` baked in at publish (from `agent_stack_configs`), so a single call's
   exposure is bounded by the plan maximum, and Retell's 20-call workspace pool bounds the rest.
3. `call_ended` still bills: metering is Postgres via the queue, not Redis-only, and BullMQ is
   down with Redis, so the webhook handler stores `webhook_events` in Postgres first (already
   the §13.10 order) and the queue drains when Redis returns. Nothing is unbilled; what is lost
   for the outage window is the *authorisation* (paused, blocklist, balance, cap, hours).
4. Every fail-open answer is a Sentry event and a `retell_inbound_fail_open_total` metric with
   a Slack alert on the first one. `INBOUND_REDIS_DOWN_POLICY=closed` is a deploy-time switch
   that flips step 1 to `reject` for an operator who prefers busy tones during an incident.
5. `runtime-cache` full refresh runs on Redis reconnect, before the API reports healthy.

Rejected: *fail closed* (a Redis blip = every customer's phone rings out; the product's one
promise is "your phone gets answered"); *Postgres fallback* (puts Neon on a 300 ms budget the
architecture explicitly keeps it off, §13.9); *let Retell time out* (worst of both: dead line
*and* three retries).

## Also found

- **Webhook signature.** `x-retell-signature: v=<unix ms>,d=<hex>` is HMAC-SHA256 over
  `rawBody + timestamp` keyed with the **API key** (the one carrying the "webhook" badge in the
  dashboard), valid ±5 minutes. There is no separate webhook secret; `RETELL_WEBHOOK_SECRET` is
  removed. `Retell.verify()` passed on all 46 webhooks received today (`signature_valid: true`
  in every fixture), against the exact wire bytes kept by `modules/webhooks/raw-body.ts`.
- **SDK 6.0.1 quirks.** `agent.publish()` throws on Retell's empty 200 (gateway uses the raw
  response); `list-agent-versions` and `list-calls` return `{items, has_more}`, not arrays;
  `create-web-call` returns `transport: 'gateway'` + `ice_servers`, and the browser SDK's
  `RetellWebClient.startCall()` must be given `transport` (and `callId`, `iceServers`) or it
  tries LiveKit and fails with "invalid API key" — §12.3's client flow passes the whole
  response through.
- **Custom SIP headers become dynamic variables** (`diversion`, `p-asserted-identity`,
  `twilio-*`) on inbound calls; nothing in §9.7 may collide with those names.
- **A Twilio number cannot call itself** (400). Automated inbound tests need two numbers.
- `call_analyzed` carries `llm_token_usage`, `latency.{llm,e2e,tts,asr}` percentiles and
  `recording_url` / `recording_multi_channel_url` (signed, expiring — proxied per §17, never
  stored as the recording).

## Consequences

- `RetellGateway` as built today is the contract: `inboundAllow()/inboundDecline()`,
  `latest_published` binding, `createAgentVersion()` before edits, raw-response publish,
  API-key signature verification, `clampDuration()`.
- `.env.example`, `pnpm doctor`, `docs/runbooks/provisioning.md`, `docs/architecture.md`,
  `CLAUDE.md` updated in the same change. `RETELL_WEBHOOK_SECRET` is gone.
- D3 metering and exactly-once tests are written against the fixtures named above; D4's
  inbound path implements item 12 verbatim.
- Open, not blocking: a "closed" agent for the `hours` decline (item 1); toll-free monthly
  price (item 4); §20 item 3 (Standard-tier model) still needs the quality benchmark — cost
  data for gpt-5-mini is now real ($0.008/min).
