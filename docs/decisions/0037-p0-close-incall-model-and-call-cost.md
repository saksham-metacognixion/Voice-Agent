# 0037 — P0 close: the Standard-tier in-call model (§20 #3) and the cost of a real call

Date: 4 Nov 2026. Status: **accepted**. Decides spec §20 item 3. Closes audit rows P0-05 and
P0-07 and updates P0-09 (`docs/audits/voice-agent-portal-phase-audit.md` §4.1). Amends the
cost basis in spec §4 where the bill differs from it; changes no configuration. The tier stack
row is changed by Full Scope 05 ("Align the tier models with spec §4.3"), which depends on this.
Evidence: `docs/evidence/2026-11-04-p0-close/`.

## Context

Spec §19 P0 lists "benchmark GPT-5 mini vs GPT-4.1 mini on the receptionist template" in its
scope, and its first exit criterion is "cost per test call matches pricing page ±5 %". §20
item 3 leaves the Standard-tier LLM open "after the P0 benchmark", and §4.3 says: "validate
model quality/latency … before locking Standard = GPT-5 mini. If it fails the receptionist
template, step up to GPT-4.1 mini (+$0.004) — margin barely moves."

Neither was done. `agent_stack_configs` v1 was seeded with `gpt-5-mini` for Standard and
`gpt-4.1-mini` for Premium without a recorded comparison (`agent-stack-v1.ts`), and
`bench:generation` measures the brief → prompt model, not the model on the phone. ADR 0003 §3
priced a real call per minute but never set it against the pricing page or our credit price.

The in-call model is a field of the Retell LLM object (`model`, set by `RetellGateway.llmBody`
from `agent_stack_configs.tiers_json.<tier>.model`). Retell runs it on every caller turn with
the general prompt (script + documents + language block + the §9.4 and fixed rules, assembled
by `runtimePrompt()`), the `end_call` tool and one `transfer_call` tool per staff number. It is
billed by Retell per minute of call, not per token: no OpenAI account is involved in a call.

## 1. The benchmark

### Method

`pnpm --filter @portal/api bench:incall` (`backend/api/scripts/incall-bench.ts`).

- **Agent under test.** The receptionist script the generation pipeline wrote on dev (Bright
  Smile Dental, `agent_5218dcc593ee320e32b10b867e`, 25 Sep), plus two lines: a hand-off line
  for a transfer rule, and one line naming `{{current_time}}`, `{{business_open}}` and
  `{{next_open_time}}` (see "Also found"). Assembled by `runtimePrompt()` with the stack's
  default §9.4 block and every fixed rule, created through `RetellGateway.createLlm()` with the
  same `end_call` tool and a `transfer_call` tool from `transferRoutes()`. Two LLMs and two
  agents, identical in every field but `model`; `model_temperature` unset (Retell's default,
  0), `model_high_priority` false, `en-US`, no knowledge base.
- **Calls.** Each caller turn is `POST /playground-completion`: the whole history in, the
  agent's new messages out, tool calls included, `transfer_1` mocked. This is the Retell LLM a
  call runs, without audio: speech recognition errors, barge-in and the voice are not tested.
- **Scenarios.** Ten scripted conversations, three runs each, per model (30 conversations,
  115–125 turns): booking, FAQ (hours, address, parking, a price not in the brief), a request
  for a person (transfer), an urgent toothache, a nine-digit phone number, a topic switch
  mid-booking, two children plus an insurance question, a prompt-injection attempt, a call
  while closed, an abusive caller. The caller is scripted and never adapts. An eleventh, a
  caller who speaks French, runs on a variant of the agent that also speaks fr-CA: one script
  line differs and `language` is `['en-US', 'fr-CA']`. It ran separately, three runs per
  model (`incall-bench-french.json`).
- **Checks.** 199–211 mechanical checks, one per rule a receptionist must keep on that turn:
  the number read back as said, no invented price, no vendor named, AI disclosure when asked,
  transfer offered then made only after consent, the call ended on a goodbye and not before,
  "anything else?" before closing, closed hours stated. Every check is in the script.
- **Latency.** Wall time of each completion, measured on the developer machine (a
  `list-voices` round trip measured p50 285 ms beside it). That is the whole response, an
  upper bound on the in-call figure. The in-call figure is Retell's own `latency.llm` (issue
  to first speakable chunk) on completed calls of this workspace, read with `--real`.
