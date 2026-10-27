import ar from './messages/ar.json';
import en from './messages/en.json';
import frCA from './messages/fr-CA.json';

export type Messages = typeof en;

/**
 * The portal's languages. There is no locale in the URL: the export is static, with no
 * middleware and no dynamic segments (ADR 0017), so the choice lives in the browser
 * (`LOCALE_STORAGE_KEY`) and the pre-paint script below applies it before first paint.
 * French is Canadian French and keeps its region in the id: it is also the `ui_locales`
 * Auth0 is asked for and the tag on <html>, and Auth0 knows `fr-CA` (ADR 0030).
 */
export const LOCALES = ['en', 'ar', 'fr-CA'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALE_STORAGE_KEY = 'portal:locale';

export const messages: Record<Locale, Messages> = { en, ar, 'fr-CA': frCA };

/** Each language named in itself, for the switcher — never translated. */
export const LOCALE_NAMES: Record<Locale, string> = { en: 'English', ar: 'العربية', 'fr-CA': 'Français' };

const RTL: ReadonlySet<Locale> = new Set<Locale>(['ar']);

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

export function localeDirection(locale: Locale): 'ltr' | 'rtl' {
  return RTL.has(locale) ? 'rtl' : 'ltr';
}

/**
 * The tag handed to `Intl` and next-intl. Arabic keeps Western digits (`nu-latn`): credits,
 * prices and phone numbers sit side by side on every page, and E.164 numbers are Latin.
 */
export function intlLocale(locale: Locale): string {
  return locale === 'ar' ? 'ar-u-nu-latn' : locale;
}

/**
 * The portal language for a BCP 47 tag: the same tag, else the same base language
 * (`fr-FR` reads the Canadian catalogue, `ar-AE` the Arabic one), else null.
 */
export function matchLocale(tag: string): Locale | null {
  const lower = tag.toLowerCase();
  const base = lower.split('-')[0];
  return LOCALES.find((l) => l.toLowerCase() === lower) ?? LOCALES.find((l) => l.toLowerCase().split('-')[0] === base) ?? null;
}

/** A stored choice, else the browser's first language we have, else English. */
export function resolveLocale(stored: string | null, preferred: readonly string[]): Locale {
  if (isLocale(stored)) return stored;
  for (const tag of preferred) {
    const match = matchLocale(tag);
    if (match) return match;
  }
  return DEFAULT_LOCALE;
}

/**
 * Runs in <head> before the page paints, so a right-to-left reader never sees the page
 * laid out left to right first. Mirrors `resolveLocale`; kept as a string because it runs
 * before any bundle has loaded.
 */
export const localeBootScript = `(function(){try{var l=null;try{l=localStorage.getItem(${JSON.stringify(LOCALE_STORAGE_KEY)})}catch(e){}var s=${JSON.stringify(LOCALES)};if(s.indexOf(l)<0){l=${JSON.stringify(DEFAULT_LOCALE)};var p=navigator.languages||[navigator.language||''];for(var i=0;i<p.length;i++){var t=String(p[i]).toLowerCase(),b=t.split('-')[0],m=null;for(var j=0;j<s.length;j++){var c=s[j].toLowerCase();if(c===t){m=s[j];break}if(!m&&c.split('-')[0]===b)m=s[j]}if(m){l=m;break}}}var d=document.documentElement;d.lang=l;d.dir=${JSON.stringify([...RTL])}.indexOf(l)>=0?'rtl':'ltr'}catch(e){}})();`;

/**
 * The language the page is rendering in, for code that formats outside React (`lib/format`,
 * `lib/errors`). `LocaleProvider` sets it while it renders, before any child formats.
 */
let active: Locale = DEFAULT_LOCALE;
export function activeLocale(): Locale {
  return active;
}
export function setActiveLocale(locale: Locale): void {
  active = locale;
}
/** `intlLocale(activeLocale())`, for `Intl.*` constructors. */
export function activeIntlLocale(): string {
  return intlLocale(active);
}
