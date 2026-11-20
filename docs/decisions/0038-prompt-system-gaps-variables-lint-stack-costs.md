# 0038 — Prompt-system gaps: the §9.7 variables, two §9.5 checks, the §4.3 stack, cost inputs and the generation target

Date: 4 Nov 2026. Status: **accepted**, with two owner-level calls made in session on the
engineering recommendation and awaiting the spec owner's sign-off (see "Decisions taken").
Full Scope 05. Spec: §4.3, §9.4 rule 7, §9.5, §9.7, §13.4, §18; admin §5.4 / SA5. Amends
ADR 0012 (the generation target and the thinking default), ADR 0035 (the variable set) and
the cost basis of ADR 0037 §2. Closes audit rows G-09, G-11, G-12, G-16, G-17, G-18 and Z-14
(`docs/audits/voice-agent-portal-phase-audit.md`, addendum of 4 Nov). Evidence:
`docs/evidence/2026-11-04-prompt-gaps/`.

## Context

The 29 Oct audit and ADR 0037 left the prompt system short of the spec in four ways:

1. **§9.7** lists seven variables "set per call by the inbound webhook; for web tests,
   computed at token creation": `{{business_name}}`, `{{agent_name}}`, `{{caller_number}}`,
   `{{current_time}}` (workspace TZ), `{{business_open}}`, `{{next_open_time}}`,
   `{{primary_language}}`. ADR 0035 computed three of them. `caller_number` and
   `primary_language` were never sent, `current_time` was HH:MM with no day, in the custom
   answering schedule's zone when it had one, `agent_name` was the portal label inbound and
   the brief's name on a test, the D18 callback sent no hours at all, and **no prompt read
   any of them** (ADR 0037, "Also found"): a variable is substituted only where `{{…}}` is
   written. §9.4 rule 7, "Respect `{{business_open}}`", was a bullet without the variable.
2. **§9.5** "transfer number set but no transfer tool" compared the brief's numbers with
   themselves (the tools are built from the brief), so it could not fire; "language
   mismatch" had stopwords for en/fr/es only, so the Arabic agents of ADR 0027 skipped it.
3. **§4.3**: the seeded stack ran Standard on GPT-5 mini (ADR 0037 decided GPT-4.1 mini) with
   an ElevenLabs default voice ($0.040/min, a voice our own catalogue files under Premium),
   and `retell_cost_inputs` was two blended numbers that no seed wrote, checked against the
   *dearest* credit only (super-admin audit AS-222..AS-224).
4. **§18** generation p95 ≤ 10 s was measured at 15.5 s (ADR 0012) with the decision left
   to the owner.

## 1. Every §9.7 variable, on every channel, from one builder

`callVariables(facts, at)` in `modules/runtime-cache/hours.ts` returns all seven as
strings. Its callers are every place a call is answered or minted: the inbound allow
(`decide()`), the W5 browser test and "Call my phone" (`TestCallService`), the website
widget and the D18 callback. The agent's sync defaults cover the seven too, for a call let
through by a fail-open.

