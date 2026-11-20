# ADR 0012 — The prompting pipeline and the agent lifecycle (D5)

- Status: accepted
- Date: 2026-09-16
- Deciders: Saksham
- Scope: §9 (prompt system), §13.2 (sign-up and workspace creation), §13.3 (generate),
  §13.5 (feedback patch), §13.6 (publish), and the parts of §16 those four touch.
- Builds on: [ADR 0003](0003-retell-findings.md) §7 (Retell version model),
  [ADR 0006](0006-tenancy-rls-and-append-only.md) (two roles, RLS),
  [ADR 0009](0009-llm-provider-anthropic.md) (Anthropic, `claude-sonnet-5`, the provider
  interface), [ADR 0011](0011-call-runtime-and-queues.md) (queues and the hand-off pattern).

## Context

D5 turns a brief into a live agent. The spec describes it as a pipeline (§9.3) and a set
of routes (§16), and most of it is not controversial. What needed deciding is the handful
of places where "how the spec describes it" and "what is actually safe" are not the same
sentence, and every one of them is about something that must hold when a step fails, runs
twice, or runs at the same time as itself.

Seven decisions follow. Each names the failure it exists to prevent, because in six months
that is the only thing that will explain the shape of the code.

## Decision

### 1. Platform guardrails are appended by the worker, after the zod parse

§9.4 says the guardrails are "appended, non-editable". They are appended in
`modules/prompting/guardrails.ts`, after the model's answer has passed
`generatedPrompt.safeParse`, and never asked of the model.

Three properties, each a line of code rather than a promise:

- The model cannot lose them. It writes the business prompt; the block is attached
  afterwards. ADR 0009's argument for the smaller model rests entirely on this.
- No request can remove them. `promptUpdate` — the Advanced editor's body — has no field
  for them, and `applyGuardrails` strips whatever block the submitted text contains before
  appending the canonical one. Delete, reword, invert, or smuggle a second copy into the
  middle of the prompt: all four produce the same stored prompt.
- They are re-applied on the way out. `AgentRetellService` runs `applyGuardrails` again
  when it builds the Retell LLM spec, so a row written by an older build still reaches the
  phone with them attached. The function is idempotent, so this costs nothing.

**Rejected:** asking the model to reproduce them and linting the result. That makes a
safety property depend on an LLM following an instruction, and the lint would then be the
only thing standing between a prompt injection and an agent that claims to be human.

### 2. `agent_versions` immutability is a database trigger, with one carve-out

§9.9 says every generation or edit creates an immutable version. §W2 says the brief
autosaves into "the current draft version" every 1.5 seconds. Both are true, and the line
between them is drawn in `app.reject_agent_version_rewrite()` rather than in a service:

- a published version is frozen, forever;
- a version with a successor is frozen — so re-selecting an old version as the draft
  (§13.5 Undo) cannot reopen it for editing;
- the newest unpublished version is the draft and may be rewritten until either of the
  above becomes true.

Four columns stay writable in every state because they record what happened *to* a version
rather than what it says: `published_at`, `retell_agent_version`, `lint_json`,
`stack_version`. Identity — `agent_id`, `version_no`, `source`, `created_at` — never moves,
and rows are never deleted.

`AgentsService.patchDraft` knows the same rule and forks a new version rather than letting
the database refuse it, so the trigger fires only on a bug.

**Rejected:** keeping a mutable "working brief" on `agents` and materialising versions only
on generate. Cleaner in theory; it splits the brief across two tables and makes "what was
this version generated from" unanswerable.

### 3. Publishing is serialised by a leased claim, not by a lock or a transaction

Publishing is four Retell calls and then a write. It cannot be one transaction — no network
I/O inside `withWorkspace` — so exclusion has to outlive the transaction.
`agents.publishing_since` is a lease taken with one conditional `UPDATE`, released in a
`finally`, and expiring after two minutes so a worker that dies mid-publish does not leave
an agent unpublishable.

The state is re-read **after** the claim. A duplicate request that arrives moments after the
first one committed would otherwise branch and publish a second Retell version for a version
that is already live; the double check turns that into `already_published: true`.

