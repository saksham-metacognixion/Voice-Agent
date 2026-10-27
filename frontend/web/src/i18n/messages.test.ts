import { createTranslator } from 'next-intl';
import { afterEach, describe, expect, it } from 'vitest';
import { formatCreditsValue, formatPhone } from '../lib/format';
import { LOCALES, intlLocale, localeBootScript, localeDirection, matchLocale, messages, resolveLocale, setActiveLocale } from './index';

type Tree = { [key: string]: Tree | string | string[] };

/** Every leaf as `path → string`; arrays (step lists) count element by element. */
function leaves(tree: Tree | string | string[], path = ''): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof tree === 'string') out.set(path, tree);
  else if (Array.isArray(tree)) tree.forEach((v, i) => out.set(`${path}.${i}`, v));
  else for (const [k, v] of Object.entries(tree)) for (const [p, s] of leaves(v, path ? `${path}.${k}` : k)) out.set(p, s);
  return out;
}

const argNames = (s: string) => [...new Set([...s.matchAll(/\{\s*([A-Za-z0-9_]+)\s*[,}]/g)].map((m) => m[1]!))].sort();
const tagNames = (s: string) => [...new Set([...s.matchAll(/<\/?([A-Za-z0-9_]+)>/g)].map((m) => m[1]!))].sort();

const en = leaves(messages.en as unknown as Tree);

describe.each(LOCALES)('the %s catalogue, ICU quoting', (locale) => {
  // In ICU MessageFormat a straight apostrophe before `{` or `}` opens a quoted literal, so
  // "l'{name}" prints "{name}" — no error, no missing placeholder, just a wrong sentence.
  // Write the typographic ’ instead (or '' for a literal apostrophe).
  it('has no apostrophe that would quote a placeholder', () => {
    const lines = leaves(messages[locale] as unknown as Tree);
    expect([...lines].filter(([, s]) => /(^|[^'])'[{}]/.test(s)).map(([k]) => k)).toEqual([]);
  });
});

describe.each(LOCALES.filter((l) => l !== 'en'))('the %s catalogue', (locale) => {
  const other = leaves(messages[locale] as unknown as Tree);

  it('has exactly the English keys', () => {
    expect([...other.keys()].filter((k) => !en.has(k))).toEqual([]);
    expect([...en.keys()].filter((k) => !other.has(k))).toEqual([]);
  });

  it('keeps every placeholder and rich-text tag of the English line', () => {
    const wrong = [...en].filter(([k, s]) => {
      const o = other.get(k) ?? '';
      return argNames(s).join() !== argNames(o).join() || tagNames(s).join() !== tagNames(o).join();
    });
    expect(wrong.map(([k]) => k)).toEqual([]);
  });

  it('translates every non-empty line', () => {
    expect([...en].filter(([k, s]) => s.trim() !== '' && !(other.get(k) ?? '').trim()).map(([k]) => k)).toEqual([]);
  });

  it('formats every line in its own plural rules without an error', () => {
    const errors: string[] = [];
    const t = createTranslator({ locale: intlLocale(locale), messages: messages[locale], onError: (e) => errors.push(e.message) });
    for (const [key, s] of other) {
      if (/\.\d+$/.test(key)) continue; // array elements are read with t.raw
      const values: Record<string, unknown> = {};
      for (const a of argNames(s)) values[a] = 3;
      for (const tag of tagNames(s)) values[tag] = (chunks: string) => chunks;
      for (const n of [0, 1, 2, 3, 11, 100]) {
        for (const a of argNames(s)) values[a] = n;
        t.markup(key as never, values as never);
      }
    }
    expect(errors).toEqual([]);
  });

  it('never names the voice platform', () => {
    expect([...other].filter(([, s]) => /retell/i.test(s)).map(([k]) => k)).toEqual([]);
  });
});

describe('locale resolution', () => {
  it('prefers a stored choice, then the browser, then English', () => {
    expect(resolveLocale('ar', ['en-US'])).toBe('ar');
    expect(resolveLocale(null, ['ar-SA', 'en'])).toBe('ar');
    expect(resolveLocale('xx', ['de-DE', 'en-GB'])).toBe('en');
    expect(resolveLocale(null, [])).toBe('en');
  });

  it('reads Canadian French for any French browser, and only an exact stored id', () => {
    expect(resolveLocale(null, ['fr-CA', 'en'])).toBe('fr-CA');
    expect(resolveLocale(null, ['fr-FR'])).toBe('fr-CA');
    expect(resolveLocale(null, ['FR'])).toBe('fr-CA');
    expect(resolveLocale('fr-CA', ['en-US'])).toBe('fr-CA');
    expect(resolveLocale('fr', ['en-US'])).toBe('en');
    expect(matchLocale('ar-AE')).toBe('ar');
    expect(matchLocale('es-ES')).toBeNull();
  });

  it('writes Arabic right to left with Western digits', () => {
    expect(localeDirection('ar')).toBe('rtl');
    expect(localeDirection('en')).toBe('ltr');
    expect(localeDirection('fr-CA')).toBe('ltr');
    expect(intlLocale('ar')).toBe('ar-u-nu-latn');
  });

  it('ships a boot script that sets lang and dir before paint', () => {
    const html = { lang: '', dir: '' };
    const run = new Function('localStorage', 'navigator', 'document', localeBootScript);
    run({ getItem: () => 'ar' }, { languages: ['en-US'] }, { documentElement: html });
    expect(html).toEqual({ lang: 'ar', dir: 'rtl' });
    run({ getItem: () => null }, { languages: ['fr-FR', 'en'] }, { documentElement: html });
    expect(html).toEqual({ lang: 'fr-CA', dir: 'ltr' });
    run({ getItem: () => null }, { languages: ['de-DE'] }, { documentElement: html });
    expect(html).toEqual({ lang: 'en', dir: 'ltr' });
  });
});

describe('formatting follows the portal language', () => {
  afterEach(() => setActiveLocale('en'));

  it('isolates a phone number left to right in Arabic only', () => {
    expect(formatPhone('+14165550100')).toBe('+1 416 555 0100');
    setActiveLocale('ar');
    expect(formatPhone('+14165550100')).toBe('⁦+1 416 555 0100⁩');
  });

  it('keeps Western digits in Arabic', () => {
    setActiveLocale('ar');
    expect(formatCreditsValue(1234.5)).toMatch(/^1[,٬]?234[.٫]5$/);
  });
});
