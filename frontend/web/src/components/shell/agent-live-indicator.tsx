'use client';

import { useApi, useGetWallet, useListAgents } from '@portal/api-client';
import { cn } from '@portal/ui';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { agentLiveStatus } from '@/src/dashboard/home-view';
import { useWorkspace } from '@/src/workspace/workspace-provider';

/**
 * §7.2 "● Agent live": whether a caller is answered right now. Same two queries as the
 * chip and the pill (`listAgents` at the list's page size, `getWallet`), so it opens no
 * request of its own and moves on the same SSE frames — a publish, a pause, a wallet
 * that reaches zero. Hidden below `sm`: the phone header has no room for the words, and
 * a bare dot says nothing; Home's agent card carries the status there.
 */
export function AgentLiveIndicator({ className }: { className?: string }) {
  const t = useTranslations('shell.agentStatus');
  const api = useApi();
  const ws = useWorkspace();
  const enabled = Boolean(ws.active);
  const agents = useListAgents(api, { limit: 100 }, { enabled, staleTime: 15_000 });
  const wallet = useGetWallet(api, { enabled, staleTime: 15_000 });
  const status = agentLiveStatus({
    agents: agents.data?.items,
    workspacePaused: Boolean(ws.workspace?.paused),
    outOfCredits: wallet.data ? Number(wallet.data.balance ?? 0) <= 0 : false,
  });
  if (!status) return null;
  const live = status.state === 'live';

  return (
    <Link
      href={status.href}
      data-testid="agent-live"
      data-state={status.state}
      className={cn(
        'hidden h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-2 text-xs font-medium transition-colors hover:bg-muted sm:inline-flex',
        live ? 'text-success-emphasis' : 'text-muted-foreground',
        className,
      )}
    >
      <span className={cn('size-2 rounded-full', live ? 'bg-success' : 'bg-muted-foreground')} aria-hidden />
      {t(status.state, { n: status.count })}
    </Link>
  );
}