**Rejected:** a Redis key. Redis is allowed to be down (ADR 0003 §12), and "Redis is down"
must not read as "someone else is publishing" and block every customer's publish.
**Rejected:** a Postgres advisory lock. Session-scoped would pin a pooled connection across
the Retell calls; transaction-scoped dies with the transaction that cannot span them.

### 4. Publishing does not un-pause

A publish of a paused agent records the version and leaves the agent paused. Putting an
agent back on the phone is `POST /agents/:id/resume`, an explicit act. The alternative —
"publish means live" — would silently re-answer calls a customer deliberately stopped.

### 5. Duplicate generations are prevented by a partial unique index

W2 shows a ten-second progress bar, so a second click on "Generate" is normal input, not an
edge case. The route answers it with the in-flight job's id. The guarantee underneath is
`jobs_one_active_per_target_idx`, a unique index on
`(steps_json->>'agent_id', type) WHERE status IN ('queued','running')`: two requests racing
collide in Postgres and the loser reads back the winner's id, rather than both passing a
`findActive` read and both paying for a generation.

The deterministic BullMQ id (`gen-<jobs.id>`) is the queue-side half, as in ADR 0011 §3.

### 6. Generation gets its own queue, and its own retry budget

A fourth BullMQ queue, `prompting`, concurrency 4. A generation is an LLM round trip —
seconds, not milliseconds — and on the `calls` queue a slow model would delay the
write-behind and the webhooks that move credits.

Three attempts, not the default eight: a customer is watching the button, and a version
that appears five minutes later is worse than a failure with a "try again". A provider
failure that is *not* transient — a malformed answer, a refusal, a missing key — is not
retried at all; a model that returns unparseable JSON twice will not fix itself on the
eighth attempt.

A job that has already written its version records the number in `steps_json` and a retry
resumes at the Retell sync, so a crash between the insert and the sync cannot produce two
versions or two charges.

### 7. The Retell draft sync during generation is best-effort

§13.3 step 6 pushes the generated draft to Retell so W5 has something to ring. It runs after
the version is stored and its failure is recorded on the job rather than failing it:
publishing re-syncs from the local row anyway (§13.6), so a Retell outage during generation
costs a test call, not the customer's work.

Postgres stays the source of truth and Retell stays a projection of it (architecture §8).

## Consequences

- **A fourth queue.** `SCHEDULES`, the worker startup line and `jobs.test.ts` all name it;
  CLAUDE.md's queue list is updated.
- **Two new database constraints and one new column set**, in
  `20260916120000_d5_agents_and_membership` and `20260916150000_d5_one_active_job_per_agent`:
  `agents.deleted_at`, `agents.publishing_since`, the version-immutability trigger, one
  owner per workspace, one pending invite per email, one active job per agent.
- **`WalletService.withWalletTx`.** §13.2 wants the trial grant inside the same transaction
  as the workspace, and the wallet is still the only code that writes `credit_ledger`. The
  variant takes a transaction the caller owns, still takes the per-workspace lock, still
  publishes `bal:{ws}` in commit order, and hands the writes back so the caller fires the
  listeners after it commits.
- **`agent_stack_configs` is now read.** Tier stacks, the §9.4 guardrail text, the §9.5 lint
  severities and the §9.3 prompts come from version 1, seeded by `pnpm db:seed`, cached at
  `stack:current` for 60 s. Every one of them degrades to a compiled-in default: an empty or
  malformed row must never mean "append no guardrails".
- **A scripted prompt provider.** `GENERATION_PROVIDER=scripted` answers from canned text so
  the pipeline is testable without a key and `pnpm dev` works on a machine without one. It is
  refused when `APP_ENV=prod`, where a silently fake agent would be far worse than a failed job.
- **The e2e suites now run one file at a time.** They share the global configuration tables
  and the `flags:*` cache, and a suite that flips a kill switch was invalidating another
  suite's assertion once in every ten runs.
- **The auth webhook follows the Action that shipped with D1**, not a new contract:
  `x-action-secret`, `AUTH0_CUSTOMER_ACTION_SECRET`, and the flat payload in
  `infra/auth0/actions/customer-post-registration.js`. `user.login` is accepted as well as
  `user.registered` because the Post-Login Action is the documented safety net for a
  registration webhook that never arrived.

## Amendments — 17 Sep 2026 (D5 review)

