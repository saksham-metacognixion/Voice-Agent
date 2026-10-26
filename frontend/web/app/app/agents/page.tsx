'use client';

import { useApi, useListAgents } from '@portal/api-client';
import { roleAtLeast, type AgentSummary } from '@portal/schemas';
import { Button, Card, CardContent, EmptyState, Skeleton } from '@portal/ui';
import { BookOpen, ChevronRight, Plus } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { NewAgentDialog } from '@/src/components/dashboard/agent/new-agent-dialog';
import { LoadError } from '@/src/components/dashboard/query-states';
import { AgentStatusBadge, TierBadge } from '@/src/components/dashboard/status-badges';
import { PageHeader } from '@/src/components/shell/portal-shell';
import { formatDateTime, formatDuration } from '@/src/lib/format';
import { agentPath } from '@/src/routes';
import { useServerCopy } from '@/src/i18n/server-copy';
import { useWorkspace } from '@/src/workspace/workspace-provider';

/** D3 Agents (spec p. 35): every agent in the workspace, its status, and the way in. */
export default function AgentsPage() {
  const t = useTranslations('dashboard.agents');
  const api = useApi();
  const ws = useWorkspace();
  const agents = useListAgents(api, { limit: 100 }, { staleTime: 15_000 });
  const [creating, setCreating] = React.useState(false);
  const canEdit = roleAtLeast(ws.workspace?.role ?? 'viewer', 'editor');

  return (
    <>
      <PageHeader
        title={t('title')}
        description={agents.data ? t('count', { n: agents.data.items.length }) : undefined}
        actions={
          canEdit ? (
            <Button onClick={() => setCreating(true)}>
              <Plus /> {t('new.button')}
            </Button>
          ) : null
        }
      />
      {agents.isPending ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2" aria-busy>
          {Array.from({ length: 2 }, (_, i) => (
            <Skeleton key={i} className="h-36 w-full" />
          ))}
        </div>
      ) : agents.isError ? (
        <LoadError error={agents.error} onRetry={() => void agents.refetch()} />
      ) : agents.data.items.length === 0 ? (
        <EmptyState icon={<BookOpen />} title={t('empty')} description={t('emptyHint')} action={canEdit ? <Button onClick={() => setCreating(true)}><Plus /> {t('new.button')}</Button> : undefined} />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {agents.data.items.map((agent) => (
            <AgentCard key={agent.id} agent={agent} timeZone={ws.workspace?.timezone} />
          ))}
        </div>
      )}
      <NewAgentDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}

function AgentCard({ agent, timeZone }: { agent: AgentSummary; timeZone: string | undefined }) {
  const t = useTranslations('dashboard.agents');
  const copy = useServerCopy();
  return (
    <Card className="transition-colors hover:border-primary/40">
      <CardContent className="p-0">
        <Link href={agentPath(agent.id)} className="flex flex-col gap-3 p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-base font-semibold">{agent.name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {agent.template_id ? t(`templates.${agent.template_id}`) : t('templates.custom')}
                {agent.industry ? ` · ${copy.industry(agent.industry)}` : ''}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <TierBadge tier={agent.tier} />
              <AgentStatusBadge status={agent.status} />
            </div>
          </div>
          <dl className="grid grid-cols-3 gap-3 text-xs">
            <div>
              <dt className="text-muted-foreground">{t('live')}</dt>
              <dd className="font-medium">{agent.published_version ? `v${agent.published_version}` : '–'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('draft')}</dt>
              <dd className="font-medium">
                {agent.draft_version ? `v${agent.draft_version}` : '–'}
                {agent.has_unpublished_changes ? <span className="ms-1 text-warning-emphasis">•</span> : null}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('numbersLabel')}</dt>
              <dd className="font-medium">{agent.numbers_attached}</dd>
            </div>
          </dl>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {agent.primary_language}
              {agent.languages.length ? ` +${agent.languages.length}` : ''} · {formatDuration(agent.max_call_duration_s)} {t('max')} · {t('created', { when: formatDateTime(agent.created_at, timeZone) })}
            </span>
            <ChevronRight className="size-4" aria-hidden />
          </div>
        </Link>
      </CardContent>
    </Card>
  );
}
