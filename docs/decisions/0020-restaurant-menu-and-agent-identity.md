# 0020 — The restaurant menu as a knowledge role, the business category on every screen, and the agent's identity

Date: 25 Sep 2026. Status: accepted. Builds on ADR 0012 (prompting pipeline), ADR 0013
(knowledge, `knowledge_sources`), ADR 0003 §8–§9 (knowledge ingestion, voice samples) and
ADR 0017/0018 (portal). Spec: §9.2 (templates), §9.3–§9.5 (prompt, guardrails, lint), §11
(knowledge), W1/W2/W4, D3.

## Context

Three findings from a design-partner test run on 25 Sep 2026:

1. A workspace named "Bright Dental" was built on the Restaurant template. The choice was
   stored (`agents.template_id`) and shown in D3, but the wizard itself never said which
   template the agent was being built from, W2's placeholder copy was the dental example
   for every template, and W1 accepted any industry against any template in silence.
2. A restaurant has a menu, and the menu is what most callers ask about. W4 could ingest
   one as an ordinary source, but nothing labelled it, nothing kept it to one, and the
   generated prompt never told the agent what to do with it — so a model that was never
   asked to "answer from the menu and say when a dish is not on it" did not.
3. A tester heard an agent introduce itself as being "from Retail AI". There is no such
   string in the repo. Two paths lead to it: the voice catalogue's own preview clips say
   "I'm … from Retell AI" out loud and were allowed by default everywhere but prod
   (staging included), and the generation prompt stated the business name once in a
   settings line and never forbade the model from naming anyone else.

## Decisions

### 1. The category is `agents.template_id` + `agents.industry`, shown wherever the agent is edited

Nothing new is stored. What changed is that the category is *visible* and *consistent*:

- `GET /templates` now carries `example_texts`, so W2 and the D3 Brief tab show the
  template's own example for the agent's industry as the "About your business"
  placeholder (`exampleTextFor()` in `src/wizard/template-fit.ts`), plus restaurant copy
  for goal, services and pricing when the template is `restaurant`.
- `AgentContextBanner` ("Building a Restaurant agent for Bright Dental.") sits under the
  W2 and W4 headings; `TemplateBadge` sits in the D3 header next to tier and status. Both
  read `agentSummary`, so a reload or a round trip to another step cannot lose it.
- W1 warns — never refuses — when the chosen industry is not one the template was written
  for (`industryConflicts()`), and names the templates that do fit. A `generic` tag fits
  anything; an empty industry conflicts with nothing. **The workspace name is never
  read**: "Bright Dental" may well be a bistro, and a name heuristic would be wrong exactly
  when it is confident.
- `agents.industry` now reaches the generation prompt (`- Industry: restaurant`).

### 2. The menu is a knowledge source with a role, not a second upload path

`knowledge_sources.role` (`knowledge_role` enum, `menu` only for now, NULL for an
ordinary source) and a partial unique index `knowledge_sources_agent_role_idx (agent_id,
role) WHERE role IS NOT NULL AND status <> 'deleting'` — one menu per agent, enforced by
the database, with a replace that removes the old row first (the platform copy goes
first, as for any source) and a race answered `409 CONFLICT` rather than a second menu.
Everything else is the existing pipeline: the same `POST /agents/:id/knowledge` body with
`role: 'menu'`, the same 20 MB / PDF-Word-text-CSV validation, the same `knowledge-sync`
job, the same one knowledge base per agent on the platform, the same `deleting` path. A
menu counts toward the 20-source limit and the plan's knowledge allowance like any source.

Who may hold one is `knowledgeRolesFor()` in `@portal/schemas`: the Restaurant template,
or any template the customer tagged `restaurant` on W1. The API refuses `role: menu` on
any other agent (`400`, field `role`), and the portal shows the Menu section from the
same predicate, so the two cannot disagree. `MenuUpload` (W4 and the D3 Knowledge tab)
is the labelled slot: current file, status, size, error; upload / replace / remove with a
progress bar, a success toast and a confirmation before removal. The ordinary sources
list hides the menu row so it is not shown twice.

**Replace is a race the worker settles, found on the real platform (25 Sep, run 2).**
The portal sends DELETE then POST within a second. The delete of the last synced source
takes the knowledge base with it (the platform will not empty one), and the newcomer's
sync had already read the agent's base id — so it added to a base that vanished under it
and ended `failed` with "We could not read this source". Two changes in
`knowledge-sync.worker.ts`: (a) a delete of the last synced source **defers** (5 s, at
most 24 times, re-enqueued as `ksync-<id>-del-p<n>`) while a sibling is still `pending`
or `syncing`, so the newcomer lands in the existing base and only the old source is
removed; (b) a sync whose base answers 404 mid-flight **forgets the base**
(`agents.retell_kb_id` cleared where it still holds that id, the row's platform source id
cleared) and retries, so the retry creates a fresh base through look-before-you-buy.
`d6-knowledge.e2e` replaces at once against the double and asserts convergence: one base
for the agent, holding the new menu only.