A review of the D5 implementation found ten defects. The fixes that change a decision
above, or add one, are recorded here; the migration is `20260917090000_d5_review_fixes`.

1. **Settings travel with the version (§2 amended).** `agent_versions.settings_json` holds
   tier, voice, languages, the duration ceiling and recording (`agentSettings`). It is part
   of the frozen content tuple. The columns on `agents` are the *live* copy: the billing
   rate and `num:{e164}` derive from them, and only a publish writes them — in the same
   transaction as `published_version`, then `runtime-cache.refresh`. Before this, the D3
   Voice tab wrote tier straight onto `agents`, so a draft flip re-priced a live agent while
   Retell kept running the old stack. **Rejected:** a second set of "draft" columns on
   `agents` — the settings are what a version *is*, and belong under the same trigger as
   the brief.
2. **Lost jobs are reconciled (§5 amended).** The one-active-job index has a failure mode:
   a row a dead worker left `running` is joined forever. `JobRecordsService.reconcileStale`
   (the new `job-sweeper` schedule) and `reconcileIfLost` (the join path) ask BullMQ what
   holds the deterministic id and write the row off only when the queue says `missing`,
   `failed` or `completed`; `waiting`, `delayed`, `active` and `unknown` are left alone.
   **Rejected:** a timestamp heuristic alone — a stopped worker leaves old rows that are
   perfectly alive in the queue.
3. **`GET /jobs/:id` is a whitelist.** `jobProgress` is built field by field from
   `steps_json`; `steps_json` and `jobs.error` never leave the server. The worker writes
   the customer-facing sentence separately as `steps_json.customer_reason`.
   `retell_agent_version` left `agentVersionDetail` and `publishResponse`;
   `DELETE /agents/:id` answers `{deleted}` and audits the cleanup errors instead of
   returning them.
4. **Provisioning has a real fallback (Consequences amended).** The customer Post-Login
   Action now actually posts `user.login` to `POST /webhooks/auth`, and stamps
   `https://portal/email` / `https://portal/name` on the access token. `AuthGuard`
   provisions a `users` row from those claims when a verified token has none —
   through the same idempotent upsert, so a burst of first requests makes one row.
   `UsersService` moved to `auth` for that reason. A bare `email` claim is never trusted.
5. **The lease is a token (§3 amended).** `claimLease` returns the timestamp it wrote and
   `releaseLease` is conditional on it, so a publish that overran two minutes cannot clear
   the lease a later publisher took over.
6. **Paused workspaces are refused by generate and feedback**, at the route and again in
   the worker (`JobRefusal`), so a paused tenant cannot spend the provider budget.
7. **`created_by` left the frozen tuple (§2 amended).** Its `ON DELETE SET NULL` fired the
   trigger and made every `DELETE FROM users` fail once the user had authored a frozen
   version. It is bookkeeping, like `published_at`.
8. **No compiled-in tier stack.** `AgentRetellService.syncDraft` requires a `TierStack`;
   publish answers `503 NOT_CONFIGURED` when the SA6 row is missing or malformed and the
   worker records `retell_sync: skipped`. Guardrails, lint and prompts still degrade to
   compiled-in defaults — those are safety, the stack is billing.
9. `toVersionDetail` no longer takes a guardrails argument, and `GET /agents/:id` /
   `GET /agents/:id/versions/:v` no longer read `stack:current`.
10. **One template loader.** `templatesDir`, `readTemplateFiles`, `templateRowFrom` and
    `templateFromRow` live in `@portal/db`; the seed and `TemplatesService` both use them,
    and a file that fails the schema fails the seed.

## Measured against the real model

`pnpm --filter @portal/api bench:generation` runs the five briefs ADR 0009 asked for
against `claude-sonnet-5` and reports its five metrics. It costs about 3¢ a generation, so
it is a script you run on purpose, never part of `pnpm test`. Run on 16 Sep 2026:

| Metric | Result |
| --- | --- |
| zod-valid first try | **5/5** |
| §9.4 guardrails present after the append | **5/5** |
| §9.5 lint publishable | **5/5** (after the rule fix below) |
| p50 / p95 latency | **16.7 s / 17.4 s** |
| guardrail-conflicting feedback | **refused correctly** — `changes: []` plus "I can't have the agent claim to be human when asked; platform rules require it to disclose it's an AI assistant", and the stored prompt is the one the customer already had, guardrails intact |

