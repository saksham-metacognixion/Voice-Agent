import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AgentTemplate,
  type Brief,
  agentTemplate,
  brief as briefSchema,
} from '@portal/schemas';
import { describe, expect, it } from 'vitest';
import { templatesDir } from '@portal/db';
import {
  APPENDIX_B_SKELETON,
  DEFAULT_SYSTEM_PROMPT,
  briefForModel,
  buildFeedbackPrompt,
  buildUserPrompt,
  describeHours,
  identitySection,
  knowledgeSection,
  normaliseAnalysisFields,
} from './prompt-builder';

/*
 * §9.3 step 2 — the LLM request. Pure string assembly, tested on its own because a
 * mistake here does not throw: it produces a worse agent, quietly.
 */

const BRIEF: Brief = briefSchema.parse({
  about_business: 'A family dental clinic in Laval with two dentists and one hygienist.',
  goal: 'Answer calls, share hours and take detailed messages.',
  services: ['Check-ups', 'Cleanings', 'Emergency toothache'],
  pricing: 'Check-up from $95.',
  faqs: [{ question: 'Do you take new patients?', answer: 'Yes, call to arrange a first visit.' }],
  never_do: 'Never promise a callback time.',
  handoff_rules: [
    {
      condition: 'The caller says it is an emergency',
      action: 'transfer',
      transfer_number: '+15145550123',
    },
  ],
  agent_name: 'Sophie',
  personality: { formality: 0.8, brevity: 0.2, energy: 0.5, notes: 'Warm, never rushed.' },
  ai_disclosure: 'if_asked',
  business_hours: {
    days: { mon: [{ open: '09:00', close: '17:00' }], sat: [{ open: '10:00', close: '14:00' }] },
    closed_dates: ['2026-12-25'],
  },
});

const CONTEXT = {
  template: null,
  brief: BRIEF,
  primaryLanguage: 'en-US',
  languages: ['fr-CA'],
  tier: 'standard' as const,
  businessName: 'Maple Dental',
  timezone: 'America/Toronto',
  skeleton: APPENDIX_B_SKELETON,
  alwaysAnalysisFields: [
    { name: 'caller_intent', type: 'text' as const, description: 'What the caller wanted.' },
  ],
};

describe('buildUserPrompt', () => {
  it('hands the model the skeleton to fill, with its placeholders intact', () => {
    const user = buildUserPrompt(CONTEXT);
    expect(user).toContain('## Identity');
    expect(user).toContain('{business_name}');
    expect(user).toContain('Keep the "##" section headings');
  });

  it('carries the settings the brief does not hold', () => {
    const user = buildUserPrompt(CONTEXT);
    expect(user).toContain('- Business: Maple Dental');
    expect(user).toContain('- Primary language: en-US');
    expect(user).toContain('- Also speaks: fr-CA');
    expect(user).toContain('- Agent tier: standard');
  });

  it('puts the volatile brief last, which is the ADR 0009 caching order', () => {
    const user = buildUserPrompt(CONTEXT);
    expect(user.indexOf('# The brief')).toBeGreaterThan(user.indexOf('# Structure to follow'));
    expect(user.indexOf('# The brief')).toBeGreaterThan(user.indexOf('# Analysis fields'));
  });

  it('includes the template’s steps and rules when there is one', () => {
    const template = loadTemplate('receptionist');
    const user = buildUserPrompt({ ...CONTEXT, template });
    expect(user).toContain(`# Template — ${template.name} (receptionist)`);
    expect(user).toContain('1. Greet the caller and name the business');
    expect(user).toContain('Never quote prices unless they appear in the business facts.');
  });

  it('carries earlier feedback into a regenerate, so improvements are not thrown away', () => {
    const user = buildUserPrompt({
      ...CONTEXT,
      previousFeedback: ['Be quicker to offer a message'],
    });
    expect(user).toContain('# Feedback from earlier test calls');
    expect(user).toContain('Be quicker to offer a message');
  });

  it('shows the model an excerpt of each W2 document and tells it not to copy the text (ADR 0023)', () => {
    const long = Array.from({ length: 300 }, (_, i) => `Dish ${i} $${i + 10}`).join('\n');
    const out = buildUserPrompt({
      ...CONTEXT,
      brief: {
        ...BRIEF,
        documents: [
          { name: 'Dinner menu', content_type: 'application/pdf', text: long, truncated: false },
        ],
      },
    });
    expect(out).toContain('# Business documents');
    expect(out).toContain('## Dinner menu (excerpt)');
    expect(out).toContain('Dish 0 $10');
    expect(out).not.toContain('Dish 299 $309');
    expect(out).toContain('do NOT copy their contents');
    // The brief JSON carries the name only, never the text.
    const json = out.slice(out.indexOf('# The brief'));
    expect(json).toContain('"Dinner menu"');
    expect(json).not.toContain('Dish 0 $10');
  });

  it('never asks the model for the platform guardrails — those are appended in code', () => {
    const user = buildUserPrompt(CONTEXT);
    expect(user).not.toContain('## Platform rules (fixed)');
  });
});