| Variable | Value | Was |
| --- | --- | --- |
| `business_name` | `tenants.name` | same |
| `agent_name` | the brief's `agent_name` (W2, "Sophie"), else `agents.name` (`spokenAgentName()`); inbound reads it from `num:{e164}`, written from the **published** brief | `agents.name` inbound, the brief's on tests |
| `caller_number` | inbound: the platform's `from_number`, normalised to E.164, `''` when withheld; "Call my phone" and the callback: the person rung; web: `''` | never set |
| `current_time` | `"Wednesday 4 November 2026, 14:05"`: day, date and 24 h time in the workspace hours' zone, else `tenants.timezone`; an unreadable zone gives the UTC clock marked `UTC` | `HH:MM`, the custom schedule's zone, ISO UTC as a fallback |
| `business_open` / `next_open_time` | unchanged (ADR 0035) | — |
| `primary_language` | our locale id (`ar-AE`, not the platform's `ar-SA`): the live agent's inbound (`num:{e164}.primary_language`), the tested version's on a test | never set |

The day and date are in `current_time` because "tomorrow at 09:00" and "are you open on
Saturday?" cannot be placed against a bare 14:05. `num:{e164}.primary_language` is optional,
like `transfer_fail_message`, so a record written before it reads as `''` until the next
5-minute refresh, with no version bump to empty the cache.

**The prompt reads them.** `HOURS_RULE` joins `FIXED_PLATFORM_GUARDRAILS` (the §9.4 bullets
stay SA6's to word): it names `{{current_time}}`, `{{business_open}}` and
`{{next_open_time}}`, says to tell a caller the business is closed and when it reopens, and
never to invite them in while closed. Fixed, so it reaches every live agent at its next sync
with no regenerate (ADR 0037's recommendation). `callVariablesSection()` in the generation
and feedback turns lists all seven, says they are not skeleton placeholders, and that an
after-hours step depends on `{{business_open}}`. It allows `{{caller_number}}` to be read out
only when the caller asks to use the number they are calling from, so the after-call
phone check (`captured-phones.ts`) still sees the number the caller confirmed.

**Measured.** On the voice platform (`bench:incall`, the hand-written hours line ADR 0037
added to its script removed, so only `HOURS_RULE` names the variables), the closed-hours
call was handled 3/3 by both models: "The practice is currently closed. We will reopen
Monday at 9am." In generation, 11 of 15 scripts used a §9.7 variable with the section, 0 of
15 without it.

## 2. The two §9.5 checks

**`transfer_tool_missing`** is fed what reaches the platform: the `transfer_call` tools
come from `transferRoutes(brief)`, the same function `AgentRetellService.llmSpec` uses, and
the transfer targets of every phone number answering for the agent come from
`agentNumberTransferTargets()` (all six lint callers: generation, feedback, draft PATCH, the
Advanced editor's dry run and save, publish). It fires on, in order: a brief hand-off number
with no tool (a guard on `transferRoutes`); **a number's own D4 transfer target that no tool
dials**; and `transfer_N` / `transfer_call` written into the script when the agent has fewer
tools. The default severity is now **warning**: the commonest cause is a phone number's
setting, which a publish of the agent cannot fix, and blocking an activation over it would
be worse than the transfer it reports. Stack v2's `lint_json` says the same; a v1 row still
says `error` until v2 is seeded.

Found while tracing this, and **not fixed here**: the tools dial a *predefined* number, so a
D4 number's transfer targets, sent per call as `transfer_number_N`, are never dialled unless
they equal a brief number. The rule now tells the customer so. A fix (a tool destination of
`{{transfer_number_N}}`, if the platform substitutes variables there, which nobody has
verified) changes how every live transfer is placed and needs a real transferred call to
verify; it is its own change.

**`language_mismatch`** gains Arabic: twenty stopwords, matched after folding vowel marks,
tatweel, alef and yeh spellings, and right-to-left controls, which otherwise split a word.
`ar-SA` and `ar-AE` both map to `ar`. Mixed content is judged by what most of it is;
languages without stopwords (de, ja, …) still skip the rule, as before.

## 3. The §4.3 stack: `agent_stack_configs` v2

| | v1 | **v2** | §4.3 |
| --- | --- | --- | --- |
| Standard LLM | `gpt-5-mini` | **`gpt-4.1-mini`** | GPT-4.1 mini (ADR 0037) |
| Standard default voice | `11labs-Adrian`, Flash ($0.040) | **`cartesia-Adrian`** ($0.015), provider default model | Retell platform / Cartesia $0.015 |
| Premium LLM | `gpt-4.1-mini` | **`gpt-4.1-mini`** (unchanged) | GPT-4.1 |
| Premium voice | `11labs-Adrian`, Multilingual v2 | unchanged | ElevenLabs |
| `transfer_tool_missing` | error | **warning** | (lint is "warnings") |

`cartesia-Adrian` is the same name and American male persona as the old default, exists in
the dev workspace's `list-voices`, and its sample clip already ships
(`voice-samples.generated.ts`). Seeding is by version: `pnpm db:seed` creates each shipped
version (`agent-stack-v1.ts`, `agent-stack-v2.ts`) once and never rewrites one; the newest is
in force, so a seeded v2 moves every agent at its next sync.

**ADR 0037's condition, rerun on the v2 prompt** (`bench:incall`, 10 English scenarios plus
French, 3 runs, 4 Nov 07:3x UTC, `incall-bench-v2.json`):

| | GPT-4.1 mini (Standard) | GPT-4.1 (§4.3 Premium) | ADR 0037 run 2, GPT-4.1 mini |
| --- | --- | --- | --- |
| Checks passed | 205 / 227 (90.3 %) | 195 / 216 (90.3 %) | 182 / 199 (91.5 %) |
| Hung up before the caller was done (English) | **9 of 30** | **14 of 30** | 11 of 30 |
| Invented an appointment slot (English) | 0 | 0 | 0 |
| Closed-hours call, closed stated with the reopening time | 3 / 3 | 3 / 3 | 3 / 3 (script line) |
| Whole-response latency p50 / p95 | 1 046 / 1 700 ms | 1 116 / 1 506 ms | 1 025 / 1 416 ms |

Standard meets the condition (≤ 11 of 30, no invented slot), so it moves. GPT-4.1 does not:
held to the same bar, it hangs up early more often, at 3.5× the model cost, with no check it
passes more. **Premium stays on GPT-4.1 mini** (decided below). The tiers still differ in
voice (ElevenLabs), transcription (`accurate`), denoising and the call ceiling.

## 4. Cost inputs, itemised, and a margin per pack

`retellCostInputs` is now the table admin SA5 describes: voice engine, TTS by provider or
`provider:voice_model`, LLM by model id, telephony by country, knowledge base, analysis per
call, monthly fixed costs and the margin floor. `seed-data/retell-costs-v1.ts` holds the
platform's pricing page as read on 4 Nov, and the bill (ADR 0037 §2) where the two differ.
The seed adds it to an empty table, or as a new version over legacy two-rate rows; an
itemised row is never touched. There are no token rates: the in-call model is billed per
minute (ADR 0037), and the brief → prompt model is a per-generation cost outside a
per-minute margin.

Two lines differ from §4.3's basis, and the table carries the billed figure:
**ElevenLabs Multilingual v2 is $0.06/min** on the page (§4.3 assumes $0.040 for Premium),
and **Canadian telephony bills $0.030/min** (ADR 0037 §2; the page shows $0.015).

`marginsFor(config, costs, tiers)` prices a tier's minute from its **current stack**
(`tierCostPerMin`: voice engine + the default voice's TTS + the model + the dearest
telephony country + knowledge base: §4.3's "COGS / min (phone, Retell number)" at its worst
case) for **every active priced pack** (admin §5.4: "blocked if any active pack's Standard
margin < floor"). The old check priced one row per tier at the dearest credit. A missing
input makes that margin `null` with `missing: ['llm:…']`, and a voice model is priced as
itself or not at all, never as its provider's cheaper plain row. Missing inputs, or none at
all, are now a margin blocker (super admin override with a note) instead of a warning: an
unknown margin is not a passing one. The flat analysis charge is shown as a preview warning
beside the per-minute margin.

On the seeded catalogue and stack v2: Standard 11.78 ¢/min, Premium 16.28 ¢/min; Pro
Standard **46.9 %**, Pro Premium **51.1 %**, Starter Standard 63.9 %, all above the 35 %
default floor.

The console's Costs tab is an editable table per map (add, remove, duplicate keys refused),
and Preview's margin table gains a Pack column. Clicked through in headless Chrome against
the local API and staff issuer: 19 checks, desktop, 390 px and dark
(`console/costs-check.mjs`). The console header's search button could not shrink at phone
width (472 px page on a 390 px screen) and now can, and four em dashes went from the Pricing
page and the Stripe plan text.

## 5. Generation latency (§18, audit Z-14)

Same five briefs × 3, `claude-sonnet-5`, effort `low`, 4 Nov, `bench:generation --repeat 3`:

| Run (n = 15) | mean | p50 | p95 | first token p50 | thinking p50 | out tokens / gen | checks |
| --- | --- | --- | --- | --- | --- | --- | --- |
| before (no §9.7 section, `--without-variables`) | 14.1 s | 13.6 s | 16.7 s | 1.8 s | 0.56 s | 1 415 | 15/15 zod, guardrails, lint |
| after (section) | 14.5 s | 14.6 s | 16.4 s | 1.9 s | 0.35 s | 1 452 | 15/15 |
| after, `GENERATION_THINKING=off` | 13.9 s | 14.4 s | **15.2 s** | 1.1 s | 0 | 1 415 | 15/15 |

None of 45 samples finished under 10 s. Our own stages are ~60 ms (ADR 0012); the model
streams about 100 tokens a second, so the ~1 400-token envelope alone is ~13 s. The one
change since 21 Sep: adaptive thinking, which emitted nothing then, now spends 0–1.9 s a
generation; off, it costs 1.2 s less at p95 and 0.7 s less to the first token, with every
check unchanged. The variables section moved nothing measurable (input +385 tokens, output
+37). The split (ADR 0012: ≈ 10–11 s p95, +24 % cost) was not rebuilt.

**Decided:** the target is amended to **p95 ≤ 16 s** and `GENERATION_THINKING` defaults to
`off` (`adaptive` opts back in). §18's 10 s stands in the spec as the owner's to change;
Z-14 is ADR-amended by this record.

## Decisions taken

Asked in session on 4 Nov with the measurements above, the user (Saksham) chose "the
recommended way" for both, so these are the engineering recommendation, adopted, and the spec
owner (Pramod) has not yet signed them off:

1. **Generation target**: accept p95 ≤ 16 s, thinking off by default. Rejected: keeping
   10 s with Z-14 FAIL (no path to it on one call); building the split now (it needs a person
   to read a dozen outputs for card/prompt coherence, and costs +24 %).
2. **Premium model**: stay on GPT-4.1 mini until GPT-4.1 (or another model) meets the bar
   ADR 0037 set for Standard; a deviation from §4.3's Premium LLM cell.

Not taken here: the post-call analysis model (`gpt-5.6-terra`, 2.08 ¢ a call, ADR 0003 §3
said to replace it) and any price change; both are the owner's.

## Alternatives considered

- **Hours as a §9.4 bullet in a v2 stack row.** Only agents on v2 would get it and SA6 could
  word it away; the rule exists so the platform's own hours logic is honoured.
- **`{{caller_number}}` offered as the callback number by default.** Faster for the caller,
  but the confirmed number would then never appear in the caller's own words, and the
  after-call check would flag every such call.
- **Keep `transfer_tool_missing` an error.** It would block activations on a phone number's
  setting the customer may not know about.
- **Arabic by script share instead of stopwords.** Simpler, but it reads a bilingual
  English prompt quoting an Arabic greeting as Arabic; stopwords keep one method for all.
- **Keep the margin at the dearest credit with blended rates.** It cannot see a model or
  voice change, and it passed a Pro pack under the floor.

## Consequences and deploy steps

- `pnpm db:seed` on each environment adds stack v2 and the cost list. Every agent moves to v2
  at its next sync; then `pnpm --filter @portal/api agents:republish --apply` once, so live
  agents get v2's Standard model and voice and `HOURS_RULE` now rather than at their next
  edit. Run it after the deploy, as for ADR 0035.
- Set `GENERATION_THINKING=off` (or remove it) in each environment's SSM parameters and in
  local `.env` files that set `adaptive` explicitly (this machine's `.env` does).
- Staff re-enter or check the cost inputs in Pricing > Costs if an environment held
  hand-entered two-rate rows: those rows no longer parse, and the margin check blocks until
  an itemised row exists (the seed adds one).
- Tests: `hours.test.ts`, `inbound.decide.test.ts`, `prompt-builder.test.ts`,
  `guardrails.test.ts`, `agent-retell.test.ts`, `lint.test.ts`, `admin.helpers.test.ts`,
  `anthropic.provider.test.ts` (the thinking default);
  e2e `calls`, `d9-test-call`, `d17-channels`, `d18-outbound`, `agent-settings`,
  `d12-admin`. QA cards: ClickUp "Unit Testing" list, tag `adr-0038`.
- Open: D4 transfer targets are not dialled (§2); the spec owner's sign-off on the two
  decisions; the §4.3 Premium TTS price in the spec (Multilingual v2 $0.06).
