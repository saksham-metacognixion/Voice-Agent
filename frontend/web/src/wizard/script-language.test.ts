import { describe, expect, it } from 'vitest';
import { scriptNeedsRewrite } from './script-language';

describe('scriptNeedsRewrite (ADR 0027)', () => {
  it('flags an English greeting on an agent switched to Arabic — the 26 Oct staging case', () => {
    expect(scriptNeedsRewrite('Thanks for calling Bright Smile Health, how can I help you today?', 'ar-SA')).toBe(true);
    expect(scriptNeedsRewrite('Hello, Bright Smile Health.', 'ar-AE')).toBe(true);
  });

  it('accepts an Arabic greeting, business name in Latin letters included', () => {
    expect(scriptNeedsRewrite('هلا والله، معك سارة من Bright Smile Health، كيف أقدر أساعدك؟', 'ar-SA')).toBe(false);
  });

  it('flags an Arabic greeting on an agent switched back to English', () => {
    expect(scriptNeedsRewrite('هلا والله، كيف أقدر أساعدك؟', 'en-US')).toBe(true);
  });

  it('does not guess between two Latin-script languages, and says nothing without a greeting', () => {
    expect(scriptNeedsRewrite('Hello, how can I help?', 'fr-CA')).toBe(false);
    expect(scriptNeedsRewrite(null, 'ar-SA')).toBe(false);
    expect(scriptNeedsRewrite('  ', 'ar-SA')).toBe(false);
  });
});
