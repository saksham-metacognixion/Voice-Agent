import { generatedPatch, generatedPrompt } from '@portal/schemas';
import { describe, expect, it } from 'vitest';
import { GENERATED_PATCH_JSON_SCHEMA, GENERATED_PROMPT_JSON_SCHEMA } from './output-schema';

/*
 * Two representations of one contract: the JSON Schema the model's decoder is constrained
 * by, and the zod schema that decides whether an answer may become a version. They are
 * separate because `@portal/schemas` is zod 3 and the SDK helper wants zod 4 — so this
 * file is what stops them drifting apart in silence.
 *
 * The zod schema is the authority. The JSON Schema only has to *ask* for everything zod
 * requires; anything looser produces a wasted generation, and anything stricter would
 * refuse an answer zod would have accepted.
 */

/** `generatedPatch` is a refine over an object; this is the object underneath. */
const patchObject = generatedPatch._def.schema;

function requiredKeys(schema: { required?: readonly string[] }): string[] {
  return [...(schema.required ?? [])].sort();
}

/** The keys zod will reject the object for missing — defaults do not count. */
function zodRequiredKeys(schema: { shape: Record<string, { isOptional(): boolean }> }): string[] {
  return Object.entries(schema.shape)
    .filter(([, field]) => !field.isOptional())
    .map(([key]) => key)
    .sort();
}

