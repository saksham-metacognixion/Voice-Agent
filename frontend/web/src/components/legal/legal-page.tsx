'use client';

import { TERMS_VERSION } from '@portal/schemas';
import { Alert, Logo, ThemeToggle } from '@portal/ui';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import * as React from 'react';
import { LanguageMenu } from '@/src/components/shell/language-switcher';
import { config } from '@/src/config';
import type { LegalDocument } from '@/src/legal/documents';
import { routes } from '@/src/routes';
import { LegalSections } from './legal-sections';

/**
 * The frame for `/legal/terms/` and `/legal/privacy/`: public, outside every guard, read
 * by someone who has not accepted the Terms yet (A1 shows them in `LegalDialog` and offers
 * this page in a new tab) or by nobody signed in at all. One reading column; the section numbers carry the brand
 * purple, the only accent on the page. The document itself is English and says so, so
 * the article is pinned `lang="en" dir="ltr"` while the chrome follows the portal's
 * language.
 */
export function LegalPage({ document }: { document: LegalDocument }) {
  const t = useTranslations('legal');
  const tc = useTranslations('common');
  const locale = useLocale();
  const other = document.id === 'terms' ? 'privacy' : 'terms';

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="mx-auto flex w-full max-w-3xl items-center justify-between px-4 py-4">
        <Link href={routes.root} className="rounded-md">
          <Logo />
        </Link>
        <div className="flex items-center gap-1">
          <LanguageMenu />
          <ThemeToggle
            labels={{
              light: tc('theme.light'),
              dark: tc('theme.dark'),
              system: tc('theme.system'),
              toggle: tc('theme.toggle'),
            }}
          />
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-16 pt-6 sm:pt-10">
        <h1 className="text-3xl font-semibold tracking-tight">{t(`title.${document.id}`)}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t('version', { version: TERMS_VERSION })}</p>

        <Alert variant="warning" className="mt-6">
          {t('draft')}
        </Alert>
        {locale !== 'en' ? <p className="mt-3 text-sm text-muted-foreground">{t('englishOnly')}</p> : null}

        <nav aria-label={t('contents')} className="mt-8 rounded-lg border border-border bg-card p-4 sm:p-5">
          <p className="text-sm font-medium">{t('contents')}</p>
          <ol className="mt-2 columns-1 gap-x-8 text-sm sm:columns-2" lang="en" dir="ltr">
            {document.sections.map((section, i) => (
              <li key={section.heading} className="break-inside-avoid">
                <a
                  href={`#section-${i + 1}`}
                  className="flex min-h-11 items-center gap-2 rounded-sm py-1 text-foreground hover:text-primary hover:underline"
                >
                  <span className="w-5 shrink-0 tabular-nums text-primary">{i + 1}</span>
                  {section.heading}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <LegalSections document={document} anchored className="mt-10" />

        <footer className="mt-14 flex flex-col gap-3 border-t border-border pt-6 text-sm">
          <Link href={routes.legal[other]} className="flex min-h-11 w-fit items-center py-1 font-medium text-primary hover:underline">
            {t(`read.${other}`)}
          </Link>
          <p className="text-muted-foreground">
            {t('questions')}{' '}
            <a href={`mailto:${config.support.email}`} className="font-medium text-primary hover:underline" dir="ltr">
              {config.support.email}
            </a>
          </p>
        </footer>
      </main>
    </div>
  );
}
