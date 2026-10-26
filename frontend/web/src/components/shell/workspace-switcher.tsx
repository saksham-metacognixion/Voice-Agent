'use client';

import {
  Badge, Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, cn,
} from '@portal/ui';
import { Check, ChevronsUpDown, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { readQuery } from '@/src/lib/query-string';
import { routes, switchWorkspaceDestination } from '@/src/routes';
import { useWorkspace } from '@/src/workspace/workspace-provider';

/**
 * The one way to change workspace: the header switcher, the user menu and /select-workspace
 * all call it (QA-013). Selecting resets every workspace-scoped query; the person then goes
 * to the page's `?next=` or to `/`, whose gate decides for the new workspace. Choosing the
 * workspace already active does nothing, unless `force` — /select-workspace still has to
 * send the person on.
 */
export function useSwitchWorkspace() {
  const ws = useWorkspace();
  const router = useRouter();
  const { activeId, select } = ws;
  return React.useCallback(
    (id: string, { force = false }: { force?: boolean } = {}) => {
      const changed = id !== activeId;
      if (!changed && !force) return;
      if (changed) {
        select(id);
        track('workspace_switched');
      }
      router.replace(switchWorkspaceDestination(readQuery()));
    },
    [activeId, select, router],
  );
}

/** One row per membership, the active one ticked. Rendered inside a `DropdownMenuContent`. */
export function WorkspaceMenuItems() {
  const t = useTranslations();
  const ws = useWorkspace();
  const switchTo = useSwitchWorkspace();
  return (
    <>
      {ws.memberships.map((m) => (
        <DropdownMenuItem key={m.id} onSelect={() => switchTo(m.id)} aria-current={m.id === ws.activeId ? 'true' : undefined}>
          <span className="flex size-6 shrink-0 items-center justify-center rounded bg-muted text-[11px] font-semibold uppercase">{m.name.slice(0, 1)}</span>
          <span className="min-w-0 flex-1 truncate" dir="auto">{m.name}</span>
          <Badge variant="outline" className="text-[10px]">{t(`shell.role.${m.role}` as never)}</Badge>
          {m.id === ws.activeId ? <Check className="size-4 text-primary" /> : null}
        </DropdownMenuItem>
      ))}
    </>
  );
}

/**
 * A7 — the switcher in the shell header. The wizard header passes `compact` (QA-013): the
 * role line goes below `md` and the name is held to a few characters, so it fits beside the
 * stepper on a phone and still says which workspace this is — an initial alone did not.
 */
export function WorkspaceSwitcher({ className, compact = false }: { className?: string; compact?: boolean }) {
  const t = useTranslations();
  const ws = useWorkspace();
  const router = useRouter();
  const active = ws.active;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className={cn('h-auto max-w-full justify-start gap-2 px-2 py-1.5', compact && 'gap-1.5 px-1.5 sm:gap-2 sm:px-2', className)}
          aria-label={active ? t('nav.switchWorkspaceCurrent', { name: active.name }) : t('nav.switchWorkspace')}
          title={active?.name}
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/12 text-xs font-semibold uppercase text-accent-foreground">
            {active?.name.slice(0, 1) ?? '?'}
          </span>
          <span className="flex min-w-0 flex-col items-start">
            {/* `max-w-full` against the column, not only 10rem: on a phone the header gives the name what is left. */}
            <span dir="auto" className={cn('max-w-full truncate text-sm font-medium leading-tight sm:max-w-[10rem]', compact && 'max-w-[5.5rem] text-xs sm:max-w-[8rem] sm:text-sm md:max-w-[10rem]')}>
              {active?.name ?? t('nav.workspace')}
            </span>
            {active ? (
              <span className={cn('text-[11px] leading-tight text-muted-foreground', compact && 'hidden md:inline')}>{t(`shell.role.${active.role}` as never)}</span>
            ) : null}
          </span>
          <ChevronsUpDown className="ms-auto size-4 shrink-0 text-muted-foreground" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>{t('nav.switchWorkspace')}</DropdownMenuLabel>
        <WorkspaceMenuItems />
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => router.push(routes.setupWorkspace)}>
          <Plus /> {t('nav.createWorkspace')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