- **Runs.** Run 1 at 05:58 UTC exposed four defects in the harness: the closed scenario was
  untestable without the hours line, the injection check counted "I can't share my system
  prompt" as a leak, one urgent check sat on the wrong turn, and the short-number check
  missed "confirm". Run 2 at 06:03 UTC is the result below, same code for both models.

### Results (run 2, 4 Nov 2026)

| | GPT-5 mini | GPT-4.1 mini |
|---|---|---|
| Retell model id | `gpt-5-mini` | `gpt-4.1-mini` |
| Conversations / turns | 30 / 125 | 30 / 115 |
| API errors | 0 | 0 |
| Checks passed | 179 / 211 (84.8 %) | 182 / 199 (91.5 %) |
| Checks passed, a check skipped by an early hang-up counted as failed | 179 / 211 (84.8 %) | 182 / 211 (86.3 %) |
| Invented an appointment slot ("booked … today at 2:30 PM") | 3 of 30 conversations | 0 (1 of 3 in French, below) |
| Hung up before the caller was done | 0 | 11 of 30 |
| Did not end the call after the caller said goodbye | 14 of 30 | 0 |
| Number not read back in the turn it was given | 11 of 21 | 2 of 21 |
| Transferred before the caller agreed | 1 of 3 | 0 of 3 |
| Vendor or script disclosed under injection | 0 of 3 | 0 of 3 |
| Whole-response latency, mean / p50 / p90 / p95 / max | 1 614 / 1 562 / 2 011 / 2 137 / 4 506 ms | 1 085 / 1 025 / 1 366 / 1 416 / 2 590 ms |
| Run 1 (same scenarios, earlier checks), checks / p50 / p95 | 80.6 % / 1 300 / 1 847 ms | 89.7 % / 1 052 / 1 676 ms |
| Mean reply length | 134 characters | 141 characters |

By scenario (run 2): booking 29/33 vs 21/27, FAQ 19/21 vs 21/21, transfer 18/19 vs 21/21,
urgent 23/24 vs 18/21, short number 11/18 vs 14/16, topic switch 16/18 vs 17/18, two children
19/27 vs 19/24, injection 15/15 vs 15/15, closed 14/18 vs 18/18, abuse 15/18 vs 18/18.
Every reply is in `incall-bench.transcripts.md`.

**A French-speaking caller** (separate run, same harness, 3 runs × 4 turns per model):

| | GPT-5 mini | GPT-4.1 mini |
|---|---|---|
| Checks passed | 16 / 24 | 21 / 24 |
| Answered and stayed in French | 3 of 3 | 3 of 3 |
| Read the number back in the turn it was given | 0 of 3 | 0 of 3 |
| Invented appointment slots ("mercredi à 14h ou jeudi à 10h30") | 0 of 3 | **1 of 3** |
| Ended the call after "Non, c'est tout, merci" | 0 of 3 | 3 of 3 |
| Whole-response latency, p50 / max | 1 517 / 2 417 ms | 1 054 / 3 665 ms |

Twelve turns per model: a direction, not a measurement.

**What the failures are.** GPT-5 mini's are spread: it keeps asking for a phone number after
the caller has said goodbye (the caller hangs up on it), asks a follow-up question instead of
reading the number back, and in all three runs of the nine-digit scenario offered or "booked"
a specific slot the brief never gave it. That breaks §9.4 ("never invent … availability") and
puts a customer at the door for an appointment that does not exist. GPT-4.1 mini's are one
pattern: asked "is there anything else?" or "is that number right?", a caller who answers
"yes, that's right" is thanked and the call is ended, with every detail already read back.
`CLOSING_RULE` says a short reply is not a goodbye, so this breaks a fixed rule, but nothing is
lost that the after-call card does not hold. GPT-4.1 mini is not immune to inventing
availability either: it did once, in French. Across all 33 conversations per model that is
3 for GPT-5 mini and 1 for GPT-4.1 mini.

### In-call latency on real calls (`get-call.latency.llm`, first speakable chunk)

| Model | Calls | Turns | p50 | p90 | p95 | Prompt tokens per request (mean of call averages) |
|---|---|---|---|---|---|---|
| `gpt-5-mini` | 43 | 234 | 745 ms | 1 206 ms | 1 521 ms | 1 233 |
| `gpt-4.1-mini` | 3 | 9 | 664 ms | 914 ms | — | 2 472 |

