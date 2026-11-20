'use client';

import { useApi, useDismissOnboarding } from '@portal/api-client';
import { Button, Logo, Stepper, ThemeToggle, cn, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, LogOut } from 'lucide-react';
import { LanguageMenu } from '@/src/components/shell/language-switcher';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { BalancePill } from '@/src/components/shell/balance-pill';
import { MfaBanner } from '@/src/components/shell/mfa-banner';
import { UserMenu } from '@/src/components/shell/user-menu';
import { WorkspaceSwitcher } from '@/src/components/shell/workspace-switcher';
import { WizardExitProvider } from '@/src/components/wizard/wizard-exit';
import { errorMessage } from '@/src/lib/errors';
import { WIZARD_STEPPER, routes } from '@/src/routes';
import { useWorkspace } from '@/src/workspace/workspace-provider';

/**
 * The §8 wizard frame: logo, workspace, stepper, balance, "Save and exit", account.
 * Pages render inside and put their Back and Continue in a `WizardFooter`.
 *
 * "Save and exit" (§7.3) is on every step: the page's pending save is flushed first
 * (`WizardExitProvider`), the §6.4 dismissal is recorded, and the dashboard opens with
 * its "Finish setup" card (ADR 0039). A workspace that has already finished, or already
 * dismissed, just goes to the dashboard.
 *
 * The workspace switcher is the dashboard's own (QA-013): someone with two workspaces can
 * leave a half-built agent in one and carry on in the other without finishing the wizard.
 * The account menu offers the same switch, so it is one tap away on a phone as well.
 */
export function WizardShell({ children }: { children: React.ReactNode }) {
  const t = useTranslations();
  const pathname = usePathname();
  const router = useRouter();
  const api = useApi();
  const queryClient = useQueryClient();
  const ws = useWorkspace();
  const dismiss = useDismissOnboarding(api);
  // `/onboarding/live` is past the last step: every dot shows as done.
  const onLive = pathname.startsWith(routes.onboarding.live.replace(/\/$/, ''));
  const current = onLive ? WIZARD_STEPPER.length : Math.max(0, WIZARD_STEPPER.findIndex((s) => pathname.startsWith(s.path.replace(/\/$/, ''))));
  const reached = ws.workspace?.onboarding_step ?? 1;
  const complete = Boolean(ws.workspace?.onboarding_completed_at);
  const dismissed = Boolean(ws.workspace?.onboarding_dismissed_at);
  const themeLabels = { light: t('common.theme.light'), dark: t('common.theme.dark'), system: t('common.theme.system'), toggle: t('common.theme.toggle') };
  const [exit, setExit] = React.useState<{ run: () => Promise<void>; busy: boolean }>({ run: async () => undefined, busy: false });
  const [leaving, setLeaving] = React.useState(false);

  React.useEffect(() => {
    const step = WIZARD_STEPPER[current];
    if (step) track('onboarding_step_viewed', { step: step.key, step_no: step.step });
  }, [current]);

  async function saveAndExit() {
    if (leaving) return;
    setLeaving(true);
    try {
      await exit.run();
      if (!complete && !dismissed) {
        await dismiss.mutateAsync({ body: {} });
        await queryClient.invalidateQueries({ queryKey: ['getWorkspace'] });
      }
      track('onboarding_exited', { step: WIZARD_STEPPER[current]?.key ?? null, step_no: WIZARD_STEPPER[current]?.step ?? null });
      router.push(routes.app.home);
    } catch (e) {
      toast.error(errorMessage(e, t));
      setLeaving(false);
    }
  }

  // Knowledge (no step number) opens once the agent is live; a finished wizard's numbered
  // steps are the dashboard's to edit, so they stay done but unlinked, as their guards say.
  const steps = WIZARD_STEPPER.map((s) => ({
    key: s.key,
    label: t(`wizard.steps.${s.key}`),
    href: s.step === null ? (complete ? s.path : undefined) : !complete && s.step <= reached ? s.path : undefined,
  }));

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-2 px-4 sm:gap-4 sm:px-6">
          <Logo variant="mark" />
          <WorkspaceSwitcher compact className="shrink-0 md:max-w-[14rem]" />
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
            {/* §7.3 "Save & exit top-right". Below `sm` it is an icon with the label read out. */}
            <Button variant="ghost" size="sm" className="h-11 w-11 px-0 sm:h-8 sm:w-auto sm:px-3" onClick={() => void saveAndExit()} loading={leaving || exit.busy} disabled={leaving} data-testid="save-exit" aria-label={t('wizard.exit')} title={t('wizard.exit')}>
              <LogOut aria-hidden />
              <span className="hidden sm:inline">{t('wizard.exit')}</span>
            </Button>
            {/* Below `sm` the account menu carries language and theme, as in the dashboard header:
                the room goes to the workspace's name beside the stepper (QA-013). */}
            <LanguageMenu className="hidden sm:inline-flex" />
            <ThemeToggle labels={themeLabels} className="hidden sm:inline-flex" />
            <UserMenu />
          </div>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 pt-8 sm:px-6">
        <div className="mb-6 empty:hidden">
          <MfaBanner />
        </div>
        <WizardExitProvider onReady={setExit}>{children}</WizardExitProvider>
      </main>
    </div>
  );
}

export function WizardHeading({ title, subtitle, aside }: { title: React.ReactNode; subtitle?: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
        {/* A <div>, not a <p>: W2 and W4 put the AgentContextBanner (a <p>) inside it, and <p> in <p> is a hydration error. */}
        {subtitle ? <div className="mt-2 text-sm text-muted-foreground sm:text-base">{subtitle}</div> : null}
      </div>
      {aside}
    </div>
  );
}

export interface WizardFooterProps {
  /** Where Back goes; omit on the first step. */
  backHref?: string;
  backDisabled?: boolean;
  /** The one primary button of the screen (§7.3), plus anything that belongs beside it. */
  children: React.ReactNode;
  /** A short line under the actions: a hint about what Continue waits for. */
  note?: React.ReactNode;
  className?: string;
}

/**
 * §7.3: "Back and Continue bottom", "primary action bottom-right on desktop, sticky
 * bottom on mobile". The bar sits at the end of the page's content on a laptop and
 * sticks to the bottom edge of a phone's screen, over the safe area. Back is a link
 * (the previous step keeps its own saved state; nothing is posted), so it is reachable
 * with the keyboard and the browser's own history stays sane.
 */
export function WizardFooter({ backHref, backDisabled, children, note, className }: WizardFooterProps) {
  const t = useTranslations();
  return (
    <div className={cn('sticky bottom-0 z-20 mt-10 -mx-4 border-t border-border bg-background/95 px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:px-0 sm:pb-8 sm:pt-0 sm:backdrop-blur-0', className)}>
      <div className="flex items-center justify-between gap-3">
        {backHref ? (
          <Button variant="outline" className="h-12 sm:h-10" asChild={!backDisabled} disabled={backDisabled} data-testid="wizard-back">
            {backDisabled ? (
              <>
                <ArrowLeft aria-hidden /> {t('common.back')}
              </>
            ) : (
              <Link href={backHref}>
                <ArrowLeft aria-hidden /> {t('common.back')}
              </Link>
            )}
          </Button>
        ) : (
          <span />
        )}
        <div className="flex min-w-0 items-center justify-end gap-3">{children}</div>
      </div>
      {note ? <p className="mt-2 text-end text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}
