'use client';

import {
  Button, DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger, cn,
} from '@portal/ui';
import { Languages } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { track } from '@/src/analytics/posthog';
import { LOCALE_NAMES, isLocale, type Locale } from '@/src/i18n';
import { useLocaleChoice } from '@/src/i18n/locale-provider';

/**
 * English / العربية. The choice is per browser (localStorage, like the theme) and applies in
 * place: no navigation, so the URL, its query and anything typed into a form are kept.
 * Each language is named in itself, so a reader who cannot read the current one can still
 * find their own.
 */
function useSwitch() {
  const { locale, setLocale, locales } = useLocaleChoice();
  const choose = (value: string) => {
    if (!isLocale(value) || value === locale) return;
    track('language_changed', { from: locale, to: value });
    setLocale(value);
  };
  return { locale, locales, choose };
}

/** Icon button + menu, for the headers that carry the theme toggle. */
export function LanguageMenu({ className }: { className?: string }) {
  const t = useTranslations('common');
  const { locale, locales, choose } = useSwitch();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className={className} aria-label={t('changeLanguage')}>
          <Languages aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[9rem]">
        <DropdownMenuRadioGroup value={locale} onValueChange={choose}>
          {locales.map((l) => (
            <DropdownMenuRadioItem key={l} value={l} lang={l} dir={l === 'ar' ? 'rtl' : 'ltr'}>
              {LOCALE_NAMES[l]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Inline segmented control, for Settings and the user menu (the `ThemeSegment` shape). */
export function LanguageSegment({ className }: { className?: string }) {
  const t = useTranslations('common');
  const { locale, locales, choose } = useSwitch();
  return (
    <div role="radiogroup" aria-label={t('language')} className={cn('inline-flex rounded-md border border-border bg-muted p-0.5', className)}>
      {locales.map((l: Locale) => (
        <button
          key={l}
          type="button"
          role="radio"
          lang={l}
          aria-checked={locale === l}
          onClick={() => choose(l)}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-[5px] px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors',
            locale === l && 'bg-card text-foreground shadow-card',
          )}
        >
          {LOCALE_NAMES[l]}
        </button>
      ))}
    </div>
  );
}
