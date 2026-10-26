'use client';

import {
  Badge, Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, cn,
} from '@portal/ui';
import { Check, ChevronsUpDown, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { track } from '@/src/analytics/posthog';
import { routes } from '@/src/routes';
import { useWorkspace } from '@/src/workspace/workspace-provider';

/** A7 — the switcher in the shell header. Selecting resets every workspace-scoped query. */
export function WorkspaceSwitcher({ className }: { className?: string }) {
  const t = useTranslations();
  const ws = useWorkspace();
  const router = useRouter();
  const active = ws.active;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className={cn('h-auto max-w-full justify-start gap-2 px-2 py-1.5', className)} aria-label={t('nav.switchWorkspace')}>
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/12 text-xs font-semibold uppercase text-accent-foreground">
            {active?.name.slice(0, 1) ?? '?'}
          </span>
          <span className="flex min-w-0 flex-col items-start">
            {/* `max-w-full` against the column, not only 10rem: on a phone the header gives the name what is left. */}
            <span className="max-w-full truncate text-sm font-medium leading-tight sm:max-w-[10rem]">{active?.name ?? t('nav.workspace')}</span>
            {active ? <span className="text-[11px] leading-tight text-muted-foreground">{t(`shell.role.${active.role}` as never)}</span> : null}
          </span>
          <ChevronsUpDown className="ms-auto size-4 shrink-0 text-muted-foreground" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>{t('nav.switchWorkspace')}</DropdownMenuLabel>
        {ws.memberships.map((m) => (
          <DropdownMenuItem
            key={m.id}
            onSelect={() => {
              if (m.id === ws.activeId) return;
              ws.select(m.id);
              track('workspace_switched');
              router.replace(routes.root);
            }}
          >
            <span className="flex size-6 items-center justify-center rounded bg-muted text-[11px] font-semibold uppercase">{m.name.slice(0, 1)}</span>
            <span className="min-w-0 flex-1 truncate">{m.name}</span>
            <Badge variant="outline" className="text-[10px]">{t(`shell.role.${m.role}` as never)}</Badge>
            {m.id === ws.activeId ? <Check className="size-4 text-primary" /> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => router.push(routes.setupWorkspace)}>
          <Plus /> {t('nav.createWorkspace')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
