import { describe, expect, it } from 'vitest';
import {
  agentDraftPatch,
  agentSettings,
  analysisField,
  analysisSchema,
  defaultAgentSettings,
  generatedPrompt,
  modelAnalysisField,
  retellLanguage,
} from './agents';

/*
 * §9.8 analysis fields and the W3 languages — the two places where a value that passed
 * validation used to be cast to one of Retell's closed unions on the way out. A cast is
 * not a check, and the failure landed at `update-agent`, i.e. at publish, at the end of
 * the wizard. These tests are the check.
 */

describe('analysisField (strict — stored and sent)', () => {
  it('accepts an enum field with non-empty choices', () => {
    const parsed = analysisField.safeParse({
      name: 'call_reason',
      type: 'enum',
      description: 'Why they rang.',
      enum: ['appointment', 'question'],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.type === 'enum' && parsed.data.enum).toEqual(['appointment', 'question']);
  });

  it('rejects an enum field whose choices are empty — Retell requires a non-empty array', () => {
    const parsed = analysisField.safeParse({
      name: 'call_reason',
      type: 'enum',
      description: 'Why they rang.',
      enum: [],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an enum field with no choices at all', () => {
    const parsed = analysisField.safeParse({
      name: 'call_reason',
      type: 'enum',
      description: 'Why they rang.',
    });
    expect(parsed.success).toBe(false);
  });

  it.each(['text', 'number', 'boolean'] as const)('accepts a %s field with no choices', (type) => {
    const parsed = analysisField.safeParse({ name: 'caller_name', type, description: 'Who rang.' });
    expect(parsed.success).toBe(true);
  });

  it('strips a stray enum from a non-enum field rather than failing an older row', () => {
    const parsed = analysisField.safeParse({
      name: 'caller_name',
      type: 'text',
      description: 'Who rang.',
      enum: [],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'enum' in parsed.data).toBe(false);
  });

  it('rejects an unknown type outright', () => {
    expect(analysisField.safeParse({ name: 'x', type: 'date', description: 'd' }).success).toBe(false);
  });

  it('fails the whole array when one field is an invalid enum', () => {
    const result = analysisSchema.safeParse([
      { name: 'caller_name', type: 'text', description: 'Who rang.' },
      { name: 'call_reason', type: 'enum', description: 'Why.', enum: [] },
    ]);
    expect(result.success).toBe(false);
  });

  it('is enforced on the customer-editable draft patch, not only on generation', () => {
    const result = agentDraftPatch.safeParse({
      analysis_fields: [{ name: 'call_reason', type: 'enum', description: 'Why.' }],
    });
    expect(result.success).toBe(false);
  });
});

describe('modelAnalysisField (lenient — the model’s raw answer only)', () => {
  it('tolerates a missing enum so one bad field does not fail a whole generation', () => {
    expect(
      modelAnalysisField.safeParse({ name: 'call_reason', type: 'enum', description: 'Why.' }).success,
    ).toBe(true);
  });

  it('is what generatedPrompt uses, so the provider contract stays forgiving', () => {
    const parsed = generatedPrompt.safeParse({
      prompt: 'x'.repeat(60),
      greeting: 'Hello',
      closing: 'Bye',
      brief_card: { does: [], doesnt: [], handoff: [] },
      analysis_fields: [{ name: 'call_reason', type: 'enum', description: 'Why.' }],
      scenarios: [],
      warnings: [],
    });
    expect(parsed.success).toBe(true);
  });

  it('still rejects a name that is not snake_case', () => {
    expect(modelAnalysisField.safeParse({ name: 'Call Reason', type: 'text', description: 'Why.' }).success).toBe(
      false,
    );
  });
});

describe('retellLanguage', () => {
  it('accepts a locale Retell supports', () => {
    expect(retellLanguage.safeParse('fr-CA').success).toBe(true);
    expect(retellLanguage.safeParse('en-US').success).toBe(true);
    expect(retellLanguage.safeParse('es-419').success).toBe(true);
  });

  it.each(['en', 'xx-XX', 'english', 'EN-US', ''])('rejects %p', (value) => {
    expect(retellLanguage.safeParse(value).success).toBe(false);
  });

  it('does not offer `multi` as a customer choice — the gateway decides that (W3)', () => {
    expect(retellLanguage.safeParse('multi').success).toBe(false);
  });

  it('gates primary_language and languages on the draft patch', () => {
    expect(agentDraftPatch.safeParse({ primary_language: 'en-US' }).success).toBe(true);
    expect(agentDraftPatch.safeParse({ primary_language: 'en' }).success).toBe(false);
    expect(agentDraftPatch.safeParse({ languages: ['fr-CA'] }).success).toBe(true);
    expect(agentDraftPatch.safeParse({ languages: ['fr-CA', 'klingon'] }).success).toBe(false);
  });

  it('gates the stored settings too, so a bad locale cannot reach a version', () => {
    expect(agentSettings.safeParse({ ...defaultAgentSettings(), primary_language: 'zz-ZZ' }).success).toBe(false);
    expect(agentSettings.safeParse(defaultAgentSettings()).success).toBe(true);
  });
});

describe('briefPatch — the W2 autosave (QA-006)', () => {
  it('takes null as "clear" for an optional field', () => {
    const parsed = agentDraftPatch.parse({ brief: { agent_name: null, address: null, pricing: null, anything_else: null, never_do: null } });
    expect(parsed.brief).toEqual({ agent_name: null, address: null, pricing: null, anything_else: null, never_do: null });
  });

  it('still validates a value that is sent', () => {
    expect(agentDraftPatch.safeParse({ brief: { agent_name: 'x' } }).success).toBe(false);
    expect(agentDraftPatch.safeParse({ brief: { pricing: 'x'.repeat(501) } }).success).toBe(false);
  });

  it('takes no null for an array field — [] is how one is cleared', () => {
    expect(agentDraftPatch.safeParse({ brief: { services: null } }).success).toBe(false);
    expect(agentDraftPatch.safeParse({ brief: { services: [] } }).success).toBe(true);
  });
});