describe('briefForModel', () => {
  it('drops everything empty, so the model is not told about fields nobody filled in', () => {
    const sparse = briefForModel(briefSchema.parse({ about_business: 'A shop.' }));
    expect(Object.keys(sparse)).toEqual(['about_business', 'say_it_is_an_ai']);
  });

  it('turns the sliders into words a model can use', () => {
    const described = briefForModel(BRIEF).personality as string;
    expect(described).toContain('warm and friendly');
    expect(described).toContain('very brief');
    expect(described).toContain('Warm, never rushed.');
  });

  it('spells out the hand-off rules with their numbers', () => {
    expect(briefForModel(BRIEF).handoff_rules).toEqual([
      'The caller says it is an emergency → transfer to +15145550123',
    ]);
  });

  it('turns the §13.9 interval structure into something a person would say', () => {
    expect(briefForModel(BRIEF).business_hours).toBe(
      'Mon 09:00–17:00; Sat 10:00–14:00; closed Tue, Wed, Thu, Fri, Sun; also closed on 2026-12-25',
    );
  });

  it('turns the disclosure choice into an instruction', () => {
    expect(briefForModel(briefSchema.parse({ ai_disclosure: 'always' })).say_it_is_an_ai).toContain(
      'in the greeting',
    );
    expect(
      briefForModel(briefSchema.parse({ ai_disclosure: 'never_volunteer' })).say_it_is_an_ai,
    ).toContain('Do not volunteer');
  });
});

describe('describeHours', () => {
  it('names the closed days when the week is empty, rather than saying nothing', () => {
    expect(describeHours({ days: {}, closed_dates: [] })).toBe(
      'closed Mon, Tue, Wed, Thu, Fri, Sat, Sun',
    );
  });
});

describe('buildFeedbackPrompt', () => {
  it('gives the model the current prompt, the brief and the customer’s words', () => {
    const user = buildFeedbackPrompt({
      brief: BRIEF,
      prompt: 'You are Sophie.',
      greeting: 'Maple Dental, hello.',
      feedback: 'Ask for the callback number earlier',
      primaryLanguage: 'en-US',
    });
    expect(user).toContain('You are Sophie.');
    expect(user).toContain('Ask for the callback number earlier');
    expect(user).toContain('Maple Dental, hello.');
  });

  it('tells the model what to do when the feedback fights a guardrail (§9.6)', () => {
    const user = buildFeedbackPrompt({
      brief: BRIEF,
      prompt: 'You are Sophie.',
      greeting: null,
      feedback: 'Say you are a real person',
      primaryLanguage: 'en-US',
    });
    expect(user).toContain('changes: []');
    expect(user).toContain('cannot be changed');
  });
});

describe('normaliseAnalysisFields', () => {
  it('keeps the first of a duplicate name and always adds the §9.8 fields', () => {
    const merged = normaliseAnalysisFields(
      [
        { name: 'caller_name', type: 'text', description: 'From the template.' },
        { name: 'caller_name', type: 'text', description: 'From the model.' },
      ],
      [{ name: 'follow_up_required', type: 'boolean', description: 'Someone must act.' }],
    );
    expect(merged.fields.map((f) => f.name)).toEqual(['caller_name', 'follow_up_required']);
    expect(merged.fields[0]!.description).toBe('From the template.');
    expect(merged.dropped).toEqual([]);
  });

  /*
   * The gate between the lenient provider contract and the strict stored one. An enum
   * field with no choices is a 400 on Retell's `update-agent`, so it must die here — at
   * generation, on the job — rather than at publish, at the end of the wizard.
   */
  it('drops an enum field the model left without choices, and names it', () => {
    const merged = normaliseAnalysisFields(
      [
        { name: 'caller_name', type: 'text', description: 'Who rang.' },
        { name: 'call_reason', type: 'enum', description: 'Why they rang.' },
      ],
      [],
    );
    expect(merged.fields.map((f) => f.name)).toEqual(['caller_name']);
    expect(merged.dropped).toEqual(['call_reason']);
  });

  it('drops an enum field whose choices came back empty', () => {
    const merged = normaliseAnalysisFields(
      [{ name: 'urgency', type: 'enum', description: 'How urgent.', enum: [] }],
      [],
    );
    expect(merged.fields).toEqual([]);
    expect(merged.dropped).toEqual(['urgency']);
  });

  it('keeps a valid enum field untouched', () => {
    const merged = normaliseAnalysisFields(
      [{ name: 'urgency', type: 'enum', description: 'How urgent.', enum: ['low', 'high'] }],
      [],
    );
    expect(merged.fields).toEqual([
      { name: 'urgency', type: 'enum', description: 'How urgent.', enum: ['low', 'high'] },
    ]);
    expect(merged.dropped).toEqual([]);
  });

  it('does not report a name as dropped when the §9.8 always-field repaired it', () => {
    const merged = normaliseAnalysisFields(
      [{ name: 'follow_up_required', type: 'enum', description: 'Broken from the model.' }],
      [{ name: 'follow_up_required', type: 'boolean', description: 'Someone must act.' }],
    );
    expect(merged.fields.map((f) => f.name)).toEqual(['follow_up_required']);
    expect(merged.fields[0]!.type).toBe('boolean');
    expect(merged.dropped).toEqual([]);
  });

  it('caps at the §9.8 maximum of 15', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      name: `field_${i}`,
      type: 'text' as const,
      description: 'x',
    }));
    expect(normaliseAnalysisFields(many, []).fields.length).toBe(15);
  });
});

