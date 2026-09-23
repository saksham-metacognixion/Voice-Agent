'use client';

import { Logo, ThemeToggle } from '@portal/ui';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import * as React from 'react';
import { routes } from '@/src/routes';

/**
 * The frame every A-screen sits in: brand panel on the left (hidden on phones), the card on
 * the right. Both themes come from the tokens; the brand panel uses the primary colour at
 * low opacity so it reads as a tint in light and a glow in dark.
 */
export function AuthLayout({ children, title, subtitle, footer }: { children: React.ReactNode; title: React.ReactNode; subtitle?: React.ReactNode; footer?: React.ReactNode }) {
  const t = useTranslations();
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-sidebar p-10 lg:flex" aria-hidden>
        <div className="pointer-events-none absolute -left-32 -top-32 size-[28rem] rounded-full bg-primary/15 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-40 right-0 size-[24rem] rounded-full bg-accent blur-3xl" />
        <Logo variant="full" size="xl" className="relative" />
        <div className="relative max-w-md">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">{t('auth.brandKicker')}</p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight text-foreground">{t('auth.brand')}</h2>
          <ul className="mt-6 space-y-3 text-sm text-muted-foreground">
            {(['one', 'two', 'three'] as const).map((k) => (
              <li key={k} className="flex gap-3">
                <span className="mt-2 size-1.5 shrink-0 rounded-full bg-primary" />
                {t(`auth.brandPoints.${k}`)}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-muted-foreground">© {new Date().getFullYear()} {t('common.appName')}</p>
      </aside>

      <main className="flex flex-col">
        <div className="flex items-center justify-between p-4 lg:justify-end">
          <Link href={routes.root} className="lg:hidden">
            <Logo />
          </Link>
          <ThemeToggle labels={{ light: t('common.theme.light'), dark: t('common.theme.dark'), system: t('common.theme.system'), toggle: t('common.theme.toggle') }} />
        </div>
        <div className="flex flex-1 items-center justify-center px-4 pb-12">
          <div className="w-full max-w-md">
            <div className="rounded-xl border border-border bg-card p-6 shadow-card sm:p-8">
              <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
              {subtitle ? <p className="mt-1.5 text-sm text-muted-foreground">{subtitle}</p> : null}
              <div className="mt-6">{children}</div>
            </div>
            {footer ? <div className="mt-4 text-center text-sm text-muted-foreground">{footer}</div> : null}
          </div>
        </div>
      </main>
    </div>
  );
}