**Four things only a real call could find**, every one of which would have shipped broken:

1. **`maxItems` is rejected** in `output_config.format.schema` — a 400 on the whole
   request, so *no generation would ever have succeeded*. The bounds moved to zod, which is
   where the contract lives anyway.
2. **`additionalProperties: true` is rejected** — the same 400, on the feedback path only,
   so *every §9.6 patch would have failed*. `updated_brief` is now a closed object naming
   the eight fields spoken feedback actually changes.
3. **A refusal carries no `updated_prompt`.** §9.6's own success case — "changes: [] plus an
   explanation" — was being rejected by our schema as invalid output, turning the model
   doing exactly the right thing into a failed job. `updated_prompt` is now optional and
   required only when `changes` is non-empty.
4. **A non-streaming request with adaptive thinking hung for minutes** without the
   per-request timeout firing. The provider streams and owns its deadline with an
   AbortController.

The scripted provider cannot find any of these, because it never speaks to the endpoint.
That is the argument for keeping this script and running it whenever the request shape
changes — and the reason `output-schema.test.ts` now asserts that `maxItems` and
`additionalProperties: true` never come back.

**The §9.5 `absolute_language` rule was too eager** and fired on three prompts in five —
every one a false positive:

- "Never confirm availability as guaranteed" and "Never promise a callback time": the
  customer's own rules, and two of our own templates', echoed into the prompt because we
  asked for them, and read as over-promising. Exactly backwards.
- "Always confirm the appointment details back to the caller": ordinary good advice,
  flagged because `appointment` was in the pricing word list.
- "Promise a clear next step before ending the call.", flagged because "Never quote final
  pricing" happened to sit two lines below it — inside a ±90-character window that had
  nothing to do with the sentence.

The unit is now a **sentence**: the pricing word must sit in the same sentence as the
absolute word, and a negation earlier in that sentence disqualifies it. Re-run against the
real model: 5/5 clean. Every sentence above is a unit test, so the rule cannot quietly
regress to the version that cried wolf.

### The one exit criterion that does not pass

**p95 is 15–17 s against a target of ≤ 10 s**, and this is a real miss, not a measurement
artefact. _Superseded in part by "Measured again, with the pipeline instrumented (21 Sep
2026)" below, which has the per-stage numbers and the changes they justified._ What was
tried on 16 Sep:

- `output_config.effort: low` — now the default, because depth buys nothing on
  well-specified structured drafting.
- `thinking: off` (`GENERATION_THINKING=off`) — **15.9 s versus 16.7 s**. Under a second.
  Thinking is not the cost.

The cost is output length: ~2,100 characters of prompt plus a greeting, a closing, a brief
card, six to twelve analysis fields and scenarios — roughly 1,200–1,600 output tokens, at
Sonnet's throughput. Nothing about that is fixable by configuration, and it should not be
"fixed" by cutting validation or by dropping the scenarios §9.3 asks for.

So the number is reported rather than engineered around, and the decision belongs to the
owner. The options, in the order I would take them:

1. **Accept it.** The route already returns `202` in under 250 ms and the wizard shows a
   three-stage progress bar over SSE, so what the customer experiences is a progress bar
   for fifteen seconds rather than a frozen button. §9.3's own step 7 contemplates jobs
   over 15 s.
2. **Benchmark `claude-opus-5` and Haiku 4.5** — one env var each, which is what the
   provider seam is for. Faster is not obviously better here; the prompt is the product.
3. **Shrink the envelope** — generate scenarios lazily, or on demand in W5. That is a spec
   change (§9.3 step 3 lists them in the one response) and needs the owner's word.

`GENERATION_TIMEOUT_MS` is 45 s rather than the 20 s §9.3 step 7 names, for the same
reason: a 20 s budget against a 15 s p50 would abort and retry roughly half of all
generations, doubling the cost and the wait to save nothing.

## Measured against the real Retell API (17 Sep 2026)

`pnpm --filter @portal/api verify:d5-retell` sends the **D5 publish payload** to the dev
Retell workspace through `AgentRetellService`, not the gateway, so what is exercised is the
path publish takes. It creates one agent and one LLM and deletes them again; no number is
bought, so it costs nothing. Fixtures land in `test/fixtures/retell/api/d5-*.json`.

