# ADR 0009 — LLM provider for prompt generation: back to Anthropic

- Status: accepted
- Date: 2026-09-15
- Deciders: Saksham
- Supersedes: [ADR 0007](0007-llm-provider-openai.md) in full. Restores the LLM row of
  [ADR 0001](0001-tech-stack.md) with the same model, `claude-sonnet-5`.
- Scope: **generation only.** The in-call LLM is Retell's and stays open (§20 item 3).

## Context

ADR 0007 moved brief → prompt generation from Anthropic to OpenAI the day before this, on two
arguments it labelled as judgement: the owner's quality assessment, and "family alignment" — the
prompt is executed by an OpenAI model inside Retell, so writer and executor in the same family
might share phrasing conventions. It said explicitly that no benchmark had been run and that the
provider should sit behind an interface so the choice was one file to reverse.

Two things changed on 15 Sep:

1. **An Anthropic API key is available to the project.** Under ADR 0007 the OpenAI key was still
   empty (`docs/architecture.md`, vendor status) and sat first on the P0 critical path. The
   provider with a working key today unblocks the D2 benchmark and D5; the one without does not.
2. **The family-alignment argument does not hold up on a second look.** A prompt is natural-language
   text; nothing in it is model-specific wire format, and there is no evidence that a prompt written
   by one model runs better on a sibling. Vendor count is a tie either way — the in-call model runs on
   Retell's own keys, so the project holds exactly one LLM key regardless of provider.

The `prompting` module is still unwritten (D5), so this reversal costs what ADR 0007 cost: a
configuration edit and this document.

## Decision

**Anthropic for prompt generation**, `claude-sonnet-5`, structured output via `output_config.format`,
adaptive thinking.

`claude-sonnet-5` — the model ADR 0001 named — and not `claude-opus-5`, for two reasons, neither of
which is cost:

1. **The quality-sensitive part of the job is done by code, not by the model.** The §9.4 platform
   guardrails are appended by the worker *after* the zod parse (generation sequence in
   `docs/architecture.md`), so the model never has to preserve them. Its job is the business prompt
   from the brief — well-specified structured drafting, which the Sonnet tier does reliably. The one
   place model judgement still matters is the §9.6 feedback path (guardrail-conflicting feedback
   must come back as `changes: []` plus an explanation), and the §9.5 lint is the second guard there.
2. **The D5 exit check is p95 ≤ 10 s, and Sonnet meets it without tuning.** _Amended 17 Sep 2026:
   measured on 16 Sep, Sonnet's p95 is 17.4 s (ADR 0012, "Measured against the real model"). The
   cost is output length, not thinking, and the miss is reported to the owner rather than tuned
   away. The choice of Sonnet stands; this reason does not. 21 Sep 2026: the pipeline was
   instrumented stage by stage and the envelope trimmed without dropping anything §9.3 asks
   for — p95 15.5 s, and a measured two-call split reaches 10.6 s; see ADR 0012, "Measured
   again, with the pipeline instrumented"._ Opus with adaptive
   thinking on a ~2.5k-token envelope needs `output_config.effort` tuned to stay inside that budget.
   A solo developer with an MVP on 2 Oct should not spend D5 tuning latency out of headroom the
   task does not use.

Cost is a tie, not a reason: roughly 3¢ per generation on Sonnet against 8¢ on Opus, two or three
generations per agent lifetime, against a $49 pack. Do not read this as "the cheaper model"; read
it as "the model that fits the constraint without work". `GENERATION_MODEL` is an env var, so
`claude-opus-5` ($5 / $25 per MTok against $2 / $10) is a one-line change if the D2 benchmark shows
Sonnet's prompts producing worse test calls.

Honesty note: this is the second provider decision in two days made without benchmark data. It is
recorded as a judgement call, as ADR 0007 was. What is *not* a judgement call is the availability
argument, and that is why it happens today rather than after the benchmark.

## Alternatives considered