Nine GPT-4.1 mini turns are too few for a p95 or a firm p50; they are shown, not relied on.
The benchmark's 115 and 125 turns per model are the comparison.

### Cost per call of the model

Retell bills the in-call model per second of call at a fixed rate. Tokens do not change the
bill; the playground reports none, and `llm_token_usage` on real calls is the prompt size
per request, shown above for completeness.

| | GPT-5 mini | GPT-4.1 mini |
|---|---|---|
| Rate billed on real calls (`unit_price`) | 0.0133333 ¢/s = **$0.0080/min** | 0.0213333 ¢/s = **$0.0128/min** |
| Retell pricing page, 4 Nov 2026 | $0.008/min | $0.0128/min |
| Spec §4.1 (10 Sep) | $0.012/min | $0.016/min |
| On the 75-second call in §2 | 1.00 ¢ | 1.60 ¢ |

The difference is **$0.0048 per minute**, a little more than §4.3's "+$0.004".

### Decision: the Standard tier runs GPT-4.1 mini

- It passes more checks on both runs, and still does with every skipped check counted as a
  failure.
- Its usual failure costs the caller a closing question. The worst failure, inventing an
  appointment, happened to both models, three times as often with GPT-5 mini (3 of 33
  conversations against 1 of 33). A fixed-rule breach that loses nothing beats a guardrail
  breach that sends a customer to a slot nobody holds.
- It answers about half a second sooner at p50 and seven tenths at p95. On a phone, that is
  the gap between a pause and an awkward one.
- §4.3 pre-approved exactly this step if GPT-5 mini failed the receptionist template, at a
  cost it called "margin barely moves". The measured cost is 2.2 points of margin on a Pro
  credit (§2).

**Condition.** The early hang-up is a `CLOSING_RULE` breach. Before Full Scope 05 points live
Standard agents at GPT-4.1 mini, it reruns `bench:incall` after any change to the closing rule,
and ships only if "hung up before the caller was done" is not worse than 11 of 30 and no
English conversation invents a slot. Invented availability is the failure to drive to zero
for both models, through the script rather than the model choice.

## 2. A real call, priced

### The call

`call_5b1b1fe15ad14611cd2a6e546ab`, 21 Sep 2026 08:30 UTC, the inbound call of the D6
verification (ADR 0013, "The real run — 21 Sep 2026"), on the Retell dev workspace. Standard tier (`metadata.tier = standard`, rate
1.0), the seeded Standard stack exactly: `gpt-5-mini`, ElevenLabs Flash, a Retell-bought US
Twilio number, a knowledge base. 74.142 s from `start_timestamp` to `end_timestamp`; Retell
billed 75 s (it rounds up, ADR 0003 §3).

Retell's `call_cost` is the only provider bill for a call. It includes the model, the voice,
the telephony line and the knowledge base. Nothing is billed to us by OpenAI, ElevenLabs or
Twilio directly. No Retell invoice API exists, so the per-call record is the evidence; the
monthly invoice was not reconciled against it.

| Product (Retell `call_cost`) | Billed rate | Per minute | Billed for 75 s | Retell pricing page, 4 Nov | Difference |
|---|---|---|---|---|---|
| `retell_voice_engine` | 0.0916667 ¢/s | $0.0550 | 6.875 ¢ | $0.055 | 0.0 % |
| `elevenlabs_tts_03_2026` (Flash) | 0.0666667 ¢/s | $0.0400 | 5.000 ¢ | $0.040 | 0.0 % |
| `gpt_5_mini` | 0.0133333 ¢/s | $0.0080 | 1.000 ¢ | $0.008 | 0.0 % |
| `us_twilio_telephony` | 0.025 ¢/s | $0.0150 | 1.875 ¢ | $0.015 | 0.0 % |
| `knowledge_base_usage` | 0.0083333 ¢/s | $0.0050 | 0.625 ¢ | $0.005 | 0.0 % |
| **Priced per minute** | 0.205 ¢/s | **$0.1230** | **15.375 ¢** | **$0.123** | **0.0 %** |
| `gpt_5_6_terra_text_testing` (post-call analysis) | flat per call | — | 2.080 ¢ | not listed | — |
| **Total** (`combined_cost`) | | | **17.455 ¢** | | +13.5 % over the priced lines |

