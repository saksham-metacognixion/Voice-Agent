/**
 * What language does a voice sound native in?
 *
 * The catalogue has no answer. `list-voices` returns `voice_id`, `voice_name`, `provider`,
 * `gender`, `age`, `accent` and a preview clip, and nothing else — verified against the
 * live payload in `test/fixtures/retell/api/list-voices.json` and against all 302 rows
 * currently cached. So every row arrived with `languages: []`, which the cache read as
 * "speaks everything", which made `is_multilingual` true for every voice, which made
 * `GET /voices?lang=` match all of them. W3's "Main language" therefore changed the query
 * string and nothing else: the same 302 voices came back for `fr-CA` as for `en-US`.
 *
 * The accent is the signal that is actually there, and it is the one the customer hears.
 * A voice labelled `French` is a voice that sounds French; the stack behind it will happily
 * read `fr-CA` text in any of the others' accents. So accent → locales is the native
 * language, `native` is a ranking, and no voice is hidden for it unless the customer asks.
 */

/**
 * Accent → the locales it sounds native in. Keys are the accents the catalogue actually
 * uses (lower-cased); an accent we do not know maps to nothing, which reads as "we cannot
 * say" and is treated as multilingual rather than as a wrong claim.
 */
const ACCENT_LANGUAGES: Record<string, string[]> = {
  american: ['en-US'],
  'southern american': ['en-US'],
  british: ['en-GB'],
  english: ['en-GB'],
  irish: ['en-IE'],
  scottish: ['en-GB'],
  australian: ['en-AU'],
  canadian: ['en-CA'],
  indian: ['en-IN', 'hi-IN'],
  filipino: ['en-PH'],
  'south african': ['en-ZA'],
  french: ['fr-FR', 'fr-CA'],
  'canadian french': ['fr-CA'],
  quebecois: ['fr-CA'],
  spanish: ['es-ES'],
  mexican: ['es-MX'],
  'latin american': ['es-419'],
  argentinian: ['es-AR'],
  colombian: ['es-CO'],
  brazilian: ['pt-BR'],
  portuguese: ['pt-PT'],
  german: ['de-DE'],
  austrian: ['de-DE'],
  swiss: ['de-DE'],
  italian: ['it-IT'],
  dutch: ['nl-NL'],
  belgian: ['nl-BE'],
  polish: ['pl-PL'],
  russian: ['ru-RU'],
  ukrainian: ['uk-UA'],
  turkish: ['tr-TR'],
  arabic: ['ar-SA'],
  // ADR 0027: the curated Gulf voices (`curated-voices.ts`). `ar-AE` is our locale, not the
  // platform's; a Saudi voice still ranks as Arabic for an Emirati agent, below Emirati ones.
  saudi: ['ar-SA'],
  emirati: ['ar-AE'],
  gulf: ['ar-SA', 'ar-AE'],
  khaleeji: ['ar-SA', 'ar-AE'],
  hebrew: ['he-IL'],
  chinese: ['zh-CN'],
  mandarin: ['zh-CN'],
  cantonese: ['yue-CN'],
  japanese: ['ja-JP'],
  korean: ['ko-KR'],
  vietnamese: ['vi-VN'],
  thai: ['th-TH'],
  indonesian: ['id-ID'],
  malay: ['ms-MY'],
  swedish: ['sv-SE'],
  norwegian: ['no-NO'],
  danish: ['da-DK'],
  finnish: ['fi-FI'],
  greek: ['el-GR'],
  romanian: ['ro-RO'],
  czech: ['cs-CZ'],
  hungarian: ['hu-HU'],
  bulgarian: ['bg-BG'],
  nigerian: ['en-NG'],
  kenyan: ['sw-KE'],
};

/**
 * The locales a voice sounds native in.
 *
 * A catalogue that ever starts sending languages wins — this only fills the silence.
 * `accent` is free text from the provider, so it is normalised before the lookup and an
 * unknown one yields `[]`.
 */
export function nativeLanguages(row: { languages?: string[] | null; accent?: string | null }): string[] {
  if (row.languages && row.languages.length > 0) return row.languages;
  const accent = row.accent?.trim().toLowerCase();
  if (!accent) return [];
  return ACCENT_LANGUAGES[accent] ?? ACCENT_LANGUAGES[accent.replace(/\s+accent$/, '')] ?? [];
}

/**
 * True when we cannot name one native language for this voice: either the accent is one
 * we do not have a locale for, or it covers more than one (an Indian voice reads English
 * and Hindi natively). It is *not* "this voice can speak other languages" — they all can,
 * which is why that reading made the badge appear on all 302 cards and mean nothing.
 */
export function isMultilingualFrom(languages: string[]): boolean {
  return languages.length !== 1;
}

/**
 * Does `available` satisfy `wanted`? Compared on the **base subtag**, so `fr-FR` answers a
 * request for `fr-CA` and `en-GB` answers `en-US`.
 *
 * The old rule was exact-or-prefix, which meant a customer asking for `fr-CA` matched no
 * French voice at all — `fr-FR` is neither `fr-CA` nor a prefix of it. Everything still
 * came back only because every voice was flagged multilingual.
 */
export function languageMatches(available: string, wanted: string): boolean {
  return baseLanguage(available) === baseLanguage(wanted);
}

/** Exactly the same locale, case-insensitive: `fr-CA` for a `fr-CA` request. */
export function localeMatches(available: string, wanted: string): boolean {
  return available.toLowerCase() === wanted.toLowerCase();
}

/** `en-US` → `en`. */
export function baseLanguage(code: string): string {
  return code.toLowerCase().split('-')[0] ?? code.toLowerCase();
}

/**
 * How well a voice answers a request for `wanted`, high is better:
 *   2  the same locale — a `fr-CA` voice for a `fr-CA` agent
 *   1  the same language in another accent — a Paris voice for a Quebec agent
 *   0  a different language, or an accent we could not place at all; it will still read
 *      the text, in whatever accent it has
 *
 * Rank ≥ 1 is exactly what the response calls `native`, so an accent we cannot place is
 * never *presented* as native — saying so of a voice we know nothing about would be the
 * same empty claim the `is_multilingual`-on-everything bug made.
 */
export function languageRank(languages: string[], wanted: string | undefined): number {
  if (!wanted || languages.length === 0) return 0;
  if (languages.some((language) => localeMatches(language, wanted))) return 2;
  return languages.some((language) => languageMatches(language, wanted)) ? 1 : 0;
}
