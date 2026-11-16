'use client';

import { useApi, useListAgents } from '@portal/api-client';
import { cn } from '@portal/ui';
import { AlertTriangle } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { unpublishedSummary } from '@/src/dashboard/home-view';
import { useWorkspace } from '@/src/workspace/workspace-provider';

/**
 * §7.2 "unpublished changes" chip: shown while any agent's draft is ahead of what is on
 * the phone, and gone the moment a publish lands. One agent opens its Test tab, where the
 * publish bar is; several open the list. It reads the D3 list's `listAgents` query (the
 * largest page, 100: "any agent" cannot be judged from the ten newest), which every
 * `agent:` SSE frame invalidates — so a publish from any tab, or a draft saved on W2,
 * moves it without a reload.
 */
export function UnpublishedChip({ className }: { className?: string }) {
  const t = useTranslations('shell.unpublished');
  const api = useApi();
  const ws = useWorkspace();
  const agents = useListAgents(api, { limit: 100 }, { enabled: Boolean(ws.active), staleTime: 15_000 });
  const summary = unpublishedSummary(agents.data?.items);
  if (!summary) return null;

  return (
    <Link
      href={summary.href}
      data-testid="unpublished-chip"
      className={cn(
        'inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-warning/50 bg-warning/15 px-3 text-xs font-medium text-warning-emphasis transition-colors hover:bg-warning/25',
        className,
      )}
    >
      <AlertTriangle className="size-3.5" aria-hidden />
      <span className="hidden sm:inline">{t('label', { n: summary.count })}</span>
      <span className="sm:hidden">{summary.count}</span>
    </Link>
  );
}
