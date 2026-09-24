'use client';

import { getAgentVersion, isApiError, useApi, useGetAgentVersion, useListAgentVersions, usePublishAgent, useSelectAgentDraft } from '@portal/api-client';
import type { AgentDetail, AgentVersionDetail, AgentVersionSummary } from '@portal/schemas';
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, EmptyState, Sheet, SheetContent, SheetDescription, SheetTitle, Skeleton, cn, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Eye, GitCompare, History, Rocket } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { LoadError } from '@/src/components/dashboard/query-states';
import { diffCounts, lineDiff } from '@/src/dashboard/line-diff';
import { errorMessage } from '@/src/lib/errors';
import { formatDateTime } from '@/src/lib/format';
import { useWorkspace } from '@/src/workspace/workspace-provider';

/**
 * D3 Versions (§9.9, spec p. 36): every `agent_versions` row, newest first — immutable,
 * never renumbered. View opens the prompt; Compare diffs two versions' editable prompts;
 * "Restore as draft" is `POST /agents/:id/draft/select` (a pointer move, nothing written);
 * "Publish this version" is `POST /agents/:id/publish {version_no}` — roll back is
 * publishing the old one (ADR 0003 §7). Nothing here deletes.
 */
export function VersionsTab({ agent, canEdit }: { agent: AgentDetail; canEdit: boolean }) {
  const t = useTranslations('dashboard.agents.versions');
  const tc = useTranslations();
  const api = useApi();
  const ws = useWorkspace();
  const queryClient = useQueryClient();
  const versions = useListAgentVersions(api, { id: agent.id }, { staleTime: 10_000 });
  const select = useSelectAgentDraft(api);
  const publish = usePublishAgent(api);
  const [viewing, setViewing] = React.useState<number | null>(null);
  const [compare, setCompare] = React.useState<number[]>([]);
  const [showDiff, setShowDiff] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['getAgent', { id: agent.id }] });
    await queryClient.invalidateQueries({ queryKey: ['listAgentVersions', { id: agent.id }] });
    void queryClient.invalidateQueries({ queryKey: ['listAgents'] });
  }

  async function restore(versionNo: number) {
    setBusy(`restore-${versionNo}`);
    try {
      await select.mutateAsync({ params: { id: agent.id }, body: { version_no: versionNo } });
      track('version_restored', { agent_id: agent.id, version_no: versionNo });
      toast.success(t('restored', { n: versionNo }));
      await refresh();
    } catch (e) {
      toast.error(errorMessage(e, tc));
    } finally {
      setBusy(null);
    }
  }

  async function publishVersion(versionNo: number) {
    setBusy(`publish-${versionNo}`);
    try {
      const res = await publish.mutateAsync({ params: { id: agent.id }, body: { version_no: versionNo } });
      track('agent_published', { agent_id: agent.id, version_no: versionNo, from: 'versions' });
      toast.success(res.already_published ? t('alreadyLive', { n: versionNo }) : t('published', { n: versionNo }));
      await refresh();
    } catch (e) {
      toast.error(isApiError(e, 'LINT_FAILED') ? t('lintBlocked') : errorMessage(e, tc));
    } finally {
      setBusy(null);
    }
  }

  function toggleCompare(versionNo: number) {
    setCompare((c) => (c.includes(versionNo) ? c.filter((v) => v !== versionNo) : [...c.slice(-1), versionNo]));
  }

  if (versions.isPending) {
    return (
      <div className="flex flex-col gap-2" aria-busy>
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    );
  }
  if (versions.isError) return <LoadError error={versions.error} onRetry={() => void versions.refetch()} />;
  if (versions.data.length === 0) return <EmptyState icon={<History />} title={t('empty')} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
        <p>{t('hint')}</p>
        <Button size="sm" variant="outline" disabled={compare.length !== 2} onClick={() => setShowDiff(true)}>
          <GitCompare /> {compare.length === 2 ? t('compareThese', { a: Math.min(...compare), b: Math.max(...compare) }) : t('compare')}
        </Button>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full min-w-0 text-left text-sm md:min-w-[40rem]">
          <thead className="bg-muted/60 text-xs text-muted-foreground">
            <tr>
              <th className="w-10 px-3 py-2.5 font-medium">{t('pick')}</th>
              <th className="px-3 py-2.5 font-medium">{t('version')}</th>
              <th className="hidden px-3 py-2.5 font-medium sm:table-cell">{t('source')}</th>
              <th className="hidden px-3 py-2.5 font-medium sm:table-cell">{t('created')}</th>
              <th className="hidden px-3 py-2.5 font-medium md:table-cell">{t('changes')}</th>
              <th className="px-3 py-2.5 text-right font-medium">{t('actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {versions.data.map((v) => (
              <VersionRow
                key={v.version_no}
                version={v}
                timeZone={ws.workspace?.timezone}
                picked={compare.includes(v.version_no)}
                onPick={() => toggleCompare(v.version_no)}
                onView={() => setViewing(v.version_no)}
                onRestore={canEdit && !v.is_draft ? () => void restore(v.version_no) : undefined}
                onPublish={canEdit && !v.is_published && v.has_prompt ? () => void publishVersion(v.version_no) : undefined}
                busy={busy}
              />
            ))}
          </tbody>
        </table>
      </div>

      <VersionSheet agentId={agent.id} versionNo={viewing} onClose={() => setViewing(null)} />
      {showDiff && compare.length === 2 ? <DiffDialog agentId={agent.id} a={Math.min(...compare)} b={Math.max(...compare)} onClose={() => setShowDiff(false)} /> : null}
    </div>
  );
}