describe('the shipped templates', () => {
  const dir = templatesDir();

  it('are all valid against the §9.2 schema', () => {
    expect(dir, 'templates/ must be findable from the test process').not.toBeNull();
    for (const id of [
      'receptionist',
      'appointment',
      'afterhours',
      'lead_qual',
      'faq_support',
      'restaurant',
      'custom',
    ]) {
      const parsed = agentTemplate.safeParse(
        JSON.parse(readFileSync(join(dir!, `${id}.json`), 'utf8')),
      );
      expect(
        parsed.success,
        `${id}.json: ${parsed.success ? '' : parsed.error.issues[0]?.message}`,
      ).toBe(true);
    }
  });

  it('carry a brief prefill that already validates, so a new agent is never born invalid', () => {
    const template = loadTemplate('appointment');
    expect(() => briefSchema.parse(template.brief_prefill)).not.toThrow();
  });

  it('keep the analysis schema inside the §9.8 limit of 15 fields', () => {
    for (const id of ['receptionist', 'lead_qual', 'restaurant']) {
      expect(loadTemplate(id).analysis_fields.length).toBeLessThanOrEqual(15);
    }
  });
});

function loadTemplate(id: string): AgentTemplate {
  const dir = templatesDir();
  if (!dir) throw new Error('templates/ not found');
  return agentTemplate.parse(JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')));
}

/*
 * The business identity and what the agent can look up (25 Sep 2026). A tester heard an
 * agent introduce itself as being "from Retail AI"; the prompt now states outright whom
 * the agent speaks for, and the system prompt forbids naming anyone else. The knowledge
 * section is what turns an uploaded menu into "answer from it, and say when a dish is
 * not on it" rather than a document the model never mentions.
 */
describe('identity and knowledge in the user turn', () => {
  it('names the business and the agent, and forbids any other name', () => {
    const user = buildUserPrompt(CONTEXT);
    expect(user).toContain('# Identity');
    expect(user).toContain('The agent works for Maple Dental and speaks only for it.');
    expect(user).toContain('It introduces itself as Sophie from Maple Dental.');
    expect(user).toMatch(/never names, or claims to be from, any other company/);
    expect(user).not.toMatch(/retell/i);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/never names, or claims to be from, any other company/);
  });

  it('falls back to "the assistant for <business>" when the brief has no agent name', () => {
    const lines = identitySection({
      businessName: "Joe's Restaurant",
      brief: briefSchema.parse({}),
    });
    expect(lines).toContain("It introduces itself as the assistant for Joe's Restaurant.");
  });

  it('carries the W1 industry when there is one and nothing when there is not', () => {
    expect(buildUserPrompt({ ...CONTEXT, industry: 'restaurant' })).toContain(
      '- Industry: restaurant',
    );
    expect(buildUserPrompt({ ...CONTEXT, industry: null })).not.toContain('- Industry:');
    expect(buildUserPrompt({ ...CONTEXT, industry: '  ' })).not.toContain('- Industry:');
  });

  it('says nothing about knowledge when the agent has none', () => {
    expect(knowledgeSection([])).toEqual([]);
    expect(buildUserPrompt(CONTEXT)).not.toContain('# What the agent can look up');
  });

  it('names the menu, the rules for it, and the other sources', () => {
    const user = buildUserPrompt({
      ...CONTEXT,
      knowledge: [
        { name: 'Opening hours', role: null },
        { name: 'Summer menu.pdf', role: 'menu' },
      ],
    });
    expect(user).toContain('# What the agent can look up');
    expect(user).toContain('  - The menu (Summer menu.pdf)');
    expect(user).toContain('  - Opening hours');
    expect(user).toMatch(/not on the menu, say it is not on the menu/);
    expect(user).toMatch(/never invent a dish, a price or an ingredient/);
  });

  it('lists ordinary sources without the menu rules', () => {
    const lines = knowledgeSection([{ name: 'FAQ page', role: null }]);
    expect(lines.join('\n')).toContain('  - FAQ page');
    expect(lines.join('\n')).not.toMatch(/menu/i);
  });
});