It was written because D2 verified a *hand-written* payload and D5 sends a different one,
and because `FakeRetellGateway` cannot validate a payload by design. Four findings, all of
which were live in the code:

1. **`update-retell-llm` before `create-agent-version` is a 400.** Every republish of a
   published agent failed. ADR 0003 §7 had the right order written down and the
   implementation had two of the steps swapped. Fixed, and the order is now asserted in
   `agent-retell.test.ts` and in the publish e2e.
2. **`language: "multi"` is not "the languages this agent speaks".** Retell expands it to a
   fixed ten — en-US, es-ES, fr-FR, de-DE, hi-IN, ru-RU, pt-PT, ja-JP, it-IT, nl-NL — which
   does **not** contain fr-CA. A Quebec customer choosing fr-CA plus English got an agent
   that could not speak their primary language and could speak nine they never chose. W3's
   wording ("if ≥ 1 also-speaks → Retell language: multi") was written without that. The
   gateway now sends the explicit array, which D2 had already proved Retell stores verbatim.
   **This deviates from the §W3 text and wants the owner's sign-off.**
3. **An unknown `voice_model` is ignored in silence.** Every other id in the tier stack
   fails loudly — an unknown LLM model is a 400 listing the allowed values, an unknown voice
   is a 400 — but `voice_model` is not validated by Retell. The seeded Premium stack asked
   for `eleven_turbo_v2_5`, which is not a Retell TTS model, so **Premium ran the Standard
   tier's `eleven_flash_v2_5` while billing 1.5×**. Only the Standard stack was ever D2
   -verified; Premium was assumed. `tierStack.voice_model` is now a zod enum checked against
   the SDK union at compile time, and the seed uses `eleven_multilingual_v2`.
4. **`choices: []` is a 400**, exactly as the SDK documents: `Enum bad_field must have at
   least 1 choice.` This is the live confirmation for the §9.8 change above — before it,
   `choices: field.enum ?? []` manufactured that array whenever the model omitted the
   choices, and an `as unknown as` cast hid the shape from the compiler.

Verified as stored by Retell, on one agent: the analysis schema across all four §9.8 types,
the explicit locale array, voice id, voice model, voice speed and temperature, duration
ceiling, denoising mode, STT mode, post-call-analysis model, timezone, our webhook URL,
publish, branch-after-publish, and on the LLM object the transfer tools and the §9.7 dynamic
variables.

**Still not verified against the real API:** knowledge-base binding on an agent (D6 owns
it), and `voice_speed` / `voice_temperature` have been *accepted and stored* but never heard
on a call.

### Two things the payload accepts that Retell will not

- **Transfer numbers are validated semantically.** `+15551230001` passes our `e164` regex
  and comes back `400 The number provided … is not a valid number`. A customer can therefore
  save a handoff rule that only fails at publish. Replicating libphonenumber inside
  `@portal/schemas` conflicts with its zod-only dependency rule, so this is left as an owner
  decision rather than fixed here. The example in `common.ts` was itself a 555 number.
- **`en-CA` is not a Retell locale** (only en-US, en-IN, en-GB, en-AU, en-NZ). It was used
  in the e2e suite, a D5 fixture and the benchmark cases, which is how much the old
  `z.string().min(2).max(10)` was hiding.

## The model benchmark ADR 0009 left open (17 Sep 2026)

Five briefs each, same envelope, `bench:generation`.

| Model | zod valid | p50 | p95 | output tokens | $ / generation |
| --- | --- | --- | --- | --- | --- |
| `claude-sonnet-5` (current) | 5/5 | 15.5 s | 17.1 s | 1 566 | $0.021 |
| `claude-haiku-4-5-20251001` | 5/5 | 12.3 s | 19.7 s | 1 230 | $0.008 |
| `claude-opus-5` | 5/5 | 27.8 s | 28.3 s | 2 202 | $0.067 |

All three keep the §9.4 guardrails and pass the §9.5 lint 5/5. **None of them meets the
p95 ≤ 10 s exit check**, and latency tracks output length almost exactly across all three,
which is the same conclusion the Sonnet-only run reached: the envelope is the cost, so the
target is not reachable by swapping models. The decision stays where it was — accept the
number, or shrink what §9.3 asks for — and it stays the owner's.

