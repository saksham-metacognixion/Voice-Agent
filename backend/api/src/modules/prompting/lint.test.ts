import { type Brief, brief as briefSchema } from '@portal/schemas';
import { describe, expect, it } from 'vitest';
import { applyGuardrails } from './guardrails';
import { DEFAULT_LINT_CONFIG, detectLanguage, lintConfigFrom, lintErrors, lintPrompt } from './lint';

/*
 * §9.5 — prompt lint. Eight rules from the spec plus `guardrails_missing`, each of which
 * either blocks a publish or warns (§13.6: "block on errors, warn on warnings").
 *
 * Determinism matters as much as correctness: `lint_json` is stored on the version and
 * compared, so the same input must always produce the same findings in the same order.
 */

const CLEAN_BODY = [
  '## Identity',
  'You are Sophie, the receptionist for Maple Dental, a family clinic in Laval.',
  '',
  '## Conversation guide',
  'Greet the caller and name the business. Identify what the caller needs in one question.',
  'Answer from the business facts, and take a message when you cannot.',
  'Confirm the captured details back to the caller before ending the call.',
  '',
  '## Hand-off',
  'When the caller says it is urgent, transfer them to the on-call number.',
].join('\n');

const CLEAN_PROMPT = applyGuardrails(CLEAN_BODY);
const GREETING = 'Thank you for calling Maple Dental, how can I help you today?';

function brief(over: Partial<Brief> = {}): Brief {
  return briefSchema.parse(over);
}

function rules(input: Parameters<typeof lintPrompt>[0]) {
  return lintPrompt(input, DEFAULT_LINT_CONFIG, new Date('2026-09-16T00:00:00.000Z')).findings.map((f) => f.rule);
}

describe('a clean version', () => {
  it('passes with nothing to say', () => {
    const result = lintPrompt({ prompt: CLEAN_PROMPT, greeting: GREETING, brief: brief(), primaryLanguage: 'en-US' });
    expect(result.findings).toEqual([]);
    expect(result.publishable).toBe(true);
  });

  it('is deterministic — the same input twice gives the same findings in the same order', () => {
    const input = { prompt: CLEAN_BODY, greeting: null, brief: brief(), primaryLanguage: 'en-US' };
    expect(rules(input)).toEqual(rules(input));
  });
});

describe('rules that block a publish', () => {
  it('prompt_empty — there is no call without a prompt', () => {
    const result = lintPrompt({ prompt: null, greeting: GREETING, brief: brief(), primaryLanguage: 'en-US' });
    expect(result.findings.map((f) => f.rule)).toContain('prompt_empty');
    expect(result.publishable).toBe(false);
    expect(lintErrors(result).map((f) => f.rule)).toContain('prompt_empty');
  });

  it('no_greeting — the caller would hear silence', () => {
    const result = lintPrompt({ prompt: CLEAN_PROMPT, greeting: '  ', brief: brief(), primaryLanguage: 'en-US' });
    expect(result.findings.map((f) => f.rule)).toContain('no_greeting');
    expect(result.publishable).toBe(false);
  });

  it('guardrails_missing — a prompt that reached publish without §9.4', () => {
    const result = lintPrompt({ prompt: CLEAN_BODY, greeting: GREETING, brief: brief(), primaryLanguage: 'en-US' });
    expect(result.findings.map((f) => f.rule)).toContain('guardrails_missing');
    expect(result.publishable).toBe(false);
  });

  it('transfer_tool_missing — the brief promises a transfer the agent cannot perform', () => {
    const withTransfer = brief({
      handoff_rules: [{ condition: 'Caller asks for a person', action: 'transfer', transfer_number: '+15145550123' }],
    });
    const result = lintPrompt({
      prompt: CLEAN_PROMPT,
      greeting: GREETING,
      brief: withTransfer,
      primaryLanguage: 'en-US',
      // No transfer target reached the agent — the failure this rule exists to catch.
      transferNumbers: [],
    });
    expect(result.findings.map((f) => f.rule)).toContain('transfer_tool_missing');
    expect(result.publishable).toBe(false);
  });
});