function VersionRow({ version: v, timeZone, picked, onPick, onView, onRestore, onPublish, busy }: { version: AgentVersionSummary; timeZone: string | undefined; picked: boolean; onPick: () => void; onView: () => void; onRestore?: () => void; onPublish?: () => void; busy: string | null }) {
  const t = useTranslations('dashboard.agents.versions');
  return (
    <tr className={cn(picked && 'bg-accent/40')}>
      <td className="px-3 py-2.5">
        <input type="checkbox" className="size-4 accent-primary" checked={picked} onChange={onPick} aria-label={t('pickVersion', { n: v.version_no })} />
      </td>
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="font-medium">v{v.version_no}</span>
          {v.is_published ? <Badge variant="success">{t('live')}</Badge> : null}
          {v.is_draft ? <Badge variant="info">{t('draft')}</Badge> : null}
          {!v.has_prompt ? <Badge variant="outline">{t('noPrompt')}</Badge> : null}
        </div>
      </td>
      <td className="hidden px-3 py-2.5 text-muted-foreground sm:table-cell">{t(`sources.${v.source}`)}</td>
      <td className="hidden whitespace-nowrap px-3 py-2.5 text-muted-foreground sm:table-cell">
        {formatDateTime(v.created_at, timeZone)}
        {v.published_at ? <span className="block text-xs">{t('publishedAt', { when: formatDateTime(v.published_at, timeZone) })}</span> : null}
      </td>
      <td className="hidden max-w-[18rem] px-3 py-2.5 text-xs text-muted-foreground md:table-cell">
        {v.changes?.length ? (
          <ul className="list-disc pl-4">
            {v.changes.slice(0, 3).map((c, i) => (
              <li key={i} className="truncate">
                {c}
              </li>
            ))}
            {v.changes.length > 3 ? <li>{t('moreChanges', { n: v.changes.length - 3 })}</li> : null}
          </ul>
        ) : (
          '–'
        )}
      </td>
      <td className="px-3 py-2.5">
        <div className="flex justify-end gap-1">
          <Button size="sm" variant="ghost" onClick={onView} aria-label={t('view')}>
            <Eye /> <span className="hidden lg:inline">{t('view')}</span>
          </Button>
          {onRestore ? (
            <Button size="sm" variant="outline" loading={busy === `restore-${v.version_no}`} onClick={onRestore}>
              {t('restore')}
            </Button>
          ) : null}
          {onPublish ? (
            <Button size="sm" variant="outline" loading={busy === `publish-${v.version_no}`} onClick={onPublish}>
              <Rocket /> {t('publish')}
            </Button>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function VersionSheet({ agentId, versionNo, onClose }: { agentId: string; versionNo: number | null; onClose: () => void }) {
  const t = useTranslations('dashboard.agents.versions');
  const tc = useTranslations();
  const api = useApi();
  const version = useGetAgentVersion(api, { id: agentId, v: String(versionNo ?? 0) }, { enabled: versionNo !== null, staleTime: 60_000 });
  return (
    <Sheet open={versionNo !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent side="right" className="w-full sm:w-[40rem] sm:max-w-[40rem]" closeLabel={tc('common.close')}>
        <SheetTitle>{t('viewTitle', { n: versionNo ?? 0 })}</SheetTitle>
        {version.isPending ? (
          <div className="flex flex-col gap-2" aria-busy>
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : version.isError ? (
          <LoadError error={version.error} onRetry={() => void version.refetch()} />
        ) : (
          <VersionBody version={version.data} />
        )}
      </SheetContent>
    </Sheet>
  );
}

function VersionBody({ version }: { version: AgentVersionDetail }) {
  const t = useTranslations('dashboard.agents.versions');
  return (
    <div className="flex flex-col gap-4 text-sm">
      <SheetDescription>
        {t(`sources.${version.source}`)} · {formatDateTime(version.created_at)}
        {version.lint ? ` · ${version.lint.publishable ? t('lintOk') : t('lintErrors')}` : ''}
      </SheetDescription>
      {version.greeting ? (
        <div>
          <p className="text-xs font-medium text-muted-foreground">{t('greeting')}</p>
          <p>{version.greeting}</p>
        </div>
      ) : null}
      <div>
        <p className="text-xs font-medium text-muted-foreground">{t('prompt')}</p>
        <pre className="mt-1 max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed">{version.editable_prompt ?? t('noPrompt')}</pre>
      </div>
      {version.feedback_text ? (
        <div>
          <p className="text-xs font-medium text-muted-foreground">{t('feedback')}</p>
          <p className="italic">“{version.feedback_text}”</p>
        </div>
      ) : null}
    </div>
  );
}

function DiffDialog({ agentId, a, b, onClose }: { agentId: string; a: number; b: number; onClose: () => void }) {
  const t = useTranslations('dashboard.agents.versions');
  const tc = useTranslations();
  const api = useApi();
  const [state, setState] = React.useState<{ status: 'loading' | 'ready' | 'error'; ops: ReturnType<typeof lineDiff>; error: unknown }>({ status: 'loading', ops: [], error: null });

  React.useEffect(() => {
    let cancelled = false;
    Promise.all([getAgentVersion(api, { id: agentId, v: String(a) }), getAgentVersion(api, { id: agentId, v: String(b) })])
      .then(([va, vb]) => {
        if (!cancelled) setState({ status: 'ready', ops: lineDiff(va.editable_prompt ?? '', vb.editable_prompt ?? ''), error: null });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: 'error', ops: [], error });
      });
    return () => {
      cancelled = true;
    };
  }, [api, agentId, a, b]);

  const counts = diffCounts(state.ops);
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-hidden sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t('diffTitle', { a, b })}</DialogTitle>
          <DialogDescription>{state.status === 'ready' ? t('diffSummary', { added: counts.added, removed: counts.removed }) : ' '}</DialogDescription>
        </DialogHeader>
        {state.status === 'loading' ? (
          <Skeleton className="h-64 w-full" aria-busy />
        ) : state.status === 'error' ? (
          <p className="text-sm text-danger">{errorMessage(state.error, tc)}</p>
        ) : (
          <pre className="max-h-[65vh] overflow-auto rounded-md border border-border font-mono text-xs leading-relaxed">
            {state.ops.map((op, i) => (
              <div key={i} className={cn('whitespace-pre-wrap px-3', op.kind === 'add' && 'bg-success/15 text-foreground', op.kind === 'del' && 'bg-danger/10 text-muted-foreground line-through decoration-danger/50')}>
                <span className="mr-2 inline-block w-3 select-none text-muted-foreground">{op.kind === 'add' ? '+' : op.kind === 'del' ? '−' : ' '}</span>
                {op.text || ' '}
              </div>
            ))}
          </pre>
        )}
      </DialogContent>
    </Dialog>
  );
}