- **Stay on OpenAI and obtain a key.** Nothing is wrong with `gpt-5` for this task. Rejected because
  the key is not in hand, the Anthropic key is, and the only technical argument for OpenAI (family
  alignment) is unmeasured and, on reflection, weak.
- **Run the D2 benchmark first, then decide.** The right order in principle. Not possible without
  both keys, and the benchmark is still scheduled (see Consequences), so this decision is provisional
  in exactly the way ADR 0007's was.
- **`claude-opus-5`.** _Benchmarked 17 Sep 2026 and not adopted: 5/5 zod-valid, but p95 28.3 s
  against Sonnet's 17.1 s and $0.067 a generation against $0.021. `claude-haiku-4-5` was
  measured at the same time — p50 12.3 s, p95 19.7 s, $0.008 — and is thinner. No model meets
  the 10 s target; see ADR 0012, "The model benchmark ADR 0009 left open"._ More headroom at
  ~2.5× the price, and it needs effort tuning to stay under the
  10 s p95. The headroom goes unused because the guardrails are appended by code. Not chosen for
  now; the D2 benchmark runs both, and the env var makes the swap one line.
- **Both providers, chosen per template**, and **Retell Conductor** — rejected in ADR 0007 for
  reasons that still hold (ambiguous `stack_version`; Conductor is dashboard-only, quota-capped,
  human-in-the-loop and inverts the §9 version model).

## Consequences

- `.env.example`: `OPENAI_API_KEY` and `OPENAI_ORG_ID` are gone, `ANTHROPIC_API_KEY` is back,
  `GENERATION_MODEL=claude-sonnet-5`. `pnpm doctor` checks the new key from D2. A developer's own
  `.env` is changed by hand — the key never lives in the repo (§17), and SSM gets it for staging/prod.
- Docs and plan updated in the same change: CLAUDE.md, `docs/architecture.md`,
  `docs/runbooks/provisioning.md`, `docs/plan/tasks*.{csv,md}`, ClickUp D1 (accounts) and D5
  (generation model).
- **The provider interface stays.** `modules/prompting/providers/` with
  `generate(brief) → GeneratedPrompt`, exactly as ADR 0007 asked for. Two reversals in two days are
  the proof it is needed, not a reason to skip it.
- **The D2 benchmark stays.** Five briefs across templates (receptionist, appointment, afterhours,
  lead_qual, one more), `claude-sonnet-5` against `claude-opus-5` on the one key in hand (and OpenAI
  too if a key turns up), five metrics: first-try zod validity, §9.4 guardrail
  retention, §9.5 lint pass, p95 latency (≤ 10 s), and behaviour on guardrail-conflicting feedback
  (`changes: []` + explanation, versus silently breaking the guardrail). Then two or three real test
  calls through Retell on the best prompts — the prompt's job is a good call, not good prose. If
  Opus or OpenAI wins on the calls, ADR 0010 with the data.
- **API shape to build against on D5** — the current Anthropic SDK, not what older examples show:
  - Structured output: `output_config: { format: … }` or `client.messages.parse()`. The zod schema
    in `@portal/schemas` stays the contract; the deprecated `output_format` parameter is not used.
  - Thinking: `thinking: { type: "adaptive" }`. `budget_tokens` is rejected on this model. Tune depth
    with `output_config.effort` if the 10 s p95 is at risk.
  - No assistant prefill — it returns 400 on this model family. Format control is structured
    output, never a leading `{` in an assistant turn.
  - `max_tokens` around 16 000 for a non-streaming job; the envelope is a few thousand tokens.
- **Caching is explicit again** (`cache_control` breakpoints) rather than automatic. The ordering
  rule from ADR 0007 is unchanged — system prompt and §9.4 guardrails first, volatile `brief_json`
  last — but at two or three calls per agent lifetime, and with a minimum cacheable prefix of
  512–4096 tokens depending on model, caching is not worth engineering for on D5. Revisit if
  regenerate volume surprises.
- ADR 0001's LLM row now reads Anthropic → OpenAI → Anthropic. That chain is the argument for the
  provider interface; it is not something to tidy away.