Sonnet is kept. Haiku is 2.6× cheaper and quicker at the median but worse at p95 and
visibly thinner (1 409 characters against 2 073 on the same restaurant brief), and the
prompt is the product. Opus costs 3× and takes 28 s for output that is longer rather than
obviously better.

Two notes for whoever runs this next. Haiku 4.5 supports **neither** adaptive thinking nor
the `effort` parameter, so "swap one env var" was not true; `GENERATION_EFFORT=none` now
omits the parameter, and that plus `GENERATION_THINKING=off` is what Haiku needs. And the
benchmark now reports tokens and an approximate cost, which it did not before.

## Measured again, with the pipeline instrumented (21 Sep 2026)

The owner's decision on the 10 s p95 was still pending on 21 Sep, so the question was
narrowed to what could be optimised with evidence. The worker now times every stage of
§13.3 step 2 into `jobs.steps_json` — `queue_latency_ms`, `context_ms`, `prompt_build_ms`,
`provider_ttft_ms`, `provider_thinking_ms`, `provider_latency_ms`, `postprocess_ms`,
`db_ms`, `sse_ms`, `retell_sync_ms`, `total_ms`, `usage`, `output_chars` — and
`bench:generation` reports time to first token, thinking time, tokens and the output share
by section. Same five briefs, `claude-sonnet-5`, effort `low`.

### Where the time went

| Stage | Measured |
| --- | --- |
| queue wait (route → worker) | 4 ms |
| context: stack, tenant, draft reads | 14 ms |
| prompt construction | < 1 ms |
| model: time to first token | 1.5–5.0 s, p50 2.0 s |
| model: thinking | **0 ms** — adaptive at effort `low` emits no thinking block |
| model: streaming the answer | 14–16 s: ~1,600 output tokens at ≈ 100 tokens/s |
| zod, guardrails, lint | 1 ms |
| version insert | 12 ms |
| SSE publish | 7 ms |
| Retell draft sync, real dev workspace | 1.5 s (create), 1.9 s (branch after a publish) |
| **everything that is ours, model excluded** | **63 ms** |

Output by section (baseline): prompt 48 % · analysis_fields 18 % · brief_card 13 % ·
scenarios 10 % · warnings 6 % · greeting + closing 4 %. Input 2,400 tokens.

Ruled out by the numbers: the queue, the database, validation and SSE (63 ms together);
thinking (0 ms — and `thinking: {type: 'disabled'}` measured p95 19.2 s against 18.4 s,
noise); input size (prefill of 2.4k tokens is not where a 2 s first token comes from);
retries (`provider_attempts` was 1 in every run); model choice (17 Sep table above). The
17 Sep "thinking off" comparison was itself wrong: it omitted the `thinking` parameter,
and on this model family an absent parameter *runs adaptive*. `GENERATION_THINKING=off`
now sends `disabled`.

What was being wasted: **the analysis fields.** The worker merges the template's fields
first and drops duplicates, so the seven to ten fields the model re-typed per generation
were thrown away — 18 % of the output tokens on a path whose latency is output tokens.
The warnings were paragraphs and the brief card ran long.

### What changed

1. **Ask only for additional analysis fields**, and steer the brief card (three to five
   lines a column) and the warnings (at most three clauses) in the schema descriptions.
   The zod bounds are unchanged: gates, not targets. Nothing §9.3 asks for was removed.
2. **The `generated` frame is published before the Retell draft sync.** The sync is
   1.5–1.9 s of Retell round trips that W5 needs several screens later and publish redoes
   anyway; the job still succeeds only after it, so `GET /jobs/:id` is unchanged.
3. **`generation_progress {stage: 'writing'}`** is published when the first token arrives,
   so W2's bar has one honest point to move at between "started" and "done".

| Run (n = 5) | p50 | p95 | out tokens | $ / generation |
| --- | --- | --- | --- | --- |
| baseline, 21 Sep | 18.2 s | 18.4 s | 1,611 | $0.0209 |
| `thinking: disabled` | 17.9 s | 19.2 s | 1,634 | $0.0211 |
| **trimmed envelope (shipped)** | **14.7 s** | **15.5 s** | **1,325** | **$0.0182** |
| two concurrent half-envelope calls (`--split`, not shipped) | 9.8 s | 10.6 s | 1,455 | $0.0226 |

