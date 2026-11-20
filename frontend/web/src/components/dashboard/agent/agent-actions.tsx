'use client';

import { isApiError, useApi, useDeleteAgent, useDuplicateAgent, usePauseAgent, useResumeAgent } from '@portal/api-client';
import { copyAgentName, type AgentDetail, type AgentSummary } from '@portal/schemas';
import { toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { track } from '@/src/analytics/posthog';
import { errorMessage } from '@/src/lib/errors';
import { ConfirmDialog } from '@/src/components/dashboard/confirm-dialog';

type AgentRef = Pick<AgentSummary, 'id' | 'name' | 'status'>;

/**
 * Pause/Resume, Duplicate and Delete — the D3 list menu and the Settings tab's danger
 * zone (spec p. 35–36, QA-078) call the same three functions, so the two places cannot
 * disagree on what a click does or says. Roles are the caller's to check (`useRole()`);
 * the API checks them again.
 */
export function useAgentActions() {
  const t = useTranslations('dashboard.agents');
  const tc = useTranslations();
  const api = useApi();
  const queryClient = useQueryClient();
  const pause = usePauseAgent(api);
  const resume = useResumeAgent(api);
  const duplicate = useDuplicateAgent(api);
  const remove = useDeleteAgent(api);

  async function refresh(agentId: string) {
    await queryClient.invalidateQueries({ queryKey: ['getAgent', { id: agentId }] });
    void queryClient.invalidateQueries({ queryKey: ['listAgents'] });
  }

  return {
    pausing: pause.isPending || resume.isPending,
    duplicating: duplicate.isPending,

    async togglePause(agent: AgentRef) {
      try {
        if (agent.status === 'paused') await resume.mutateAsync({ params: { id: agent.id } });
        else await pause.mutateAsync({ params: { id: agent.id } });
        await refresh(agent.id);
        toast.success(agent.status === 'paused' ? t('settings.resumed') : t('settings.paused'));
      } catch (e) {
        toast.error(errorMessage(e, tc));
      }
    },

    /** The copy, or null after a toast saying why not. Named in the portal's language. */
    async duplicate(agent: AgentRef): Promise<AgentDetail | null> {
      try {
        const name = copyAgentName(agent.name, (n) => t('menu.copyName', { name: n }));
        const copy = await duplicate.mutateAsync({ params: { id: agent.id }, body: { name } });
        track('agent_duplicated', { agent_id: copy.id, source_agent_id: agent.id });
        toast.success(t('menu.duplicated', { name: copy.name }));
        void queryClient.invalidateQueries({ queryKey: ['listAgents'] });
        return copy;
      } catch (e) {
        toast.error(isApiError(e, 'PLAN_LIMIT') ? t('menu.limit') : errorMessage(e, tc));
        return null;
      }
    },

    /** Throws, so `ConfirmDialog` keeps itself open with the reason (a number still on the agent). */
    async remove(agent: AgentRef) {
      await remove.mutateAsync({ params: { id: agent.id } });
      track('agent_deleted', { agent_id: agent.id });
      toast.success(t('settings.deleted'));
      await queryClient.invalidateQueries({ queryKey: ['listAgents'] });
    },
  };
}

/** "Delete {name}?" — the one confirmation for deleting an agent, wherever it is asked from. */
export function DeleteAgentDialog({
  agent,
  open,
  onOpenChange,
  onDeleted,
}: {
  agent: AgentRef;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}) {
  const t = useTranslations('dashboard.agents.settings');
  const actions = useAgentActions();
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('deleteTitle', { name: agent.name })}
      description={t('deleteBody')}
      confirmLabel={t('delete')}
      onConfirm={async () => {
        await actions.remove(agent);
        onDeleted?.();
      }}
    />
  );
}
