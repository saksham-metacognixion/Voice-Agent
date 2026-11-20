'use client';

import { UiLocaleProvider, type UiLabels } from '@portal/ui';
import { NextIntlClientProvider, useTranslations } from 'next-intl';
import * as React from 'react';
import { storage } from '../lib/storage';
import {
  DEFAULT_LOCALE, LOCALES, LOCALE_STORAGE_KEY, intlLocale, localeDirection, messages, resolveLocale, setActiveLocale, type Locale,
} from './index';

/**
 * The chosen language, read from the browser once and then held here. A tiny external
 * store rather than state so the static HTML (rendered in English) hydrates without a
 * mismatch: React renders the server snapshot first and the stored choice right after.
 */
const listeners = new Set<() => void>();
let current: Locale | null = null;

function read(): Locale {
  if (current === null) {
    const preferred = typeof navigator === 'undefined' ? [] : (navigator.languages ?? [navigator.language]);
    current = resolveLocale(storage.get(LOCALE_STORAGE_KEY), preferred);
  }
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab changed the language: follow it, the way the theme does.
  const onStorage = (e: StorageEvent) => {
    if (e.key === LOCALE_STORAGE_KEY) {
      current = null;
      listener();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** The language a non-React caller (the Auth0 redirect) should ask for. */
export function currentLocale(): Locale {
  return typeof window === 'undefined' ? DEFAULT_LOCALE : read();
}

export function setLocale(locale: Locale): void {
  storage.set(LOCALE_STORAGE_KEY, locale);
  current = locale;
  listeners.forEach((l) => l());
}

export function useLocaleChoice(): { locale: Locale; setLocale: (locale: Locale) => void; locales: readonly Locale[] } {
  const locale = React.useSyncExternalStore(subscribe, read, () => DEFAULT_LOCALE);
  return { locale, setLocale, locales: LOCALES };
}

/**
 * next-intl without i18n routing (the export has no `[locale]` segment), plus the writing
 * direction for <html> and for every Radix primitive. Switching re-renders in place — no
 * remount — so a half-filled form, the URL and its query survive a change of language.
 */
export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const { locale } = useLocaleChoice();
  const dir = localeDirection(locale);
  // Before any child renders, so `lib/format` formats in the language being rendered.
  setActiveLocale(locale);

  React.useLayoutEffect(() => {
    const html = document.documentElement;
    html.lang = locale;
    html.dir = dir;
  }, [locale, dir]);

  return (
    <NextIntlClientProvider locale={intlLocale(locale)} messages={messages[locale]} timeZone="UTC">
      <UiLabelsBridge dir={dir}>{children}</UiLabelsBridge>
    </NextIntlClientProvider>
  );
}

/** The shared components' own words (close, loading, theme…), from the catalogue. */
function UiLabelsBridge({ dir, children }: { dir: 'ltr' | 'rtl'; children: React.ReactNode }) {
  const t = useTranslations('common');
  const labels = React.useMemo<UiLabels>(
    () => ({
      close: t('close'),
      remove: t('remove'),
      loading: t('loading'),
      optional: t('optional'),
      progress: t('progress'),
      step: (n, total) => t('stepOf', { n, total }),
      theme: { light: t('theme.light'), dark: t('theme.dark'), system: t('theme.system'), toggle: t('theme.toggle') },
      audio: { play: t('play'), pause: t('pause'), unavailable: t('sampleUnavailable'), loading: t('loading') },
    }),
    [t],
  );
  return (
    <UiLocaleProvider dir={dir} labels={labels}>
      {children}
    </UiLocaleProvider>
  );
}