All four: 5/5 zod-valid first try, 5/5 guardrails, 5/5 lint-publishable.

### The concurrency experiment

`bench:generation --split` runs two calls at once — the *agent* (prompt, greeting,
closing) and the *summary* (brief card, extra analysis fields, scenarios, warnings) —
merges them and passes the merge through the same `generatedPrompt` gate. Three of five
finished under 10 s. The agent half was the long one every time (8.6–10.6 s): the prompt
itself, ~2,100 characters and 700–800 tokens as escaped JSON, is the floor at this
throughput, and time to first token sits on top of it. Input tokens go from 2.5k to 4.0k
(+24 % per generation). It is **not wired into the worker**: it still misses the target,
and the summary half describes an agent whose prompt it has not read — whether the brief
card can drift from the prompt is a question for a person reading outputs, not for zod.
It also filled the room it was given (six scenarios every run against four or five).

### Verdict

With the §9.3 envelope as specified, **p95 ≤ 10 s is not reachable on `claude-sonnet-5`
with one call.** The floor is time to first token (1.5–5 s) plus streaming the prompt
alone (7–8 s). The shipped trims are worth 3 s and cost nothing; the SSE reorder is worth
another 1.5–1.9 s of what the customer sees. The remaining choice is the owner's, in the
order I would take it:

1. **Accept ≈ 15 s p95.** The route answers 202 in under 250 ms, the bar now moves at the
   first token, and nothing is blocked on it.
2. **Build the split**: ≈ 10–11 s p95 for +24 % cost, after someone has read a dozen
   split outputs for coherence between card and prompt.
3. **Shrink the prompt envelope** — a change to §9.3 / Appendix B, not to code.
4. **Fast mode on `claude-opus-5`** (≈ 2.5× output speed) — a model change at roughly five
   times the cost per generation; not measured, listed for completeness.

## Addendum — the closing line (26 Oct 2026)

**Problem.** A staging restaurant agent said "Thank you for calling Spice Garden
Restaurant" straight after a reservation read-back and after an answer about parking,
while the caller still had questions. The call stayed up; the caller had to interrupt.

**Cause.** Everything that told the model how a call ends put the goodbye right after the
read-back, and nothing tied it to the caller: all seven templates ended `… confirm the
details back` → `Close politely`; Appendix B's step 4 said "confirm … before ending" and its
`## Ending` was a bare `{closing_line}`; §9.4's sixth rule reads "Confirm captured details
back to the caller. End the call when the caller is done."; the `end_call` tool said "when
the conversation is over". The Standard model wrote and then followed exactly that.

**Decision.** Four changes, prompt and configuration only — the call lifecycle is untouched:

1. `CLOSING_RULE` in `FIXED_PLATFORM_GUARDRAILS` — appended whatever the stack row says, so
   it reaches a live agent whose stored script still has the old ending at its next sync
   (draft sync or publish), without a regenerate and without a new stack version. It is not
   §9.4 text; it sits beside the spec's seven rules, which stay verbatim.
2. `closingSection()` in the generation user turn, in code beside `identitySection()`,
   because the skeleton is `agent_stack_configs` data and staging serves v1. It tells the
   model to write the confirm step as "then ask whether there is anything else" and the
   `## Ending` as condition + line + hang-up. The compiled-in skeleton says the same.
3. Every template's last step is now two: ask whether there is anything else, and only
   once there is nothing else, thank the caller and end the call (template `version` + 1;
   `pnpm db:seed` upserts the rows).
4. The `end_call` tool description: end the call once the caller has said they need
   nothing else, goodbye and hang-up in the same turn, never after an ordinary answer.

**Measured.** Text conversations against the dev platform workspace on the Standard model,
the same LLM object a voice agent gets (prompt, greeting, `end_call` and transfer tools),
through a chat agent so a script could hold the turns. Seven scenarios (hours, parking,
reservation, several questions, a question after "anything else?", explicit goodbye, an
ambiguous "Okay."), a Spice Garden brief, scripts from the real generator:

