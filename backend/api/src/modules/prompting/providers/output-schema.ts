/**
 * The JSON Schema handed to the model's structured-output parameter.
 *
 * Why this exists next to a perfectly good zod schema: `@portal/schemas` is zod 3 and is
 * bundled into the browser (it depends on zod and nothing else, by rule); the SDK's
 * `zodOutputFormat` helper takes a zod 4 schema. Rather than drag a second zod dialect
 * into the shared package, the wire schema is written once here and the *validation* is
 * still `generatedPrompt` / `generatedPatch` from `@portal/schemas` — the contract ADR
 * 0009 names. A unit test asserts the two agree on required fields, so they cannot drift
 * quietly.
 *
 * It describes the **shape, not the limits**. `maxItems` is rejected outright by the
 * structured-output endpoint — `output_config.format.schema: For 'array' type, property
 * 'maxItems' is not supported`, a 400 on the whole request — which is the sort of thing
 * only a real call finds; `pnpm --filter @portal/api bench:generation` is what found it.
 * Every bound therefore lives in zod, where the contract is anyway, and the counts the
 * model should aim for are stated in the `description` strings, as advice rather than as
 * a constraint the decoder has to honour. `normaliseAnalysisFields` caps the §9.8 fifteen
 * on the way in, so an over-long list is trimmed rather than wasting the generation.
 *
 * The `description` strings are also where the *size* of the answer is steered. Latency
 * on this path is output length (ADR 0012, and the 21 Sep 2026 measurement: ~100 output
 * tokens a second, thinking 0 ms), so each optional part says how short it should be —
 * the brief card three to five lines a column, the warnings three clauses, the analysis
 * fields *additions only*. The zod bounds stay wider: they are gates, not targets.
 *
 * `additionalProperties: false` everywhere: structured output is a constraint on the
 * decoder, and leaving it open invites an extra key that zod then rejects — a wasted
 * generation instead of a schema violation the model could not have made.
 */

export const GENERATED_PROMPT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt', 'greeting', 'closing', 'brief_card', 'analysis_fields', 'scenarios', 'warnings'],
  properties: {
    prompt: {
      type: 'string',
      description:
        'The full agent prompt, following the skeleton. Spoken language, short sentences. Do not include a "## Platform rules (fixed)" section — it is appended automatically.',
    },
    greeting: {
      type: 'string',
      description: 'The first thing the agent says, one sentence, at most 25 words, in the primary language.',
    },
    closing: { type: 'string', description: 'The goodbye line, said only once the caller has nothing else. Never after an ordinary answer.' },
    brief_card: {
      type: 'object',
      additionalProperties: false,
      required: ['does', 'doesnt', 'handoff'],
      description:
        'A plain-language summary shown back to the customer: three to five lines each, one short sentence per line. Restate only what the brief and the template say; never add a number or limit the brief does not give.',
      properties: {
        does: { type: 'array', items: { type: 'string' } },
        doesnt: { type: 'array', items: { type: 'string' } },
        handoff: { type: 'array', items: { type: 'string' } },
      },
    },
    analysis_fields: {
      type: 'array',
      description:
        'Additional post-call analysis fields only — never the ones the request lists as already captured. snake_case names. Empty when nothing is missing.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'type', 'description'],
        properties: {
          name: { type: 'string', pattern: '^[a-z][a-z0-9_]*$' },
          type: { type: 'string', enum: ['text', 'number', 'boolean', 'enum'] },
          description: { type: 'string' },
          enum: { type: 'array', items: { type: 'string' }, description: 'Required when type is enum; at most 20.' },
        },
      },
    },
    scenarios: {
      type: 'array',
      description: 'Up to 8 example calls the customer can try, with what the agent should say.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'say_this'],
        properties: { title: { type: 'string' }, say_this: { type: 'string' } },
      },
    },
    warnings: {
      type: 'array',
      description:
        'At most 3 short notes, one clause each, on what the brief left unclear — including a condition with no limit, such as "large parties" with no party size. Empty when nothing is.',
      items: { type: 'string' },
    },
  },
} as const;

export const GENERATED_PATCH_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  // `updated_prompt` is required, and a refusal answers it with an empty string (which
  // `generatedPatch` accepts, so an honest refusal is never a failed job). Optional, the
  // model skipped it on ordinary requests and put the rewritten prompt into `closing`
  // instead — two of five real feedback patches failed that way in the D9 wizard run
  // ("closing: at most 500 characters; updated_prompt: a patch that changed something
  // must carry the full updated prompt").
  required: ['updated_brief', 'updated_prompt', 'changes'],
  properties: {
    /**
     * The brief fields spoken feedback actually changes — closed, because
     * `additionalProperties: true` is rejected outright ("For 'object' type,
     * 'additionalProperties: true' is not supported"), a 400 that would have made every
     * §9.6 patch fail in production. The scripted provider cannot catch that; the
     * benchmark against the real model did.
     *
     * The structural fields — business hours, FAQ pairs, hand-off rules, the personality
     * sliders — are deliberately absent. They are edited in the wizard with a form, not by
     * a customer saying "be warmer", and spelling their nested shapes out here would
     * duplicate the brief schema for fields the model has no business rewriting.
     * `mergeBriefPatch` re-validates whatever comes back against the real brief schema, so
     * an unexpected field is dropped rather than trusted.
     */
    updated_brief: {
      type: 'object',
      additionalProperties: false,
      description: 'Only the brief fields that changed. Omit every field that did not.',
      properties: {
        about_business: { type: 'string' },
        goal: { type: 'string' },
        pricing: { type: 'string' },
        never_do: { type: 'string' },
        agent_name: { type: 'string' },
        anything_else: { type: 'string' },
        services: { type: 'array', items: { type: 'string' } },
        ai_disclosure: { type: 'string', enum: ['always', 'if_asked', 'never_volunteer'] },
      },
    },
    updated_prompt: {
      type: 'string',
      description:
        'The COMPLETE prompt after the change — every section, not only the changed part. Always present: an empty string only when changes is empty. Do not include a "## Platform rules (fixed)" section — it is appended automatically.',
    },
    changes: {
      type: 'array',
      description:
        'One short human-readable bullet per change, at most 20. Empty when the request could not be carried out.',
      items: { type: 'string' },
    },
    explanation: {
      type: 'string',
      description: 'Required when changes is empty: why the request could not be carried out.',
    },
    greeting: {
      type: 'string',
      description: 'Only when the change is to the first thing the agent says: the new opening line, one or two sentences, under 500 characters. Omit otherwise.',
    },
    closing: {
      type: 'string',
      description: 'Only when the change is to how the agent ends the call: the new sign-off line, one or two sentences, under 500 characters. Never the prompt. Omit otherwise.',
    },
  },
} as const;
