import { describe, expect, it } from 'vitest';
import { dialectSection, languageBlock, stripLanguageBlock, LANGUAGE_BLOCK_HEADING } from './dialects';
import { runtimePrompt } from './documents';
import { buildFeedbackPrompt } from './prompt-builder';

/* ADR 0027: what the 26 Oct Arabic proof calls taught the prompt. */

describe('languageBlock', () => {
  it('names the dialect, never Modern Standard Arabic, for each Gulf locale', () => {
    expect(languageBlock('ar-SA')).toContain('Saudi Arabic');
    expect(languageBlock('ar-AE')).toContain('Emirati Arabic');
    expect(languageBlock('ar-SA')).toContain('not Modern Standard Arabic');
  });

  it('is null for a language that is not one of ours', () => {
    expect(languageBlock('en-US')).toBeNull();
    expect(languageBlock('fr-CA', 'female')).toBeNull();
  });

  it('tells the agent its gender from the voice — «أنا موجود» from a woman was the 26 Oct slip', () => {
    expect(languageBlock('ar-SA', 'female')).toContain('أنا موجودة');
    expect(languageBlock('ar-SA', 'male')).toContain('أنا موجود،');
    expect(languageBlock('ar-SA', null)).not.toMatch(/You are a (woman|man)/);
  });

  it('asks for phone numbers digit by digit in words, never as one numeral', () => {
    expect(languageBlock('ar-AE')).toMatch(/one digit at a time, as words \(صفر، واحد/);
  });
});

describe('dialectSection', () => {
  it('asks the generation for the greeting and spoken lines in the dialect', () => {
    expect(dialectSection('ar-SA').join('\n')).toMatch(/Saudi Arabic.*not Modern Standard Arabic/s);
    expect(dialectSection('en-US')).toEqual([]);
  });

  it('reaches the feedback turn too', () => {
    const turn = buildFeedbackPrompt({
      brief: { services: [], faqs: [], handoff_rules: [], ai_disclosure: 'if_asked', documents: [] },
      prompt: 'You are Sara.',
      greeting: null,
      feedback: 'Be warmer.',
      primaryLanguage: 'ar-AE',
    });
    expect(turn).toContain('# Dialect');
    expect(turn).toContain('Emirati Arabic');
  });
});

describe('runtimePrompt with a language block', () => {
  const brief = { documents: [] };

  it('sits after the script and before the platform rules', () => {
    const out = runtimePrompt('You are Sara.', brief, null, languageBlock('ar-SA', 'female'));
    expect(out.indexOf('You are Sara.')).toBeLessThan(out.indexOf(LANGUAGE_BLOCK_HEADING));
    expect(out.indexOf(LANGUAGE_BLOCK_HEADING)).toBeLessThan(out.indexOf('## Platform rules (fixed)'));
  });

  it('is idempotent: a prompt that already carries the block gets one copy', () => {
    const block = languageBlock('ar-SA', 'female');
    const once = runtimePrompt('You are Sara.', brief, null, block);
    const twice = runtimePrompt(once, brief, null, block);
    expect(twice.split(LANGUAGE_BLOCK_HEADING)).toHaveLength(2);
    expect(stripLanguageBlock(once)).not.toContain(LANGUAGE_BLOCK_HEADING);
  });

  it('changes nothing for an agent without one', () => {
    expect(runtimePrompt('You are Sophie.', brief, null, null)).toBe(runtimePrompt('You are Sophie.', brief, null));
  });
});