Every rate the pricing page publishes matched the bill to the rounding. The total is 13.5 %
above them because of the flat post-call analysis charge, which the page does not list and
§4 does not carry (known since ADR 0003 §3).

### Against the spec's cost basis

Spec §4.3 Standard COGS with a knowledge base is $0.102/min (voice $0.055, Cartesia $0.015,
GPT-5 mini $0.012, telephony $0.015, KB $0.005). The billed $0.123/min is 20.6 % higher. Two
lines differ: the seeded Standard voice is ElevenLabs Flash ($0.040), not a $0.015 voice, and
GPT-5 mini bills $0.008, not $0.012. The first is Full Scope 05's to align.

### Against what we charge

Our metering on Retell's own payload (`computeCharge(call, 1.0)`) gives 74.142 s → **1.24
credits**, the figure ADR 0013 recorded from that run's ledger on 21 Sep. A credit is worth
what the customer paid for it, so the comparison is per pack. A credit is one Standard minute
(§5.1); per minute, the comparison is price per credit against cost per minute.

| Pack (§5.2, published `pricing_configs` v1) | $ per credit | Revenue for 1.24 credits | Margin, GPT-5 mini (17.455 ¢) | Margin, GPT-4.1 mini (18.055 ¢) | Long-call margin per minute, GPT-4.1 mini (12.78 ¢) | §5.2's own figure |
|---|---|---|---|---|---|---|
| Starter | $0.327 | 40.51 ¢ | 56.9 % | 55.4 % | 60.9 % | 66 % |
| Growth | $0.298 | 36.95 ¢ | 52.8 % | 51.1 % | 57.1 % | 63 % |
| Scale | $0.266 | 32.98 ¢ | 47.1 % | 45.3 % | 52.0 % | 59 % |
| Pro | $0.222 | 27.53 ¢ | 36.6 % | 34.4 % | 42.4 % | 50 % |

The admin spec's default margin floor is 35 % (admin §5, SA5). The price covers the cost on
every pack. On a Pro credit, a call this short sits on the floor; the floor binds only short
calls, where the flat 2.08 ¢ analysis charge weighs most.

### A Canadian number bills telephony at twice the page

The other Standard-tier calls in the workspace were placed to a Retell-bought Canadian number
(`+1819…`, 25 Sep, four calls). Every one billed `canada_twilio_telephony` at 0.05 ¢/s =
**$0.030/min**; the pricing page lists $0.015 for Canada. With the rest priced as the page
says, the call is 16.1 % above the page on its per-minute lines.

| Call | Stack | Billed | Credits | Margin on a Pro credit, GPT-5 mini / GPT-4.1 mini |
|---|---|---|---|---|
| `call_ab325ab8…` (61 s) | Cartesia, CA number | 13.06 ¢ | 1.01 | 41.8 % / 39.6 % |
| `call_5d7cbe8c…` (61 s, caller leg) | ElevenLabs Flash, CA number | 15.60 ¢ | 1.00 | 29.7 % / 27.5 % |

On the seeded Standard stack, a one-minute call on a Canadian number at Pro prices is **below
the 35 % floor with either model**. Over long calls it is 35.7 % with GPT-4.1 mini.

### What this decides

- **Exit criterion 1 is met** for the rates the pricing page publishes: 0.0 % on every line,
  against a ±5 % tolerance.
- **The cost basis gains three measured lines**, which the margin preview needs:
  - post-call analysis is 2.08 ¢ per call, flat;
  - Canadian telephony is $0.030/min until Retell says otherwise;
  - the Standard voice on the seeded stack is $0.040/min.
- **Pricing is not changed here.** Packs and rates need the owner's authorisation. SA5's
  `retell_cost_inputs` drive the margin check, and the console row needs these figures:
  Standard about 12.8 ¢/min with GPT-4.1 mini on a US number and 14.3 ¢ on a Canadian one,
  both with a knowledge base, plus 2.08 ¢ per call. Staff enter them; nothing here writes them. The local row holds test values,
  5 ¢ and 9 ¢.

## P0 exit review

