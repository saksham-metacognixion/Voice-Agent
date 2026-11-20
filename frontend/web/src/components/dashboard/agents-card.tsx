'use client';

import { isApiError, useApi, useListAgents, usePublishAgent } from '@portal/api-client';
import type { AgentSummary } from '@portal/schemas';
import { Button, Card, CardContent, CardHeader, CardTitle, EmptyState, Skeleton, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import { BookOpen, ChevronRight, Eye, Pencil, PhoneCall, Rocket } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { ConfirmDialog } from '@/src/components/dashboard/confirm-dialog';
import { LoadError } from '@/src/components/dashboard/query-states';
import { AgentStatusBadge, TierBadge } from '@/src/components/dashboard/status-badges';
import { agentNeedsNumber } from '@/src/dashboard/agent-reach';
import { agentCardActions, agentPauseNotice } from '@/src/dashboard/home-view';
import { errorMessage } from '@/src/lib/errors';
import { formatPhone } from '@/src/lib/format';
import { addNumberPath, agentPath, routes } from '@/src/routes';
import { useRole } from '@/src/workspace/use-role';

/**
 * D1 agent card (spec p. 33): every agent with its status, live version, number and
 * whether a draft is waiting, plus Test → D3 Test, Publish → confirm → `POST
 * /agents/:id/publish`, Edit → D3 Brief. What a role may not do is not offered
 * (`agentCardActions`), and the API refuses it again. A staff pause names its ticket;
 * the customer's own pause says so (ADR 0041).
 */
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
              <AgentRow key={agent.id} agent={agent} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function AgentRow({ agent }: { agent: AgentSummary }) {
  const t = useTranslations('dashboard.home.agents');
  const ta = useTranslations('dashboard.agents');
  const tc = useTranslations();
  const api = useApi();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { role, canAdmin } = useRole();
  const publish = usePublishAgent(api);
  const [confirm, setConfirm] = React.useState(false);
  const actions = agentCardActions(agent, role);
  const pause = agentPauseNotice(agent);

  async function runPublish() {
    if (agent.draft_version === null) return;
    try {
      const res = await publish.mutateAsync({ params: { id: agent.id }, body: { version_no: agent.draft_version } });
      track('agent_published', { agent_id: agent.id, version_no: res.version_no, from: 'home' });
      if (res.already_published) toast.success(ta('publish.alreadyLive', { n: res.version_no }));
      else if (agent.numbers_attached === 0) toast.warning(ta('publish.doneNoNumber', { n: res.version_no }));
      else toast.success(ta('publish.done', { n: res.version_no }));
      await queryClient.invalidateQueries({ queryKey: ['listAgents'] });
      void queryClient.invalidateQueries({ queryKey: ['getAgent', { id: agent.id }] });
      void queryClient.invalidateQueries({ queryKey: ['getWorkspaceChecklist'] });
    } catch (e) {
      if (isApiError(e, 'LINT_FAILED')) {
        // The findings are on the agent's own page; the toast takes them there.
        toast.error(tc('errors.LINT_FAILED'), { action: { label: t('seeChecks'), onClick: () => router.push(agentPath(agent.id, 'test')) } });
        return;
      }
      toast.error(errorMessage(e, tc));
    }
  }

  return (
    <li className="flex flex-col gap-2 py-3" data-testid="agent-card-row">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <Link href={agentPath(agent.id)} className="truncate text-sm font-medium hover:underline">{agent.name}</Link>
          <p className="truncate text-xs text-muted-foreground">
            {agent.published_version ? ta('version', { n: agent.published_version }) : ta('notPublished')}
            {agent.number_e164 ? <> · <span dir="ltr">{formatPhone(agent.number_e164)}</span></> : agent.numbers_attached ? ` · ${ta('numbers', { n: agent.numbers_attached })}` : ''}
          </p>
        </div>
        <TierBadge tier={agent.tier} />
        <AgentStatusBadge agent={agent} />
      </div>
      {agentNeedsNumber(agent) ? (
        <p className="text-xs text-warning-emphasis" data-testid="agent-no-number">
          {ta('noNumber.title')}
          {canAdmin ? (
            <>
              {' · '}
              <Link href={addNumberPath(agent.id)} className="font-medium underline">{ta('noNumber.add')}</Link>
            </>
          ) : null}
        </p>
      ) : null}
      {agent.has_unpublished_changes ? (
        <p className="text-xs font-medium text-warning-emphasis" data-testid="agent-unpublished">{ta('unpublished')}</p>
      ) : null}
      {pause ? (
        <p className="text-xs text-muted-foreground" data-testid="agent-pause-notice">
          {pause.by === 'staff' ? (pause.ticketId ? t('pausedByStaffTicket', { ticket: pause.ticketId }) : t('pausedByStaff')) : pause.by === 'customer' ? t('pausedByYou') : t('pausedPlain')}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {actions.test ? (
          <Button size="sm" variant="outline" asChild>
            <Link href={actions.testHref} data-testid="agent-test"><PhoneCall /> {t('test')}</Link>
          </Button>
        ) : null}
        {actions.publish ? (
          <Button size="sm" onClick={() => setConfirm(true)} loading={publish.isPending} disabled={publish.isPending} data-testid="agent-publish">
            <Rocket /> {t('publish')}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" asChild>
          <Link href={actions.editHref} data-testid={actions.edit === 'edit' ? 'agent-edit' : 'agent-view'}>
            {actions.edit === 'edit' ? <Pencil /> : <Eye />} {actions.edit === 'edit' ? t('edit') : t('view')}
          </Link>
        </Button>
      </div>
      {actions.publish ? (
        <ConfirmDialog
          open={confirm}
          onOpenChange={setConfirm}
          destructive={false}
          title={t('publishTitle', { name: agent.name, n: agent.draft_version ?? 0 })}
          description={agent.published_version ? t('publishBodyLive', { live: agent.published_version }) : t('publishBodyFirst')}
          consequences={[t('publishChecks'), agent.status === 'paused' ? ta('publish.pausedHint') : t('publishNumbers')]}
          confirmLabel={ta('publish.button', { n: agent.draft_version ?? 0 })}
          onConfirm={runPublish}
        />
      ) : null}
    </li>
  );
}
