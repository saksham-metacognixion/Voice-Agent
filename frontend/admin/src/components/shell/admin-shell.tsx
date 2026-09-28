'use client';

import { Button, Logo, Sheet, SheetContent, SheetDescription, SheetTitle, ThemeToggle } from '@portal/ui';
import { Menu, Search } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as React from 'react';
import { RequireStaff } from '@/src/guards/guards';
import { routes } from '@/src/routes';
import { CommandPalette } from './command-palette';
import { HealthStrip } from './health-strip';
import { ImpersonationBanner } from './impersonation-banner';
import { SidebarNav } from './sidebar-nav';
import { StaffMenu } from './staff-menu';

/**
 * Admin §3 shell: fixed left nav at `lg`+, a Sheet from the menu button below it; a top
 * bar with the global search (⌘K), the health strip and the staff menu. Every page under
 * it sits behind `RequireStaff`, so the shell is only ever painted for a verified staff
 * member with a second factor.
 */
export function AdminShell({ children }: { children: React.ReactNode }) {
  return (
    <RequireStaff>
      <ShellFrame>{children}</ShellFrame>
    </RequireStaff>
  );
}

function ShellFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [navOpen, setNavOpen] = React.useState(false);
  const [searchOpen, setSearchOpen] = React.useState(false);
  React.useEffect(() => setNavOpen(false), [pathname]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar lg:flex">
        <div className="flex h-16 items-center gap-2 px-5">
          <Link href={routes.overview} aria-label="Oraly Admin">
            <Logo />
          </Link>
          <span className="rounded bg-sidebar-accent px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-sidebar-accent-foreground">Admin</span>
        </div>
        <SidebarNav />
        <div className="mt-auto p-4 text-[11px] text-muted-foreground">Staff console · {new Date().getFullYear()}</div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-border bg-background/85 px-4 backdrop-blur sm:px-6">
          <Sheet open={navOpen} onOpenChange={setNavOpen}>
            <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open sections" onClick={() => setNavOpen(true)}>
              <Menu />
            </Button>
            <SheetContent side="left" className="bg-sidebar p-0" closeLabel="Close sections">
              <SheetTitle className="px-5 pt-5">
                <Logo size="sm" />
              </SheetTitle>
              <SheetDescription className="sr-only">Console sections</SheetDescription>
              <SidebarNav onNavigate={() => setNavOpen(false)} />
            </SheetContent>
          </Sheet>
          <Link href={routes.overview} aria-label="Oraly Admin" className="shrink-0 lg:hidden">
            <Logo variant="mark" size="sm" />
          </Link>

          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="ml-1 flex h-9 w-full max-w-md items-center gap-2 rounded-md border border-input bg-card px-3 text-sm text-muted-foreground shadow-card transition-colors hover:bg-muted"
            aria-label="Search customers, users, agents, numbers, calls (⌘K)"
          >
            <Search className="size-4" aria-hidden />
            <span className="flex-1 truncate text-left">Search customers, users, numbers, calls…</span>
            <kbd className="hidden rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground sm:inline">⌘K</kbd>
          </button>

          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            <HealthStrip />
            <ThemeToggle className="hidden sm:inline-flex" />
            <StaffMenu />
          </div>
        </header>

        <ImpersonationBanner />

        <main className="flex-1 px-4 pb-10 pt-6 sm:px-6 lg:px-8">
          <div className="mx-auto flex w-full min-w-0 max-w-7xl flex-col gap-6">{children}</div>
        </main>
      </div>
      <CommandPalette open={searchOpen} onOpenChange={setSearchOpen} />
    </div>
  );
}
