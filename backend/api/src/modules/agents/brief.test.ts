import { type Brief, brief as briefSchema, transferTargets } from '@portal/schemas';
import { describe, expect, it } from 'vitest';
import { mergeBrief, parseAnalysisFields, parseBrief, toSummary } from './agents.service';
import { mergeBriefPatch } from '../prompting/generation.worker';

/*
 * The brief is autosaved a field at a time (W2, "debounced 1.5 s on change") and patched
 * by the model a field at a time (§9.6, "only changed fields"). Both merges are here,
 * because both have the same way of going wrong: a partial patch that quietly blanks the
 * twelve fields it did not mention.
 */

const FULL: Brief = briefSchema.parse({
  about_business: 'A family dental clinic in Laval.',
  goal: 'Answer calls and take messages.',
  services: ['Check-ups', 'Cleanings'],
  agent_name: 'Sophie',
  never_do: 'Never promise a callback time.',
  handoff_rules: [{ condition: 'Emergency', action: 'transfer', transfer_number: '+15145550123' }],
});

describe('mergeBrief — the W2 autosave', () => {
  it('writes the field that changed and leaves the rest alone', () => {
    const merged = mergeBrief(FULL, { goal: 'Book appointments.' });
    expect(merged.goal).toBe('Book appointments.');
    expect(merged.about_business).toBe(FULL.about_business);
    expect(merged.services).toEqual(['Check-ups', 'Cleanings']);
    expect(merged.agent_name).toBe('Sophie');
  });

  it('replaces an array wholesale — removing a service has to be possible', () => {
    expect(mergeBrief(FULL, { services: ['Cleanings'] }).services).toEqual(['Cleanings']);
    expect(mergeBrief(FULL, { services: [] }).services).toEqual([]);
  });

  it('an empty patch changes nothing', () => {
    expect(mergeBrief(FULL, {})).toEqual(FULL);
  });

  it('still validates the result — a patch cannot widen a field past the schema', () => {
    expect(() => mergeBrief(FULL, { agent_name: 'x'.repeat(200) })).toThrow();
  });

  it('keeps the disclosure default rather than dropping it', () => {
    expect(mergeBrief(briefSchema.parse({}), { goal: 'Answer calls.' }).ai_disclosure).toBe('if_asked');
  });
});

describe('mergeBriefPatch — the §9.6 model patch', () => {
  it('applies what the model changed', () => {
    expect(mergeBriefPatch(FULL, { goal: 'Qualify leads.' }).goal).toBe('Qualify leads.');
  });

  it('drops a patch that would make the brief invalid, rather than applying half of it', () => {
    const merged = mergeBriefPatch(FULL, { agent_name: '' } as Partial<Brief>);
    expect(merged).toEqual(FULL);
  });

  it('never blanks the fields the model did not mention', () => {
    const merged = mergeBriefPatch(FULL, { never_do: 'Never quote a price.' });
    expect(merged.about_business).toBe(FULL.about_business);
    expect(merged.handoff_rules).toEqual(FULL.handoff_rules);
  });
});

describe('parseBrief', () => {
  it('reads a stored brief back', () => {
    expect(parseBrief(FULL as unknown)).toEqual(FULL);
  });

  it('falls back to an empty brief rather than making the agent unreadable', () => {
    expect(parseBrief({ services: 'not an array' })).toEqual(briefSchema.parse({}));
    expect(parseBrief(null)).toEqual(briefSchema.parse({}));
    expect(parseBrief(undefined)).toEqual(briefSchema.parse({}));
  });
});

describe('transferTargets', () => {
  it('lists the numbers a transfer rule names, deduplicated and in order', () => {
    const brief = briefSchema.parse({
      handoff_rules: [
        { condition: 'Emergency', action: 'transfer', transfer_number: '+15145550123' },
        { condition: 'Billing', action: 'transfer', transfer_number: '+15145550124' },
        { condition: 'Also emergency', action: 'transfer', transfer_number: '+15145550123' },
        { condition: 'Anything else', action: 'take_message' },
      ],
    });
    expect(transferTargets(brief)).toEqual(['+15145550123', '+15145550124']);
  });

  it('is empty when nothing transfers', () => {
    expect(transferTargets(briefSchema.parse({}))).toEqual([]);
  });
});

