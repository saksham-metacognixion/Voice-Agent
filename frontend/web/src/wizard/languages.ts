import { retellLanguage, type RetellLanguage } from '@portal/schemas';
import { activeIntlLocale } from '../i18n';

export const LANGUAGES: RetellLanguage[] = retellLanguage.options;

/** Sensible top of the list for a Canadian/US launch; the rest alphabetical by name. */
const PREFERRED: RetellLanguage[] = ['en-US', 'en-GB', 'en-AU', 'en-IN', 'fr-CA', 'fr-FR', 'es-419', 'es-ES', 'pt-BR', 'hi-IN', 'zh-CN', 'de-DE'];

/** One `Intl.DisplayNames` per portal language: the list reads "French (Canada)" or "الفرنسية (كندا)". */
const names = new Map<string, Intl.DisplayNames | null>();
function displayNames(): Intl.DisplayNames | null {
  const locale = activeIntlLocale();
  if (!names.has(locale)) {
    try {
      names.set(locale, new Intl.DisplayNames([locale, 'en'], { type: 'language' }));
    } catch {
      names.set(locale, null);
    }
  }
  return names.get(locale) ?? null;
}

export function languageName(code: string): string {
  const n = displayNames()?.of(code);
  return n && n !== code ? n : code;
}

export function sortedLanguages(): RetellLanguage[] {
  const rest = LANGUAGES.filter((l) => !PREFERRED.includes(l)).sort((a, b) => languageName(a).localeCompare(languageName(b), activeIntlLocale()));
  return [...PREFERRED, ...rest];
}

/** `en-US` → `en`, for the voices `lang` filter (matched on prefix). */
export function baseLanguage(code: string): string {
  return code.split('-')[0]!;
}

/** W3's language choice as one value, so a change is one `PATCH /agents/:id/draft`. */
export interface LanguageChoice {
  primary_language: RetellLanguage;
  languages: RetellLanguage[];
}

/**
 * `code` becomes the main language. If it was one of the "also speaks" languages it leaves
 * that list in the same change — one save carrying both, never two racing saves where the
 * second could put the old main language back (QA-011).
 */
export function choosePrimary(code: RetellLanguage, languages: RetellLanguage[]): LanguageChoice {
  return { primary_language: code, languages: languages.filter((l) => l !== code) };
}
