'use client';

import { isApiError, useApi, usePublishAgent } from '@portal/api-client';
import type { AgentDetail, LintFinding } from '@portal/schemas';
import { Alert, Button, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Rocket } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { errorMessage } from '@/src/lib/errors';

/**
 * D3's sticky bottom bar (spec p. 36): shown while the draft is ahead of the published
 * version. Publish is §13.6 — lint (errors block, warnings publish), push to the voice
 * platform, go live; numbers bound to `latest_published` pick it up on the next call.
 * A publish does not un-pause a paused agent (ADR 0012 §4), and the bar says so.
 */
export function PublishBar({ agent, canEdit }: { agent: AgentDetail; canEdit: boolean }) {
  const t = useTranslations('dashboard.agents.publish');
  const tc = useTranslations();
  const api = useApi();
  const queryClient = useQueryClient();
  const publish = usePublishAgent(api);
  const [findings, setFindings] = React.useState<LintFinding[] | null>(null);

  const draft = agent.draft;
  const needsPublish = agent.has_unpublished_changes || (agent.published_version === null && Boolean(draft?.has_prompt));
  if (!needsPublish || !draft) return null;

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
          <ul className="list-disc pl-4">
            {findings.map((f, i) => (
              <li key={i}>{f.message}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/40 bg-popover px-4 py-3 shadow-popover">
        <div className="text-sm">
          <p className="font-medium">{agent.published_version === null ? t('firstTitle', { n: draft.version_no }) : t('title', { n: draft.version_no, live: agent.published_version })}</p>
          <p className="text-xs text-muted-foreground">{agent.status === 'paused' ? t('pausedHint') : t('hint')}</p>
        </div>
        {canEdit ? (
          <Button onClick={() => void run()} loading={publish.isPending} disabled={!draft.has_prompt}>
            <Rocket /> {t('button', { n: draft.version_no })}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
