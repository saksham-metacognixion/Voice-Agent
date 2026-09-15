# ADR 0007 — LLM provider for prompt generation: OpenAI

- Status: superseded by [ADR 0009](0009-llm-provider-anthropic.md) on 2026-09-15
- Date: 2026-09-14
- Deciders: Saksham
- Supersedes: the LLM row of [ADR 0001](0001-tech-stack.md) (Anthropic SDK, `claude-sonnet-5`)
- Scope: **generation only.** The in-call LLM is Retell's and is a separate open decision (§20 item 3).

## Context

Two different LLMs exist in this product and they are easy to conflate:

1. **The generation LLM** — turns `brief_json` into a prompt (§9.3) and applies feedback patches
   (§9.6). Runs two or three times in an agent's life, from a background job, off the call path.
2. **The in-call LLM** — runs the actual conversation, inside Retell, on every turn of every call.
   Standard tier is GPT-5 mini or GPT-4.1 mini pending the P0 benchmark (§20 item 3).

ADR 0001 chose Anthropic for the first. This ADR changes that choice. Nothing here touches the
second, which remains Retell's to configure.

The `prompting` module has not been written yet (it lands on D5), so the change costs one
configuration edit and this document.

## Decision

**OpenAI for prompt generation**, `gpt-5`, with structured outputs.

The generation call is a background job that produces a fixed JSON shape:

```
{ prompt, greeting, closing,
  brief_card: { does[], doesnt[], handoff[] },
  analysis_fields: [{ name, type, description, enum? }],
  scenarios: [{ title, say_this }],
  warnings[] }
```

Two arguments carried the decision:

- **The owner's assessment of generation quality.** No benchmark had been run at the time of the
  decision; this was a judgement call, and it is recorded as one.
- **Family alignment with the in-call model.** The prompt this LLM writes is executed by an OpenAI
  model inside Retell. Having the writer and the executor in the same family is a plausible
  advantage — the same phrasing conventions on both sides of the handoff. This is a hypothesis, not
  a measured result.

Cost did not enter into it and should not: a generation call is roughly three to four cents on any
frontier model, against a $49 Starter pack. This decision is a quality decision.

## Alternatives considered

**Anthropic, `claude-sonnet-5`** (ADR 0001). No evidence against it — it was simply not the owner's
preference for this task. Reversible; see Consequences.

**Both, chosen per template.** More surface than a single-developer MVP can carry, and it would make
`agent_versions.stack_version` ambiguous about which provider produced a given prompt.

**Retell Conductor**, Retell's own agent-building copilot. Raised on 14 Sep 2026 — if the voice
platform already writes prompts, why run a second LLM? Rejected on four counts, in order of how
fatal they are:

1. **It is not callable.** Conductor is a dashboard feature: open an agent, click the sparkle icon,
   chat. There is no `conductor` resource in the Retell SDK — the top-level resources are Call,
   Chat, PhoneNumber, Agent, ChatAgent, Llm, ConversationFlow, KnowledgeBase, Voice, Asset,
   Concurrency, Identity, ExportRequest, BatchCall, Tests, Playground, McpTool, Contact, App, CRM.
   The docs sit under Guides, not under API Reference. `POST /agents/:id/generate` would have
   nothing to call. Their MCP server wraps the same public endpoints (create agent, launch call,
   update number) and does not generate prompts either; it is developer tooling for Cursor and
   Claude Code, not a production dependency.
2. **The quota is roughly two orders of magnitude too small.** 30 messages per person per day and
   **200 per organisation per day**, shared, resetting at midnight Pacific. Every customer pressing
   Generate in W2 draws from that one pool. Turning on pay-as-you-go would make per-generation COGS
   a function of a vendor's UI quota with no pricing contract behind it.
3. **It is human-in-the-loop by design.** Retell's stated golden rule is that Conductor never
   changes an existing agent on its own — it proposes a before/after diff and waits for approval.
   Our generation path is a background job returning `202 {job_id}`; there is no human in it.
4. **It inverts the version model (§9).** Conductor edits the agent *inside Retell*. Our model is
   the opposite: `agent_versions` is immutable and authoritative, and the Retell agent is a
   projection pushed on publish. Letting Retell author prompts would make Retell the source of
   truth and put drafts on live numbers. It would also be the one integration with no interface to
   hide behind, against the isolation rule that governs both `RetellGateway` and
   `modules/prompting/providers/`.

Worth using **by hand** during the D2 benchmark as a third sample — if its prompts are better, copy
what it does differently (system prompt structure, guardrail phrasing, analysis-field defaults) into
our generator. Reference, not dependency.

## Consequences

- `ANTHROPIC_API_KEY` is gone from `.env.example`; `OPENAI_API_KEY` and `GENERATION_MODEL=gpt-5`
  replace it, plus an optional `OPENAI_ORG_ID`. `pnpm doctor` checks the new key.
- The D1 account checklist now provisions OpenAI rather than Anthropic.
- **Prompt caching works differently and the design should not assume otherwise.** Anthropic takes
  explicit `cache_control` breakpoints; OpenAI caches long stable prefixes automatically with no
  placement control. The practical rule is unchanged — keep the system prompt and the §9.4
  guardrails first and the volatile `brief_json` last — but there is no breakpoint to place.
- Structured output is available on both, so the zod schema in `@portal/schemas` stays the contract
  either way and the D5 exit check ("generate returns zod-valid JSON") is unaffected.
- **Build the provider behind an interface on D5.** This decision was made without data, and the
  cheapest way to keep it honest is to make it reversible: `modules/prompting/providers/` with a
  `generate(brief) → GeneratedPrompt` interface, the same way `RetellGateway` isolates Retell. One
  file changes if this is revisited.
- **Benchmark it on D2, alongside the in-call LLM benchmark that is already planned.** Same
  receptionist brief, both providers, compare the generated prompts. An hour of work that either
  confirms this ADR with evidence or produces ADR 0008. Until then this row of the stack rests on
  judgement, and the document should say so — it does.
