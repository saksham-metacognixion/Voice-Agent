import { retellLanguage, type RetellLanguage } from '@portal/schemas';

export const LANGUAGES: RetellLanguage[] = retellLanguage.options;

/** Sensible top of the list for a Canadian/US launch; the rest alphabetical by name. */
const PREFERRED: RetellLanguage[] = ['en-US', 'en-GB', 'en-AU', 'en-IN', 'fr-CA', 'fr-FR', 'es-419', 'es-ES', 'pt-BR', 'hi-IN', 'zh-CN', 'de-DE'];

let names: Intl.DisplayNames | null | undefined;
function displayNames(): Intl.DisplayNames | null {
  if (names !== undefined) return names;
  try {
    names = new Intl.DisplayNames(['en'], { type: 'language' });
  } catch {
    names = null;
  }
  return names;
}

export function languageName(code: string): string {
  const n = displayNames()?.of(code);
  return n && n !== code ? n : code;
}

export function sortedLanguages(): RetellLanguage[] {
  const rest = LANGUAGES.filter((l) => !PREFERRED.includes(l)).sort((a, b) => languageName(a).localeCompare(languageName(b)));
  return [...PREFERRED, ...rest];
}

/** `en-US` → `en`, for the voices `lang` filter (matched on prefix). */
export function baseLanguage(code: string): string {
  return code.split('-')[0]!;
}
