import { ApiError, AuthRequiredError } from '@portal/api-client';
import { createTranslator } from 'next-intl';
import { afterEach, describe, expect, it } from 'vitest';
import { messages, setActiveLocale, type Locale } from '../i18n';
import { errorMessage } from './errors';

function translator(locale: Locale) {
  setActiveLocale(locale);
  const t = createTranslator({ locale, messages: messages[locale], onError: () => {}, getMessageFallback: ({ key, namespace }) => (namespace ? `${namespace}.${key}` : key) });
  return t as unknown as (key: string, values?: Record<string, string | number>) => string;
}

const api = (code: string, message = `server says ${code}`) => new ApiError(409, { code, message });

afterEach(() => setActiveLocale('en'));

describe('errorMessage', () => {
  it('gives each agent-state code its own line, distinct from the brief one (QA-021)', () => {
    const t = translator('en');
    const brief = errorMessage(api('BRIEF_INCOMPLETE'), t);
    const lines = ['AGENT_NOT_GENERATED', 'AGENT_NOT_PUBLISHED', 'VERSION_SYNCING'].map((code) => errorMessage(api(code), t));
    expect(brief).toBe(messages.en.errors.BRIEF_INCOMPLETE);
    expect(lines).toEqual([messages.en.errors.AGENT_NOT_GENERATED, messages.en.errors.AGENT_NOT_PUBLISHED, messages.en.errors.VERSION_SYNCING]);
    expect(new Set([brief, ...lines]).size).toBe(4);
  });

  it('answers in Arabic for the same codes', () => {
    const t = translator('ar');
    for (const code of ['BRIEF_INCOMPLETE', 'AGENT_NOT_GENERATED', 'AGENT_NOT_PUBLISHED', 'VERSION_SYNCING'] as const) {
      expect(errorMessage(api(code), t)).toBe(messages.ar.errors[code]);
    }
  });

  it('falls back to the server sentence in English and to the generic line elsewhere for an unknown code', () => {
    expect(errorMessage(api('SOMETHING_NEW', 'A brand new refusal.'), translator('en'))).toBe('A brand new refusal.');
    expect(errorMessage(api('SOMETHING_NEW', 'A brand new refusal.'), translator('ar'))).toBe(messages.ar.errors.default);
    expect(errorMessage(api('SOMETHING_NEW', ''), translator('en'))).toBe(messages.en.errors.default);
  });

  it('never reads a non-code key under errors. as a line', () => {
    const t = translator('en');
    expect(errorMessage(api('title', 'Server text.'), t)).toBe('Server text.');
    expect(errorMessage(api('serverReasons', 'Server text.'), t)).toBe('Server text.');
  });

  it('says the session ended for a lost session', () => {
    expect(errorMessage(new AuthRequiredError(), translator('en'))).toBe(messages.en.errors.UNAUTHENTICATED);
  });
});
