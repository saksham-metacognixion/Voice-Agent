'use client';

import { useApi, useListAgents } from '@portal/api-client';
import { Button, Card, CardContent, CardHeader, CardTitle, EmptyState, Skeleton } from '@portal/ui';
import { BookOpen, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { LoadError } from '@/src/components/dashboard/query-states';
import { AgentStatusBadge, TierBadge } from '@/src/components/dashboard/status-badges';
import { agentPath, routes } from '@/src/routes';

/** D1 agent status (spec p. 33): every agent, its status and whether a draft is waiting. */
export function AgentsCard() {
  const t = useTranslations('dashboard.home.agents');
  const ta = useTranslations('dashboard.agents');
  const api = useApi();
  const agents = useListAgents(api, { limit: 10 }, { staleTime: 15_000 });

  return (
    <Card className="flex flex-col">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <BookOpen className="size-4 text-primary" aria-hidden /> {t('title')}
        </CardTitle>
        <Button size="sm" variant="ghost" asChild>
          <Link href={routes.app.agents}>
            {t('all')} <ChevronRight />
          </Link>
        </Button>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-2">
        {agents.isPending ? (
          <div className="flex flex-col gap-2" aria-busy>
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : agents.isError ? (
          <LoadError compact error={agents.error} onRetry={() => void agents.refetch()} />
        ) : agents.data.items.length === 0 ? (
          <EmptyState className="py-6" title={ta('empty')} />
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {agents.data.items.map((agent) => (
              <li key={agent.id}>
                <Link href={agentPath(agent.id)} className="flex items-center gap-3 rounded-md py-2.5 transition-colors hover:bg-muted/60">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{agent.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {agent.published_version ? ta('version', { n: agent.published_version }) : ta('notPublished')}
                      {agent.numbers_attached ? ` · ${ta('numbers', { n: agent.numbers_attached })}` : ''}
                      {agent.has_unpublished_changes ? ` · ${ta('unpublished')}` : ''}
                    </p>
                  </div>
                  <TierBadge tier={agent.tier} />
                  <AgentStatusBadge status={agent.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