describe('rules that warn but still publish', () => {
  it('prompt_too_long — over 6,000 characters costs latency on every call', () => {
    const long = applyGuardrails(`${CLEAN_BODY}\n${'Answer politely. '.repeat(400)}`);
    const result = lintPrompt({ prompt: long, greeting: GREETING, brief: brief(), primaryLanguage: 'en-US' });
    expect(result.findings.map((f) => f.rule)).toEqual(['prompt_too_long']);
    expect(result.publishable).toBe(true);
  });

  it('greeting_too_long — over 25 words', () => {
    const wordy = `Thank you so very much indeed for calling the offices of Maple Dental today, ${'and '.repeat(20)}how may I help?`;
    const result = lintPrompt({ prompt: CLEAN_PROMPT, greeting: wordy, brief: brief(), primaryLanguage: 'en-US' });
    expect(result.findings.map((f) => f.rule)).toContain('greeting_too_long');
    expect(result.publishable).toBe(true);
  });

  it('handoff_rule_missing — a transfer number the prompt never mentions using', () => {
    const noHandoffText = applyGuardrails(CLEAN_BODY.replace(/## Hand-off[\s\S]*$/, ''));
    const result = lintPrompt({
      prompt: noHandoffText,
      greeting: GREETING,
      brief: brief({
        handoff_rules: [{ condition: 'Urgent', action: 'transfer', transfer_number: '+15145550123' }],
      }),
      primaryLanguage: 'en-US',
    });
    expect(result.findings.map((f) => f.rule)).toContain('handoff_rule_missing');
    expect(result.publishable).toBe(true);
  });

  it('absolute_language — "guarantee" next to a price', () => {
    const promising = applyGuardrails(`${CLEAN_BODY}\nWe guarantee the price quoted on the call.`);
    const result = lintPrompt({ prompt: promising, greeting: GREETING, brief: brief(), primaryLanguage: 'en-US' });
    expect(result.findings.map((f) => f.rule)).toContain('absolute_language');
  });

  it('does not fire absolute_language on the "always greet warmly" every prompt contains', () => {
    const ordinary = applyGuardrails(`${CLEAN_BODY}\nAlways greet the caller warmly and use their name.`);
    expect(rules({ prompt: ordinary, greeting: GREETING, brief: brief(), primaryLanguage: 'en-US' })).toEqual([]);
  });

  /*
   * The three sentences below are what the real model wrote when the rule flagged two
   * prompts in three (`pnpm --filter @portal/api bench:generation`). Each one is the
   * customer's own instruction, or ordinary good advice, and none of them is a promise.
   */
  it('does not fire on the customer’s own "never promise" rule, echoed into the prompt', () => {
    const echoed = applyGuardrails(
      `${CLEAN_BODY}\n- Never promise a callback time. Never quote a price for treatment that has not been seen.`,
    );
    expect(
      rules({
        prompt: echoed,
        greeting: GREETING,
        brief: brief({ never_do: 'Never promise a callback time. Never quote a price.' }),
        primaryLanguage: 'en-US',
      }),
    ).toEqual([]);
  });

  it('does not fire on "always confirm the appointment details back"', () => {
    const confirming = applyGuardrails(`${CLEAN_BODY}\nAlways confirm the appointment details back to the caller.`);
    expect(rules({ prompt: confirming, greeting: GREETING, brief: brief(), primaryLanguage: 'en-US' })).toEqual([]);
  });

  it('does not fire on "do not guarantee a price"', () => {
    const careful = applyGuardrails(`${CLEAN_BODY}\nDo not guarantee a price over the phone.`);
    expect(rules({ prompt: careful, greeting: GREETING, brief: brief(), primaryLanguage: 'en-US' })).toEqual([]);
  });

  it('still fires on a real promise about money', () => {
    const promising = applyGuardrails(`${CLEAN_BODY}\nWe guarantee the price quoted on this call will not change.`);
    expect(rules({ prompt: promising, greeting: GREETING, brief: brief(), primaryLanguage: 'en-US' })).toContain(
      'absolute_language',
    );
  });

  it('does not fire on "never confirm availability as guaranteed" — a template’s own rule', () => {
    const rule = applyGuardrails(`${CLEAN_BODY}\nNever confirm availability as guaranteed.`);
    expect(rules({ prompt: rule, greeting: GREETING, brief: brief(), primaryLanguage: 'en-US' })).toEqual([]);
  });

  it('does not fire on "Promise a clear next step." two lines from an unrelated pricing rule', () => {
    const apart = applyGuardrails(
      `${CLEAN_BODY}\nPromise a clear next step before ending the call.\nNever quote final pricing.`,
    );
    expect(rules({ prompt: apart, greeting: GREETING, brief: brief(), primaryLanguage: 'en-US' })).toEqual([]);
  });

  it('a negation in an earlier sentence does not silence the next one', () => {
    const mixed = applyGuardrails(
      `${CLEAN_BODY}\nNever be rude to a caller. We guarantee the price quoted on the call.`,
    );
    expect(rules({ prompt: mixed, greeting: GREETING, brief: brief(), primaryLanguage: 'en-US' })).toContain(
      'absolute_language',
    );
  });

  it('language_mismatch — a French prompt on an English agent', () => {
    const french = applyGuardrails(
      [
        'Vous êtes Sophie, la réceptionniste pour la clinique dentaire Érable.',
        'Vous devez saluer le client avec une phrase courte et polie.',
        'Vous demandez au client ce que vous pouvez faire pour lui aujourd’hui.',
        'Si vous ne savez pas, vous dites que vous allez prendre un message pour une personne.',
        'Vous confirmez les détails avec le client avant de terminer un appel.',
        'Vous ne donnez jamais une réponse que vous ne savez pas, et vous restez poli.',
      ].join('\n'),
    );
    const result = lintPrompt({ prompt: french, greeting: 'Bonjour, clinique Érable.', brief: brief(), primaryLanguage: 'en-US' });
    expect(result.findings.map((f) => f.rule)).toContain('language_mismatch');
  });

  it('does not fire language_mismatch when the agent is French', () => {
    const french = applyGuardrails(
      [
        'Vous êtes Sophie, la réceptionniste pour la clinique dentaire Érable.',
        'Vous devez saluer le client avec une phrase courte et polie.',
        'Vous demandez au client ce que vous pouvez faire pour lui aujourd’hui.',
        'Si vous ne savez pas, vous dites que vous allez prendre un message pour une personne.',
        'Vous confirmez les détails avec le client avant de terminer un appel.',
      ].join('\n'),
    );
    expect(rules({ prompt: french, greeting: 'Bonjour.', brief: brief(), primaryLanguage: 'fr-CA' })).not.toContain(
      'language_mismatch',
    );
  });
});

describe('detectLanguage', () => {
  it('says nothing about a prompt too short to judge', () => {
    expect(detectLanguage('You are Sophie.')).toBeNull();
  });

  it('says nothing when two languages are neck and neck', () => {
    const mixed = `${'the and you your for with that this '.repeat(3)} ${'le la les vous votre pour avec que '.repeat(3)}`;
    expect(detectLanguage(mixed)).toBeNull();
  });

  it('recognises an unambiguous English prompt', () => {
    expect(detectLanguage(`${CLEAN_BODY}\n${CLEAN_BODY}`)).toBe('en');
  });
});

describe('lintConfigFrom', () => {
  it('takes the severities the stack row sets and keeps the defaults for the rest', () => {
    const config = lintConfigFrom({ severities: { prompt_too_long: 'error' }, max_greeting_words: 15 });
    expect(config.severities.prompt_too_long).toBe('error');
    expect(config.severities.no_greeting).toBe('error');
    expect(config.severities.absolute_language).toBe('warning');
    expect(config.max_greeting_words).toBe(15);
    expect(config.max_prompt_chars).toBe(DEFAULT_LINT_CONFIG.max_prompt_chars);
  });

  it('ignores nonsense rather than throwing — a bad SA6 row must not stop publishing', () => {
    const config = lintConfigFrom({ severities: { made_up_rule: 'error', no_greeting: 'loud' }, max_prompt_chars: -5 });
    expect(config.severities.no_greeting).toBe('error');
    expect(config.max_prompt_chars).toBe(DEFAULT_LINT_CONFIG.max_prompt_chars);
    expect(Object.keys(config.severities)).not.toContain('made_up_rule');
  });

  it('a stack row can make a warning block a publish', () => {
    const config = lintConfigFrom({ severities: { prompt_too_long: 'error' } });
    const long = applyGuardrails(`${CLEAN_BODY}\n${'Answer politely. '.repeat(400)}`);
    const result = lintPrompt({ prompt: long, greeting: GREETING, brief: brief(), primaryLanguage: 'en-US' }, config);
    expect(result.publishable).toBe(false);
  });
});

/*
 * `platform_named` (25 Sep 2026): the voice platform is never named to a customer, and an
 * agent that says it is "from <vendor>" is that rule broken on the first ring. Blocks a
 * publish. "Retail" on its own is a customer's word and must not fire.
 */
describe('platform_named', () => {
  it('blocks a prompt or a greeting that names the vendor, however it is spelt', () => {
    const body = CLEAN_BODY.replace('the receptionist for Maple Dental', 'the receptionist from Retell AI for Maple Dental');
    const result = lintPrompt({ prompt: applyGuardrails(body), greeting: GREETING, brief: brief(), primaryLanguage: 'en-US' });
    expect(result.findings.map((f) => f.rule)).toContain('platform_named');
    expect(result.publishable).toBe(false);
    expect(lintErrors(result).map((f) => f.rule)).toEqual(['platform_named']);

    const spoken = lintPrompt({ prompt: CLEAN_PROMPT, greeting: 'Hi, this is Sophie from Retail AI, how can I help?', brief: brief(), primaryLanguage: 'en-US' });
    expect(spoken.findings.map((f) => f.rule)).toContain('platform_named');
    // The finding's own text never repeats the name.
    expect(spoken.findings.find((f) => f.rule === 'platform_named')?.message).not.toMatch(/retell|retail/i);
  });

  it('leaves a retail business alone', () => {
    const body = CLEAN_BODY.replace('a family clinic in Laval', 'a retail store in Laval that sells AI gadgets');
    const result = lintPrompt({ prompt: applyGuardrails(body), greeting: GREETING, brief: brief(), primaryLanguage: 'en-US' });
    expect(result.findings.map((f) => f.rule)).not.toContain('platform_named');
  });

  it('can be softened from the stack row like any other rule', () => {
    const config = lintConfigFrom({ severities: { platform_named: 'warning' } });
    expect(config.severities.platform_named).toBe('warning');
    expect(DEFAULT_LINT_CONFIG.severities.platform_named).toBe('error');
  });
});