| Item (§19 P0) | Status | Evidence |
|---|---|---|
| Agent via API, web call, inbound number, webhooks, inbound round trip | PASS | ADR 0003, 15 Sep |
| `call_cost` shape, decline, `max_call_duration_ms` | PASS | ADR 0003 §1–§3 |
| Benchmark GPT-5 mini vs GPT-4.1 mini on the receptionist template | **PASS** (4 Nov) | §1; `docs/evidence/2026-11-04-p0-close/` |
| Stripe Checkout + webhook in test mode | PASS | `checkout-spike.ts`, `billing.e2e` |
| Exit: cost per test call matches pricing page ±5 % | **PASS** (4 Nov) for every published rate, US number | §2; `call-costs.json` |
| Exit: decline path confirmed | PASS | ADR 0003 §1 |
| Exit: brief → live number by hand | PASS | ADR 0013, 24 Sep |

**P0 is complete.** Two items are carried, not hidden. The Canadian telephony rate differs
from the page and is now in the cost basis. The toll-free rate (§21 item 4, audit P0-09) is
still unverified: no toll-free number has been bought, and buying one was not authorised for
this check. It is confirmed on the first invoice, as ADR 0003 §4 already said.

## Also found: no prompt reads the business-hours variables

ADR 0035 computes `{{business_open}}`, `{{next_open_time}}` and `{{current_time}}` per call
and sends them on every channel. No generated script, template, generation prompt or fixed
rule names them (`grep` over `templates/`, `modules/prompting/`, `agent-stack-v1.ts` and the
stored `generation_prompts_json`). Retell substitutes a variable only where `{{…}}` appears, so
a live agent is never told whether the business is open, and the §9.4 rule "when the business
is closed, say so" cannot be followed. Run 1 showed it: without the line, both models invited
the caller in on a Saturday night. Given the line, GPT-4.1 mini handled the closed call 18/18
and GPT-5 mini 14/18. **Not fixed here**: changing what every live agent reads is not this
investigation's to ship. It needs its own change, a fixed line in code like `TRANSFER_RULE`
so it reaches live agents at their next sync, and a republish.

## Alternatives considered

- **Keep GPT-5 mini** and fix its failures in the prompt. Its worst failure, inventing a slot,
  already breaks a §9.4 rule the prompt states twice. It is also the slower model.
- **Retell's simulation tests** (`create-test-case-definition`, `create-batch-test`). An LLM
  plays the caller and an LLM grades the run, so the caller differs between models and the
  grade is a third model's opinion. The scripted caller and mechanical checks give both
  models the same input and a reproducible verdict.
- **Real phone calls per model.** That would measure audio latency end to end, but needs a
  caller per turn and gives a handful of turns. Real-call latency is read from the calls the
  workspace already has.

## Limitations

- **Thirty conversations per model.** That is enough to rank two models whose failures
  differ in kind. It is not enough to set a rate: "3 of 30" could be 1 in 100 or 1 in 4.
- **The checks are regular expressions.** Each failure counted above was read in the
  transcripts, but a pass is not proof of a good reply.
- **No audio.** Speech recognition errors, barge-in, the voice and STT endpointing are
  untested. Whole-response latency includes about 285 ms of network.
- **Too few GPT-4.1 mini calls** for its in-call latency on real calls.
- **One receptionist script.** French is one scenario, three runs. The Arabic agents, the
  other six templates and Premium are not covered.
- **Provider records only.** The cost is Retell's per-call `call_cost`; the invoice was not
  reconciled. The 21 Sep run's ledger row was not re-read, because its workspace is no longer
  in the local database. ADR 0013's record of it is cited instead, and `computeCharge` on
  the same payload reproduces it.
- **Telephony.** The Canadian figure comes from four calls to one number on one day.

## Consequences

- Spec §20 item 3 is **DECIDED: GPT-4.1 mini**, and the §4.3 Standard LLM cell says so
  (`docs/voice-agent-portal-spec.md`; the PDF is the owner's to reissue).
- **Full Scope 05** changes `agent_stack_configs.tiers_json.standard.model` to `gpt-4.1-mini`
  through SA6, republishes live Standard agents, and reruns `bench:incall` first (the
  condition in §1). Premium also runs `gpt-4.1-mini` today, against §4.3's GPT-4.1; with
  this decision both tiers would run the same model. Full Scope 05 must move Premium to
  GPT-4.1, or the two tiers differ only in voice.
- `retell_cost_inputs` needs the measured figures in §2 before the next pricing publish.
- A change to the in-call model or the closing rule is judged with `bench:incall`, the
  way `bench:generation` judges the generation model.
- The business-hours variables need their own change (see "Also found").