describe('the brief schema', () => {
  it('refuses a transfer rule with no number — the agent could not carry it out', () => {
    expect(
      briefSchema.safeParse({ handoff_rules: [{ condition: 'Emergency', action: 'transfer' }] }).success,
    ).toBe(false);
  });

  it('refuses a read-a-message rule with no message, or only whitespace — nothing to read', () => {
    for (const message of [undefined, '', '   ']) {
      expect(
        briefSchema.safeParse({ handoff_rules: [{ condition: 'After hours', action: 'read_message', message }] }).success,
      ).toBe(false);
    }
  });

  it('keeps the message of a read-a-message rule, and refuses one over 500 characters', () => {
    const rule = { condition: 'After hours', action: 'read_message', message: 'We are closed, please call back tomorrow.' };
    expect(briefSchema.parse({ handoff_rules: [rule] }).handoff_rules).toEqual([rule]);
    expect(briefSchema.safeParse({ handoff_rules: [{ ...rule, message: 'x'.repeat(501) }] }).success).toBe(false);
  });

  it('accepts a half-filled brief, because autosave stores one on every keystroke', () => {
    expect(briefSchema.safeParse({ about_business: 'A' }).success).toBe(true);
  });
});

describe('parseAnalysisFields', () => {
  it('reads a stored schema back and shrugs off a broken one', () => {
    expect(parseAnalysisFields([{ name: 'reason', type: 'text', description: 'Why.' }])).toHaveLength(1);
    expect(parseAnalysisFields({ not: 'an array' })).toEqual([]);
    expect(parseAnalysisFields(null)).toEqual([]);
  });
});

describe('toSummary', () => {
  const row = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Receptionist',
    templateId: 'receptionist',
    industry: 'dental',
    status: 'live',
    tier: 'standard',
    primaryLanguage: 'en-US',
    languages: [],
    voiceId: '11labs-Adrian',
    voiceSpeed: null,
    voiceTemperature: null,
    draftVersion: 3,
    publishedVersion: 2,
    maxCallDurationS: 600,
    recordingEnabled: true,
    createdAt: new Date('2026-09-16T10:00:00.000Z'),
  };

  it('flags unpublished changes when the draft is ahead — the D3 sticky bar', () => {
    expect(toSummary(row, 1).has_unpublished_changes).toBe(true);
    expect(toSummary({ ...row, draftVersion: 2 }, 1).has_unpublished_changes).toBe(false);
  });

  it('says nothing about Retell', () => {
    expect(JSON.stringify(toSummary(row, 0)).toLowerCase()).not.toContain('retell');
  });
});

describe('parseBrief — repairs per field, never wipes the brief (ADR 0023, 29 Sep)', () => {
  const stored = {
    about_business: 'Casa Lucia is a family Italian restaurant in Toronto.',
    goal: 'Take reservations and answer menu questions from the uploaded menu.',
    agent_name: 'Marie',
    documents: [
      { name: 'Dinner menu', content_type: 'image/heic', text: 'Pasta $18', truncated: false },
      { name: 'Wine list', content_type: 'text/plain', text: 'Chianti $12', truncated: false },
    ],
  };

  it('drops only a read-a-message rule stored before rules carried their message', () => {
    const brief = parseBrief({
      ...stored,
      handoff_rules: [
        { condition: 'After hours', action: 'read_message' },
        { condition: 'Emergency', action: 'transfer', transfer_number: '+15145550123' },
        { condition: 'Closed', action: 'read_message', message: 'We are closed today.' },
      ],
    });
    expect(brief.handoff_rules.map((r) => r.condition)).toEqual(['Emergency', 'Closed']);
    expect(brief.agent_name).toBe('Marie');
  });

  it('drops only the document the schema cannot read and keeps the rest of the brief', () => {
    const brief = parseBrief(stored);
    expect(brief.agent_name).toBe('Marie');
    expect(brief.about_business).toBe(stored.about_business);
    expect(brief.documents.map((d) => d.name)).toEqual(['Wine list']);
  });

  it('drops a field that fails and keeps the others', () => {
    const brief = parseBrief({ ...stored, documents: [], agent_name: 'M', services: 'not-an-array' });
    expect(brief.about_business).toBe(stored.about_business);
    expect(brief.agent_name).toBeUndefined();
    expect(brief.services).toEqual([]);
  });

  it('falls back to an empty brief only for input that is not an object', () => {
    expect(parseBrief('nonsense').about_business).toBeUndefined();
    expect(parseBrief(null).documents).toEqual([]);
  });
});