Images are not accepted: the platform ingests documents (PDF, Word, text, CSV) and a
photographed menu would fail at ingest with a message the customer could not act on. A
menu on a web page can still be added as a URL source with `role: menu`.

### 3. The prompt names the menu, and says what to do when a dish is not on it

`GenerationContext.knowledge` lists the agent's sources (pending, syncing or ready — a
source being read now will be there on the call) with their role. `knowledgeSection()`
writes a "What the agent can look up" section into the user turn; for a menu it adds the
rules the customer expects: answer dishes, prices, ingredients and dietary details from
it, say when something is not on it and offer what is, never invent a dish or a price,
and say so when the menu marks an item unavailable. The Restaurant template's steps and
rules say the same, so a first generation and a regenerate agree. The platform searches
the knowledge base on every turn; the prompt is what turns "found a chunk" into the
right sentence.

A menu uploaded after publish reaches the live agent at the next publish (ADR 0003 §7 —
the LLM is versioned with the agent); a test call re-syncs the draft and uses it at once.

### 4. The agent speaks for the business and no one else

Three layers, none of them a constant:

- `identitySection()` in the user turn: "The agent works for {business} and speaks only
  for it. It introduces itself as {agent_name} from {business}. It never names, or claims
  to be from, any other company, product, voice platform or AI vendor." The business is
  `tenants.name`, the agent name the brief's.
- The system prompt (`DEFAULT_SYSTEM_PROMPT` and `GENERATION_PROMPTS_V1.system`) carries
  the same rule. A stack row published before this keeps its old system prompt; the user
  turn is the guarantee.
- Lint rule `platform_named` (error by default, tunable from `lint_json` like the rest):
  a prompt or greeting that names the platform — as spelt, or as a transcript hears it —
  blocks a publish with a message that does not repeat the name. "Retail" on its own is a
  customer's word and never fires.

### 5. Vendor voice clips are withheld everywhere but a dev box

`vendorSamplePolicy()` now answers `allow` only under `APP_ENV=dev` (an explicit
`VOICE_VENDOR_SAMPLES=allow` still wins). Staging is a customer-facing environment — a
design partner on it heard the vendor's clip — and `ci` and an unset `APP_ENV` fall on
the safe side. `voices.sample_url`, a clip of ours, plays whatever the switch says.

## Alternatives considered

- **A `menus` table or a dedicated upload route.** Rejected: it would duplicate the
  payload handling, the sync job, the platform knowledge base and the delete path, and a
  menu is a knowledge source in every respect but its label.
- **Inferring the category from the workspace name.** Rejected: "Bright Dental" is not
  evidence. The category is what the customer chose, and the only honest reaction to a
  mismatch is to say so and let them decide.
- **Rewriting the model's output to strip a vendor name.** Rejected: silent rewriting of
  a prompt the customer can read is worse than a lint finding they can act on.
- **Changing the §9.4 guardrails.** Rejected: guardrails are what the *agent* must never
  do on a call; who the agent *is* belongs to the generation prompt, and the seeded
  guardrail row is not re-seeded on an environment that already has one.

## Consequences

- Migration `20260925130000_knowledge_source_role`. `knowledgeSourceResponse.role` on
  the wire (nullable). `templateSummary.example_texts`. `lintRule` gains
  `platform_named`. OpenAPI regenerated. `templates/restaurant.json` is version 2 —
  `pnpm db:seed` upserts it.
- Exit check: `pnpm --filter @portal/web e2e:restaurant` against the export, the API
  and worker it was built for, the local issuer and Chrome — W1 warning, W2/W4 banners
  and placeholders, a real Generate, the menu on the real platform (upload, Ready,
  replace, remove, the knowledge base gone with the last source), a Regenerate that
  carries the menu rules, a real browser test call whose transcript names the business
  and never the platform, a Receptionist workspace with no menu, and D3 on a live
  workspace. Automated: `d6-knowledge.e2e` (role, one per agent, replace, refusal,
  isolation), `prompt-builder.test`, `lint.test`, `knowledge.test`, `voices.e2e`
  (defaults), `template-fit.test`.
- What a real caller hears when asking about a dish is the platform's retrieval plus
  the prompt; the script proves the knowledge base is attached to the LLM the test call
  rang and the prompt carries the rules, not the spoken answer itself — that remains a
  human listening test.
