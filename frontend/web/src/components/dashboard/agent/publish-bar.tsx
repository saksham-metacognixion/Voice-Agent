'use client';

import { isApiError, useApi, useDiscardAgentDraft, usePublishAgent } from '@portal/api-client';
import type { AgentDetail, LintFinding } from '@portal/schemas';
import { Alert, Button, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Rocket, Undo2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useServerCopy } from '@/src/i18n/server-copy';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { errorMessage } from '@/src/lib/errors';
import { useRole } from '@/src/workspace/use-role';
import { ConfirmDialog } from '@/src/components/dashboard/confirm-dialog';

/**
 * D3's sticky bottom bar (spec p. 36): shown while the draft is ahead of the published
 * version. Publish is §13.6 — lint (errors block, warnings publish), push to the voice
 * platform, go live; numbers bound to `latest_published` pick it up on the next call.
 * A publish does not un-pause a paused agent (ADR 0012 §4), and the bar says so.
 *
 * Publish sends the last *saved* draft. While the Advanced editor holds unsaved edits
 * (`editorDirty`) the button waits and the bar says "save first" — otherwise the person
 * would publish a version that is not what they see on screen (QA-025).
 *
 * `discard` adds the Overview tab's "Discard draft" beside Publish (spec p. 36, QA-078):
 * once the agent has a published version and the draft is ahead of it, the draft pointer
 * goes back to the live version — the Versions tab's "Restore as draft" on the live row,
 * behind a confirmation. Overview only: the Brief and Voice tabs autosave, and a save
 * still in flight would land on the version just restored and fork it again. It waits
 * for unsaved script edits like Publish does.
 */
export function PublishBar({ agent, canEdit, editorDirty = false, discard = false }: { agent: AgentDetail; canEdit: boolean; editorDirty?: boolean; discard?: boolean }) {
  const t = useTranslations('dashboard.agents.publish');
  const tc = useTranslations();
  const copy = useServerCopy();
  const api = useApi();
  const queryClient = useQueryClient();
  const publish = usePublishAgent(api);
  const discardDraft = useDiscardAgentDraft(api);
  const role = useRole();
  const [findings, setFindings] = React.useState<LintFinding[] | null>(null);
  const [confirmDiscard, setConfirmDiscard] = React.useState(false);

  const draft = agent.draft;
  const needsPublish = agent.has_unpublished_changes || (agent.published_version === null && Boolean(draft?.has_prompt));
  if (!needsPublish || !draft) return null;
  const live = agent.published_version;
  const canDiscard = discard && role.canEdit && live !== null && agent.has_unpublished_changes;

  async function runDiscard() {
    const res = await discardDraft.mutateAsync({ params: { id: agent.id } });
    track('agent_draft_discarded', { agent_id: agent.id, version_no: draft!.version_no });
    toast.success(t('discarded', { n: res.draft_version ?? live ?? 0 }));
    await queryClient.invalidateQueries({ queryKey: ['getAgent', { id: agent.id }] });
    void queryClient.invalidateQueries({ queryKey: ['listAgents'] });
    void queryClient.invalidateQueries({ queryKey: ['listAgentVersions', { id: agent.id }] });
  }

  async function run() {
    setFindings(null);
    try {
      const res = await publish.mutateAsync({ params: { id: agent.id }, body: { version_no: draft!.version_no } });
      track('agent_published', { agent_id: agent.id, version_no: res.version_no, from: 'dashboard' });
      toast.success(res.already_published ? t('alreadyLive', { n: res.version_no }) : t('done', { n: res.version_no }));
      const warnings = res.lint.findings.filter((f) => f.severity === 'warning');
      if (warnings.length) setFindings(warnings);
      await queryClient.invalidateQueries({ queryKey: ['getAgent', { id: agent.id }] });
      void queryClient.invalidateQueries({ queryKey: ['listAgents'] });
      void queryClient.invalidateQueries({ queryKey: ['listAgentVersions', { id: agent.id }] });
      void queryClient.invalidateQueries({ queryKey: ['getWorkspaceChecklist'] });
    } catch (e) {
      if (isApiError(e, 'LINT_FAILED')) {
        setFindings(draft!.lint?.findings ?? []);
        toast.error(tc('errors.LINT_FAILED'));
        return;
      }
      toast.error(errorMessage(e, tc));
    }
  }

  return (
    <div className="sticky bottom-3 z-20 flex flex-col gap-2">
      {findings?.length ? (
        <Alert variant={findings.some((f) => f.severity === 'error') ? 'danger' : 'warning'} title={findings.some((f) => f.severity === 'error') ? t('blocked') : t('warnings')}>
          <ul className="list-disc ps-4">
            {findings.map((f, i) => (
              <li key={i}>{copy.finding(f)}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/40 bg-popover px-4 py-3 shadow-popover">
        <div className="text-sm">
          <p className="font-medium">{agent.published_version === null ? t('firstTitle', { n: draft.version_no }) : t('title', { n: draft.version_no, live: agent.published_version })}</p>
          <p className={editorDirty ? 'text-xs text-warning-emphasis' : 'text-xs text-muted-foreground'}>{editorDirty ? t('saveFirst') : agent.status === 'paused' ? t('pausedHint') : t('hint')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canDiscard ? (
            <Button variant="outline" onClick={() => setConfirmDiscard(true)} disabled={editorDirty || publish.isPending}>
              <Undo2 /> {t('discard')}
            </Button>
          ) : null}
          {canEdit ? (
            <Button onClick={() => void run()} loading={publish.isPending} disabled={!draft.has_prompt || editorDirty}>
              <Rocket /> {t('button', { n: draft.version_no })}
            </Button>
          ) : null}
        </div>
      </div>
      {canDiscard ? (
        <ConfirmDialog
          open={confirmDiscard}
          onOpenChange={setConfirmDiscard}
          title={t('discardTitle', { n: draft.version_no })}
          description={t('discardBody', { live: live ?? 0 })}
          consequences={[t('discardEdits', { live: live ?? 0 }), t('discardKept', { n: draft.version_no })]}
          confirmLabel={t('discard')}
          onConfirm={runDiscard}
        />
      ) : null}
    </div>
  );
}
