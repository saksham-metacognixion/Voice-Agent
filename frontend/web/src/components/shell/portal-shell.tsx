import { Alert, Button, Logo, Separator, Sheet, SheetContent, SheetDescription, SheetTitle, ThemeToggle, cn } from '@portal/ui';
import { MoreHorizontal } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { DashboardLiveProvider } from '@/src/dashboard/dashboard-live';
import { LAST_IMPLEMENTED_STEP, routes, stepPath } from '@/src/routes';
import { useWorkspace } from '@/src/workspace/workspace-provider';
import { BalancePill } from './balance-pill';
import { NAV_GROUPS, NAV_ITEMS, TAB_BAR_KEYS, isNavActive, type NavItem } from './nav-items';
import { UserMenu } from './user-menu';
import { WorkspaceSwitcher } from './workspace-switcher';

/**
 * §7.2 global shell: a fixed left nav on desktop; on anything narrower than `lg` the nav
 * becomes a bottom tab bar (§12.5) — the four screens an owner opens most, and "More"
 * for the rest in a bottom sheet. The header carries the workspace switcher, balance
 * pill, theme and account. Status banners (paused workspace, unfinished setup) sit above
 * the page content so every screen shows them.
 *
 * The dashboard's one SSE stream is opened here (`DashboardLiveProvider`), so the pill,
 * D5 and whatever page is open share one connection that lives as long as the shell.
 */
export function PortalShell({ children }: { children: React.ReactNode }) {
  const t = useTranslations();
  const ws = useWorkspace();

  const workspace = ws.workspace;
  const setupIncomplete = workspace && !workspace.onboarding_completed_at;
  const themeLabels = { light: t('common.theme.light'), dark: t('common.theme.dark'), system: t('common.theme.system'), toggle: t('common.theme.toggle') };

  return (
    <DashboardLiveProvider enabled={Boolean(ws.active)}>
      <div className="flex min-h-dvh">
        <aside className="sticky top-0 hidden h-dvh w-sidebar shrink-0 flex-col border-r border-sidebar-border bg-sidebar lg:flex">
          <div className="flex h-16 items-center px-5">
            <Link href={routes.app.home} aria-label={t('common.appName')}>
              <Logo />
            </Link>
          </div>
          <SidebarNav />
          <div className="mt-auto flex flex-col gap-3 p-4">
            <BalancePill className="self-start" />
            <span className="text-[11px] text-muted-foreground">
              {t('common.appName')} · {new Date().getFullYear()}
            </span>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-border bg-background/85 px-4 backdrop-blur sm:px-6">
            <Link href={routes.app.home} aria-label={t('common.appName')} className="shrink-0 lg:hidden">
              <Logo variant="mark" size="sm" />
            </Link>
            <WorkspaceSwitcher className="min-w-0 shrink" />
            <div className="ml-auto flex items-center gap-1 sm:gap-2">
              <BalancePill className="lg:hidden" compact />
              <ThemeToggle labels={themeLabels} className="hidden sm:inline-flex" />
              <UserMenu />
            </div>
          </header>

          {/* The bottom padding keeps the last row of every page clear of the tab bar (4rem + the home indicator). */}
          <main className="flex-1 px-4 pb-[calc(5.5rem+env(safe-area-inset-bottom))] pt-6 sm:px-6 lg:px-8 lg:pb-6">
            <div className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-6">
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
              {children}
            </div>
          </main>
        </div>
        <BottomTabBar />
      </div>
    </DashboardLiveProvider>
  );
}

/**
 * §12.5 phone navigation. Fixed to the bottom, above the home indicator
 * (`env(safe-area-inset-bottom)`, which needs `viewport-fit=cover`), 4rem tall targets.
 * The screens that do not fit sit behind "More", which is active while one of them is.
 */
function BottomTabBar() {
  const t = useTranslations();
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = React.useState(false);
  React.useEffect(() => setMoreOpen(false), [pathname]);

  const tabs = TAB_BAR_KEYS.map((key) => NAV_ITEMS.find((i) => i.key === key)!);
  const overflow = NAV_ITEMS.filter((i) => !TAB_BAR_KEYS.includes(i.key));
  const overflowActive = overflow.some((i) => isNavActive(i, pathname));

  return (
    <nav aria-label={t('nav.main')} className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
      <ul className="mx-auto grid h-16 max-w-lg grid-cols-5">
        {tabs.map((item) => (
          <li key={item.key} className="min-w-0">
            <TabLink item={item} active={isNavActive(item, pathname)} />
          </li>
        ))}
        <li className="min-w-0">
          <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
            <button
              type="button"
              onClick={() => setMoreOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={moreOpen}
              className={cn(tabClass, overflowActive && activeTabClass)}
            >
              <MoreHorizontal className="size-5" aria-hidden />
              <span className="truncate">{t('nav.more')}</span>
            </button>
            <SheetContent side="bottom" className="bg-background p-0 pb-[env(safe-area-inset-bottom)]" closeLabel={t('nav.closeMenu')}>
              <SheetTitle className="px-5 pt-5 text-base">{t('nav.more')}</SheetTitle>
              <SheetDescription className="sr-only">{t('nav.moreHint')}</SheetDescription>
              <ul className="flex flex-col gap-1 p-3">
                {overflow.map((item) => {
                  const active = isNavActive(item, pathname);
                  return (
                    <li key={item.key}>
                      <Link
                        href={item.href}
                        aria-current={active ? 'page' : undefined}
                        className={cn('flex min-h-12 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors hover:bg-muted', active && 'bg-sidebar-accent text-sidebar-accent-foreground')}
                      >
                        <item.icon className="size-5 shrink-0" aria-hidden />
                        {t(`nav.${item.key}`)}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </SheetContent>
          </Sheet>
        </li>
      </ul>
    </nav>
  );
}

const tabClass = 'flex h-full w-full flex-col items-center justify-center gap-1 px-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60';
const activeTabClass = 'text-primary';

function TabLink({ item, active }: { item: NavItem; active: boolean }) {
  const t = useTranslations();
  return (
    <Link href={item.href} aria-current={active ? 'page' : undefined} className={cn(tabClass, active && activeTabClass)}>
      <item.icon className="size-5" aria-hidden />
      <span className="max-w-full truncate">{t(`nav.short.${item.key}`)}</span>
    </Link>
  );
}

function SidebarNav() {
  const t = useTranslations();
  const pathname = usePathname();
  return (
    <nav className="flex flex-1 flex-col gap-5 overflow-y-auto px-3 py-2" aria-label={t('nav.main')}>
      {NAV_GROUPS.map((group, gi) => (
        <div key={group.key} className="flex flex-col gap-0.5">
          <p className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t(`nav.${group.key}`)}</p>
          {group.items.map((item) => {
            const active = isNavActive(item, pathname);
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
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}
