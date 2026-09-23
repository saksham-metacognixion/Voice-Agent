'use client';

import { Alert, Button, Logo, Separator, Sheet, SheetContent, SheetTitle, SheetTrigger, ThemeToggle, cn } from '@portal/ui';
import { Menu } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { LAST_IMPLEMENTED_STEP, routes, stepPath } from '@/src/routes';
import { useWorkspace } from '@/src/workspace/workspace-provider';
import { BalancePill } from './balance-pill';
import { NAV_GROUPS } from './nav-items';
import { UserMenu } from './user-menu';
import { WorkspaceSwitcher } from './workspace-switcher';

/**
 * §7.2 global shell: a fixed left nav on desktop, a sheet on phones; a header with the
 * workspace switcher, balance pill, theme and account. Status banners (paused workspace,
 * unfinished setup) sit above the page content so every screen shows them.
 */
export function PortalShell({ children }: { children: React.ReactNode }) {
  const t = useTranslations();
  const ws = useWorkspace();
  const [open, setOpen] = React.useState(false);
  const pathname = usePathname();
  React.useEffect(() => setOpen(false), [pathname]);

  const workspace = ws.workspace;
  const setupIncomplete = workspace && !workspace.onboarding_completed_at;
  const themeLabels = { light: t('common.theme.light'), dark: t('common.theme.dark'), system: t('common.theme.system'), toggle: t('common.theme.toggle') };

  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-sidebar shrink-0 flex-col border-r border-sidebar-border bg-sidebar lg:flex">
        <div className="flex h-16 items-center px-5">
          <Link href={routes.app.home} aria-label={t('common.appName')}>
            <Logo />
          </Link>
        </div>
        <SidebarNav />
        <div className="mt-auto p-4 text-[11px] text-muted-foreground">
          {t('common.appName')} · {new Date().getFullYear()}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-border bg-background/85 px-4 backdrop-blur sm:px-6">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="lg:hidden" aria-label={t('nav.openNavigation')}>
                <Menu />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 bg-sidebar p-0" closeLabel={t('nav.closeMenu')}>
              <SheetTitle className="sr-only">{t('nav.openNavigation')}</SheetTitle>
              <div className="flex h-16 items-center px-5">
                <Logo />
              </div>
              <SidebarNav />
            </SheetContent>
          </Sheet>
          <WorkspaceSwitcher className="min-w-0" />
          <div className="ml-auto flex items-center gap-1 sm:gap-2">
            <BalancePill className="hidden sm:inline-flex" />
            <ThemeToggle labels={themeLabels} />
            <UserMenu />
          </div>
        </header>

        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
            {workspace?.paused ? (
              <Alert variant="danger" title={t('shell.pausedBanner')}>
                {workspace.paused_reason ? t('shell.pausedReason', { reason: workspace.paused_reason }) : null}
              </Alert>
            ) : null}
            {setupIncomplete ? (
              <Alert
                variant="info"
                title={t('shell.finishSetup')}
                actions={
                  <Button size="sm" asChild>
                    <Link href={stepPath(Math.max(workspace.onboarding_step, LAST_IMPLEMENTED_STEP + 1))}>{t('shell.finishSetupCta')}</Link>
                  </Button>
                }
              />
            ) : null}
            <div className="sm:hidden">
              <BalancePill />
            </div>
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

function SidebarNav() {
  const t = useTranslations();
  const pathname = usePathname();
  return (
    <nav className="flex flex-1 flex-col gap-5 overflow-y-auto px-3 py-2" aria-label="Main">
      {NAV_GROUPS.map((group, gi) => (
        <div key={group.key} className="flex flex-col gap-0.5">
          <p className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t(`nav.${group.key}`)}</p>
          {group.items.map((item) => {
            const active = item.href === routes.app.home ? pathname === routes.app.home || pathname === '/app' : pathname.startsWith(item.href);
            return (
              <Link
                key={item.key}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-3 rounded-md px-2.5 py-2 text-sm font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground',
                  active && 'bg-sidebar-accent text-sidebar-accent-foreground',
                )}
              >
                <item.icon className="size-4 shrink-0" aria-hidden />
                {t(`nav.${item.key}`)}
              </Link>
            );
          })}
          {gi < NAV_GROUPS.length - 1 ? <Separator className="mt-3 bg-sidebar-border" /> : null}
        </div>
      ))}
    </nav>
  );
}

/** Page title row used by every dashboard page. */
export function PageHeader({ title, description, actions }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex gap-2">{actions}</div> : null}
    </div>
  );
}
