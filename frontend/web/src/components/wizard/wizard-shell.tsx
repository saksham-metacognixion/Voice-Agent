'use client';

import { Button, Logo, Stepper, ThemeToggle } from '@portal/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { BalancePill } from '@/src/components/shell/balance-pill';
import { UserMenu } from '@/src/components/shell/user-menu';
import { LAST_IMPLEMENTED_STEP, ONBOARDING_STEPS, routes } from '@/src/routes';
import { useWorkspace } from '@/src/workspace/workspace-provider';

/** The §8 wizard frame: logo, stepper, balance, account. Pages render inside. */
export function WizardShell({ children }: { children: React.ReactNode }) {
  const t = useTranslations();
  const pathname = usePathname();
  const ws = useWorkspace();
  const current = Math.max(0, ONBOARDING_STEPS.findIndex((s) => pathname.startsWith(s.path.replace(/\/$/, ''))));
  const reached = ws.workspace?.onboarding_step ?? 1;
  const canExit = Boolean(ws.workspace?.onboarding_completed_at) || reached > LAST_IMPLEMENTED_STEP;
  const themeLabels = { light: t('common.theme.light'), dark: t('common.theme.dark'), system: t('common.theme.system'), toggle: t('common.theme.toggle') };

  React.useEffect(() => {
    const step = ONBOARDING_STEPS[current];
    if (step) track('onboarding_step_viewed', { step: step.key, step_no: step.step });
  }, [current]);

  const steps = ONBOARDING_STEPS.map((s) => ({ key: s.key, label: t(`wizard.steps.${s.key}`), href: s.step <= reached ? s.path : undefined }));

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-4 px-4 sm:px-6">
          <Logo variant="mark" />
          <div className="min-w-0 flex-1">
            <Stepper
              steps={steps}
              current={current}
              stepLabel={(n, total) => t('common.stepOf', { n, total })}
              renderLink={(step, children, className) => (
                <Link href={step.href!} className={className}>
                  {children}
                </Link>
              )}
            />
          </div>
          <div className="flex items-center gap-1 sm:gap-2">
            <BalancePill className="hidden md:inline-flex" />
            {canExit ? (
              <Button variant="ghost" size="sm" asChild className="hidden sm:inline-flex">
                <Link href={routes.app.home}>{t('wizard.exit')}</Link>
              </Button>
            ) : null}
            <ThemeToggle labels={themeLabels} />
            <UserMenu />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}

export function WizardHeading({ title, subtitle, aside }: { title: React.ReactNode; subtitle?: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
        {subtitle ? <p className="mt-2 text-sm text-muted-foreground sm:text-base">{subtitle}</p> : null}
      </div>
      {aside}
    </div>
  );
}
