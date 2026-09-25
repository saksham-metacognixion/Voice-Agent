'use client';

import { useApi, useGetFlags, useGetPricing } from '@portal/api-client';
import { knowledgeRolesFor, type AgentDetail } from '@portal/schemas';
import { Alert, Skeleton } from '@portal/ui';
import { useTranslations } from 'next-intl';
import { KnowledgeSources } from '@/src/components/wizard/knowledge-sources';
import { MenuUpload } from '@/src/components/wizard/menu-upload';
import { cheapestPackWith } from '@/src/wizard/plan-gates';

/**
 * D3 Knowledge (spec p. 36): W4's sources on this agent. Gated by the `knowledge_base`
 * plan gate (§5.2); a source added after publish reaches the agent at the next publish
 * (the LLM is versioned with the agent, ADR 0003 §7), and the copy says so.
 */
export function KnowledgeTab({ agent, canEdit }: { agent: AgentDetail; canEdit: boolean }) {
  const t = useTranslations('dashboard.agents.knowledge');
  const tk = useTranslations('wizard.w4');
  const api = useApi();
  const flags = useGetFlags(api, { staleTime: 60_000 });
  const pricing = useGetPricing(api, undefined, { staleTime: 5 * 60_000 });
  const locked = flags.data ? !flags.data.gates.knowledge_base : false;
  const unlock = cheapestPackWith(pricing.data, 'knowledge_base');

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="flex flex-col gap-4">
        {flags.isPending ? <Skeleton className="h-14 w-full" /> : null}
        {locked ? (
          <Alert variant="info" title={tk('lockedTitle')}>
            {unlock ? t('lockedBody', { pack: unlock.name }) : t('lockedBodyGeneric')}
          </Alert>
        ) : null}
        {knowledgeRolesFor(agent).includes('menu') ? <MenuUpload agentId={agent.id} locked={locked || !canEdit} published={Boolean(agent.published_version)} /> : null}
        <KnowledgeSources agentId={agent.id} locked={locked || !canEdit} />
      </div>
      <aside className="flex flex-col gap-3 text-sm text-muted-foreground lg:sticky lg:top-24 lg:self-start">
        <p className="font-medium text-foreground">{tk('asideTitle')}</p>
        <p>{tk('asideBody')}</p>
        <p>{agent.published_version ? t('publishedHint') : tk('asideLive')}</p>
      </aside>
    </div>
  );
}