describe('the generated-prompt contract', () => {
  it('asks the model for every field zod requires', () => {
    for (const key of zodRequiredKeys(generatedPrompt)) {
      expect(requiredKeys(GENERATED_PROMPT_JSON_SCHEMA), `JSON Schema is missing ${key}`).toContain(key);
    }
  });

  it('asks for nothing zod does not know about', () => {
    const known = Object.keys(generatedPrompt.shape);
    for (const key of Object.keys(GENERATED_PROMPT_JSON_SCHEMA.properties)) {
      expect(known, `JSON Schema has an unknown field ${key}`).toContain(key);
    }
  });

  it('closes every object, so the decoder cannot add a key zod would then reject', () => {
    expect(GENERATED_PROMPT_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(GENERATED_PROMPT_JSON_SCHEMA.properties.brief_card.additionalProperties).toBe(false);
    expect(GENERATED_PROMPT_JSON_SCHEMA.properties.analysis_fields.items.additionalProperties).toBe(false);
    expect(GENERATED_PROMPT_JSON_SCHEMA.properties.scenarios.items.additionalProperties).toBe(false);
  });

  it('keeps the §9.8 name rule, which the decoder *can* enforce', () => {
    expect(GENERATED_PROMPT_JSON_SCHEMA.properties.analysis_fields.items.properties.name.pattern).toBe(
      '^[a-z][a-z0-9_]*$',
    );
  });

  it('never opens an object — `additionalProperties: true` is a 400 from the endpoint', () => {
    for (const schema of [GENERATED_PROMPT_JSON_SCHEMA, GENERATED_PATCH_JSON_SCHEMA]) {
      expect(JSON.stringify(schema)).not.toContain('"additionalProperties":true');
    }
  });

  it('carries no `maxItems` anywhere — the endpoint rejects the whole request for it', () => {
    // `output_config.format.schema: For 'array' type, property 'maxItems' is not supported`
    // is a 400, found by `pnpm --filter @portal/api bench:generation` against the real
    // model. The bounds live in zod; this test is what stops them creeping back here.
    for (const schema of [GENERATED_PROMPT_JSON_SCHEMA, GENERATED_PATCH_JSON_SCHEMA]) {
      expect(JSON.stringify(schema)).not.toContain('maxItems');
      expect(JSON.stringify(schema)).not.toContain('minItems');
    }
  });

  it('still says the sizes in prose, so the model aims at the right length (ADR 0012)', () => {
    // Latency is output length, so each optional part is told how short to be. The
    // analysis fields are asked for as *additions* — the template's own are merged in by
    // the worker and were being re-typed by the model for nothing.
    expect(GENERATED_PROMPT_JSON_SCHEMA.properties.analysis_fields.description).toMatch(/additional/i);
    expect(GENERATED_PROMPT_JSON_SCHEMA.properties.analysis_fields.description).toContain('already captured');
    expect(GENERATED_PROMPT_JSON_SCHEMA.properties.scenarios.description).toContain('8');
    expect(GENERATED_PROMPT_JSON_SCHEMA.properties.warnings.description).toContain('3');
    expect(GENERATED_PROMPT_JSON_SCHEMA.properties.brief_card.description).toContain('three to five');
  });

  it('tells the model not to write the platform rules, which are appended in code', () => {
    expect(GENERATED_PROMPT_JSON_SCHEMA.properties.prompt.description).toContain('appended automatically');
  });

  it('accepts an answer shaped exactly as the schema describes', () => {
    const answer = {
      prompt: 'You are Sophie, the receptionist for Maple Dental. Greet the caller and take a message when you must.',
      greeting: 'Thank you for calling Maple Dental.',
      closing: 'Thanks for calling, goodbye.',
      brief_card: { does: ['Takes messages'], doesnt: ['Quotes prices'], handoff: ['Transfers urgent calls'] },
      analysis_fields: [{ name: 'caller_name', type: 'text', description: 'The name given.' }],
      scenarios: [{ title: 'Opening hours', say_this: 'We are open nine to five.' }],
      warnings: [],
    };
    expect(generatedPrompt.safeParse(answer).success).toBe(true);
  });
});

describe('the feedback-patch contract', () => {
  it('asks the model for every field zod requires', () => {
    // `generatedPatch` carries a refine (a patch that changed something must have a
    // prompt), so the object it wraps is one `innerType` down.
    for (const key of zodRequiredKeys(patchObject)) {
      expect(requiredKeys(GENERATED_PATCH_JSON_SCHEMA), `JSON Schema is missing ${key}`).toContain(key);
    }
  });

  it('requires `updated_prompt`, and a refusal may answer it with an empty string (§9.6, D9)', () => {
    // Optional, the real model skipped it on ordinary requests and failed the job.
    expect(requiredKeys(GENERATED_PATCH_JSON_SCHEMA)).toContain('updated_prompt');
    expect(generatedPatch.safeParse({ updated_brief: {}, updated_prompt: '', changes: [], explanation: 'I cannot.' }).success).toBe(true);
  });

  it('accepts a refusal with no prompt at all, and rejects a change with none', () => {
    expect(generatedPatch.safeParse({ updated_brief: {}, changes: [], explanation: 'I cannot.' }).success).toBe(true);
    expect(generatedPatch.safeParse({ updated_brief: {}, changes: ['Made it warmer'] }).success).toBe(false);
  });

  it('allows an empty `changes` — §9.6 says that is the right answer to a guardrail conflict', () => {
    const refusal = {
      updated_brief: {},
      updated_prompt: 'You are Sophie, the receptionist for Maple Dental. You always say you are an AI assistant.',
      changes: [],
      explanation: 'I cannot make the agent claim to be human.',
    };
    const parsed = generatedPatch.safeParse(refusal);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.changes).toEqual([]);
  });

  it('closes `updated_brief` — an open object is a 400 from the endpoint', () => {
    // "For 'object' type, 'additionalProperties: true' is not supported". Found by
    // `bench:generation`; it would have failed every §9.6 patch in production.
    expect(GENERATED_PATCH_JSON_SCHEMA.properties.updated_brief.additionalProperties).toBe(false);
    expect(Object.keys(GENERATED_PATCH_JSON_SCHEMA.properties.updated_brief.properties)).toContain('goal');
  });

  it('names only brief fields zod will accept back', () => {
    const known = Object.keys(patchObject.shape.updated_brief._def.innerType.shape);
    for (const key of Object.keys(GENERATED_PATCH_JSON_SCHEMA.properties.updated_brief.properties)) {
      expect(known, `updated_brief has an unknown field ${key}`).toContain(key);
    }
  });
});

describe('zod as the gate', () => {
  it('rejects a prompt too short to be an agent', () => {
    expect(generatedPrompt.safeParse({ prompt: 'hi', greeting: 'hello', closing: 'bye' }).success).toBe(false);
  });

  it('rejects an analysis field whose name is not snake_case', () => {
    const answer = {
      prompt: 'x'.repeat(60),
      greeting: 'Hello.',
      closing: 'Bye.',
      brief_card: { does: [], doesnt: [], handoff: [] },
      analysis_fields: [{ name: 'Caller Name', type: 'text', description: 'The name.' }],
      scenarios: [],
      warnings: [],
    };
    expect(generatedPrompt.safeParse(answer).success).toBe(false);
  });

  it('rejects an answer that is missing the greeting entirely', () => {
    const answer = {
      prompt: 'x'.repeat(60),
      closing: 'Bye.',
      brief_card: { does: [], doesnt: [], handoff: [] },
      analysis_fields: [],
      scenarios: [],
      warnings: [],
    };
    expect(generatedPrompt.safeParse(answer).success).toBe(false);
  });
});