| Variant                                   | Premature closing line | Premature hang-up |
| ----------------------------------------- | ---------------------- | ----------------- |
| Before (old script, v1 rules)             | 24 / 28                | 0                 |
| Existing agent, re-synced (old script)    | 8 / 46                 | 0                 |
| Regenerated (new script)                  | 2 / 74                 | 0                 |

Both remaining regenerated misses are the ambiguous "Okay." after "anything else?". On an
explicit goodbye the new scripts say the line every time but call `end_call` in that turn
only about 60 % of the time (before: 4 / 4, because the old script said goodbye eagerly);
otherwise the caller hangs up, as callers do after "bye". Naming `end_call` in the rule
raised that to 15 / 16 but made agents on old scripts call it mid-booking — 5 / 24
conversations hung up on the caller — so the rule does not name it.

**Consequences.** An existing agent improves at its next sync; the full fix is a regenerate
(W2 Generate, or D3). Staging's `agent_stack_configs` v1 still carries the old skeleton;
`closingSection()` overrides it in the user turn, and a v2 row is not required.

## Addendum — staff transfers and category answers (26 Oct 2026, BUG-005, BUG-007)

**Transfers.** An agent read the staff transfer number aloud when it offered a transfer, and
again on the retry. The number reached the model by three routes: `briefForModel`
(`→ transfer to +1…`), the skeleton's `{transfer_targets}`, and the `transfer_call` tool
description (`Transfer the caller to +1…`). The number now goes only where the platform
dials it: the tool's `transfer_destination` and the §9.7 `transfer_number_N` variables.
What the model reads instead:

- `briefForModel` says `→ offer to transfer the caller to our staff`, and `transferSection()`
  in the generation and feedback turns (only when a transfer rule exists) says to fill
  `{transfer_targets}` with a label, never digits, and to word it as an offer.
- `transferCallTools()` (gateway) describes each tool by the brief's conditions for that
  number (`transferRoutes()`), with the offer wording, "never say the number", and what
  to say when it does not go through.
- `redactTransferNumbers()` runs on the script (`runtimePrompt`) and the greeting
  (`llmSpec`) at the platform boundary. It replaces the number in any common written
  form, and `{{transfer_number_N}}`, with "our staff". A script stored before this fix
  reaches the phone without the number, with no regenerate. Business documents are the
  business's own words and are not touched.
- `TRANSFER_RULE` joins `FIXED_PLATFORM_GUARDRAILS`. It is conditional ("when a hand-off
  rule says to transfer"), so an agent with no transfer never offers one. `lint`'s
  `handoff_rule_missing` now reads the script without the platform block, because the
  rule says "transfer" for every agent.

**Category answers.** Asked for vegetarian dishes, an agent read the whole menu with its
prices, drinks included. `LIST_RULE` (fixed) asks for three or four fitting items, then an
offer of more; the full list only when the caller asks for it; no other categories mixed
in; a price only when asked or when it helps the caller choose. `MENU_LISTING_RULES` say
the same in the generation turn for a menu source or a W2 document. The restaurant
template gained a matching step. These rules are wording only and do not trim the menu
data the agent can draw on.

**Not measured.** Unlike the closing line, these wordings have not been run against the
real model on dev. `bench:generation` and a text chat with a transfer rule and a menu are
the check.

## What is deliberately still open

- **Voice preview is the provider's sample clip**, not the customer's greeting spoken aloud.
  W3's copy allows either ("TTS sample via Retell (if available) or cached provider
  preview"); synthesis is Phase 2, and `VoicePreviewResponse.kind` already distinguishes them.
- **The preview rate limit is read-then-write**, so a simultaneous burst can slip one or two
  over ten a minute. `RedisCache` has no INCR and the resource is a static URL from our own
  table; exactness here would buy nothing.
- **`claude-opus-5` has not been benchmarked yet.** ADR 0009 kept that comparison open and
  it stays open; `--model claude-opus-5` on the script above is the whole change.
- **`GET /voices` filters languages in the API**, not in Postgres: prefix matching in both
  directions (`fr` finds `fr-CA`, `en-US` finds `en`) is not expressible as a Prisma filter
  on a string array, and the catalogue is three hundred rows.
