'use client';

import { useApi, useListAgents } from '@portal/api-client';
import type { AgentSummary } from '@portal/schemas';
import { Button, Card, CardContent, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, EmptyState, Skeleton } from '@portal/ui';
import { BookOpen, ChevronRight, Copy, MoreHorizontal, Pause, Play, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { DeleteAgentDialog, useAgentActions } from '@/src/components/dashboard/agent/agent-actions';
import { NewAgentDialog } from '@/src/components/dashboard/agent/new-agent-dialog';
import { LoadError } from '@/src/components/dashboard/query-states';
import { AgentStatusBadge, TierBadge } from '@/src/components/dashboard/status-badges';
import { PageHeader } from '@/src/components/shell/portal-shell';
import { formatDateTime, formatDuration } from '@/src/lib/format';
import { agentPath } from '@/src/routes';
import { useServerCopy } from '@/src/i18n/server-copy';
import { useRole } from '@/src/workspace/use-role';
import { useWorkspace } from '@/src/workspace/workspace-provider';

/**
 * D3 Agents (spec p. 35): every agent in the workspace, its status, and the way in. Each
 * card has the spec's row menu — Duplicate (editor and up), Pause/Resume and Delete
 * (owner/admin) — through the same actions as the Settings tab (QA-078). A copy opens
 * straight away, as a draft.
 */
export default function AgentsPage() {
  const t = useTranslations('dashboard.agents');
  const api = useApi();
  const ws = useWorkspace();
  const router = useRouter();
  const agents = useListAgents(api, { limit: 100 }, { staleTime: 15_000 });
  const [creating, setCreating] = React.useState(false);
  const [deleting, setDeleting] = React.useState<AgentSummary | null>(null);
  const { canEdit, canAdmin } = useRole();
  const actions = useAgentActions();

  async function duplicate(agent: AgentSummary) {
    const copy = await actions.duplicate(agent);
    if (copy) router.push(agentPath(copy.id));
  }

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
            <AgentCard
              key={agent.id}
              agent={agent}
              timeZone={ws.workspace?.timezone}
              menu={
                canEdit ? (
                  <AgentMenu
                    agent={agent}
                    canAdmin={canAdmin}
                    busy={actions.duplicating || actions.pausing}
                    onDuplicate={() => void duplicate(agent)}
                    onTogglePause={() => void actions.togglePause(agent)}
                    onDelete={() => setDeleting(agent)}
                  />
                ) : null
              }
            />
          ))}
        </div>
      )}
      <NewAgentDialog open={creating} onOpenChange={setCreating} />
      {deleting ? <DeleteAgentDialog agent={deleting} open onOpenChange={(open) => (open ? undefined : setDeleting(null))} /> : null}
    </>
  );
}

/**
 * The ⋯ menu. Pause/Resume is offered once the agent has been on the phone (a draft has
 * nothing to pause); Delete is disabled while a number still points at the agent — the
 * API refuses it with `AGENT_IN_USE` — and says why.
 */
function AgentMenu({
  agent,
  canAdmin,
  busy,
  onDuplicate,
  onTogglePause,
  onDelete,
}: {
  agent: AgentSummary;
  canAdmin: boolean;
  busy: boolean;
  onDuplicate: () => void;
  onTogglePause: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations('dashboard.agents');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={t('menu.label', { name: agent.name })} disabled={busy}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onDuplicate}>
          <Copy /> {t('menu.duplicate')}
        </DropdownMenuItem>
        {canAdmin ? (
          <>
            {agent.status !== 'draft' ? (
              <DropdownMenuItem onSelect={onTogglePause}>
                {agent.status === 'paused' ? <Play /> : <Pause />} {agent.status === 'paused' ? t('settings.resume') : t('settings.pause')}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive disabled={agent.numbers_attached > 0} onSelect={onDelete} title={agent.numbers_attached > 0 ? t('settings.inUse') : undefined}>
              <Trash2 /> {t('settings.delete')}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AgentCard({ agent, timeZone, menu }: { agent: AgentSummary; timeZone: string | undefined; menu?: React.ReactNode }) {
  const t = useTranslations('dashboard.agents');
  const copy = useServerCopy();
  return (
    <Card className="relative transition-colors hover:border-primary/40">
      {/* Beside the link, not inside it: a button inside an <a> is not valid markup. */}
      {menu ? <div className="absolute end-3 top-4 z-10">{menu}</div> : null}
      <CardContent className="p-0">
        <Link href={agentPath(agent.id)} className="flex flex-col gap-3 p-5">
          <div className={`flex items-start justify-between gap-3 ${menu ? 'pe-9' : ''}`}>
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
