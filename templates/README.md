# templates

Versioned agent templates per spec §9.2, one JSON file per template id: `receptionist`, `appointment`,
`afterhours`, `lead_qual`, `faq_support`, `restaurant`, `custom`. Each carries brief prefill, conversation
steps, analysis fields, default rules, default tier, sample audio path and industry-specific example texts.

**The files are the source.** `pnpm db:seed` loads them into the `templates` table, and the admin console
(SA6) edits and publishes new versions from there in P2. At runtime `TemplatesService` prefers the table
row when it exists — that is where a staff edit lands — and falls back to the file, so a fresh database, a
test, or an image whose seed has not run still creates agents.

Both paths parse through `agentTemplate` in `shared/schemas/src/agents.ts`. A file that does not validate
is skipped with a loud log rather than half-loaded: an unvalidated brief prefill would end up in
`agent_versions`, which is immutable (§9.9) and therefore the one place a bad shape is expensive.

The API finds this directory by walking up from its working directory; `TEMPLATES_DIR` overrides it for a
layout where that does not work (see `.env.example`).

## The shape

| Field | What it is |
| --- | --- |
| `id`, `name`, `tagline`, `best_for` | the W1 card |
| `industry_tags` | drives `example_texts` and the W1 industry select |
| `brief_prefill` | pre-fills `agent_versions.brief_json` on `POST /agents` |
| `steps` | §9.2 STEPS, in order — the conversation guide handed to the model |
| `analysis_fields` | §9.8 starting schema, ≤ 15 fields, snake_case names |
| `rules` | §9.2 DEFAULT RULES — business rules, *not* the §9.4 platform guardrails |
| `default_tier` | Standard unless the template needs Premium (`lead_qual`) |
| `sample_audio_url` | the "hear sample" clip in W1 — `frontend/web/public/samples/<id>.mp3`, a static asset, no credits. Recorded on our own voice stack by `pnpm --filter @portal/api samples:templates [id…]` (script and voice per template in `backend/api/scripts/template-samples.ts`); a new template needs a line there |
| `example_texts` | industry → placeholder copy for the W2 "About your business" box |

`restaurant` (version 2, ADR 0020) expects a **menu**: a `knowledge_sources` row with `role = menu`, one
per agent, uploaded from the Menu section of W4 / D3 Knowledge. Its steps and rules tell the agent to
answer dishes, prices and ingredients from it and to say when something is not on it; the generation
prompt names the menu whenever the agent has one.

Platform guardrails are **not** in here. They are §9.4, they live in
`agent_stack_configs.guardrails_text` with a compiled-in fallback, and they are appended by the backend
after the model's answer is validated — see ADR 0012 §1.
