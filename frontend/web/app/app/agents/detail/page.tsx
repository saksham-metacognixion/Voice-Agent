'use client';

import { isApiError, useApi, useGetAgent } from '@portal/api-client';
import { roleAtLeast } from '@portal/schemas';
import { Button, ErrorState, PageLoader, Tabs, TabsContent, TabsList, TabsTrigger } from '@portal/ui';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { BriefTab } from '@/src/components/dashboard/agent/brief-tab';
import { KnowledgeTab } from '@/src/components/dashboard/agent/knowledge-tab';
import { OverviewTab } from '@/src/components/dashboard/agent/overview-tab';
import { PromptTab } from '@/src/components/dashboard/agent/prompt-tab';
import { PublishBar } from '@/src/components/dashboard/agent/publish-bar';
import { SettingsTab } from '@/src/components/dashboard/agent/settings-tab';
import { TestTab } from '@/src/components/dashboard/agent/test-tab';
import { VersionsTab } from '@/src/components/dashboard/agent/versions-tab';
import { VoiceTab } from '@/src/components/dashboard/agent/voice-tab';
import { AgentStatusBadge, TierBadge } from '@/src/components/dashboard/status-badges';
import { PageHeader } from '@/src/components/shell/portal-shell';
import { useDashboardLive } from '@/src/dashboard/use-dashboard-live';
import { errorMessage } from '@/src/lib/errors';
import { useUrlQuery } from '@/src/lib/use-url-query';
import { AGENT_TABS, routes, type AgentTab } from '@/src/routes';
import { useWorkspace } from '@/src/workspace/workspace-provider';

/**
 * D3 agent configuration (spec pp. 35–36): `/app/agents/detail/?id=&tab=` — the spec's
 * `/app/agents/[id]/*`, flattened for the static export. Eight tabs over one
 * `GET /agents/:id`; the tab is in the URL so a link lands on it and the back button
 * walks tabs. The `agent:{id}` SSE topic refreshes the agent after a generation, a
 * patch, a publish or a pause from anywhere.
 */
export default function AgentDetailPage() {
  const t = useTranslations();
  const ta = useTranslations('dashboard.agents');
  const api = useApi();
  const ws = useWorkspace();
  const [params, setParams] = useUrlQuery();
  const id = params.get('id');
  const tabParam = params.get('tab');
  const tab: AgentTab = (AGENT_TABS as readonly string[]).includes(tabParam ?? '') ? (tabParam as AgentTab) : 'overview';
  const agent = useGetAgent(api, { id: id ?? '' }, { enabled: Boolean(id), staleTime: 10_000 });
  useDashboardLive();

  const role = ws.workspace?.role ?? 'viewer';
  const canEdit = roleAtLeast(role, 'editor');
  const canAdmin = roleAtLeast(role, 'admin');

  const setTab = (next: string) => {
    setParams((q) => {
      if (next === 'overview') q.delete('tab');
      else q.set('tab', next);
    });
  };

  if (!id) {
    return <ErrorState title={ta('detail.missing')} action={<Button asChild variant="outline"><Link href={routes.app.agents}>{ta('detail.back')}</Link></Button>} />;
  }
  if (agent.isPending) return <PageLoader label={t('common.loading')} />;
  if (agent.isError) {
    return (
      <ErrorState
        title={isApiError(agent.error, 'NOT_FOUND') ? ta('detail.notFound') : t('errors.loadFailed')}
        description={isApiError(agent.error, 'NOT_FOUND') ? undefined : errorMessage(agent.error, t)}
        action={
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link href={routes.app.agents}>{ta('detail.back')}</Link>
            </Button>
            {!isApiError(agent.error, 'NOT_FOUND') ? <Button onClick={() => void agent.refetch()}>{t('common.retry')}</Button> : null}
          </div>
        }
      />
    );
  }
  const data = agent.data;

  return (
    <>
      <div className="flex flex-col gap-2">
        <Link href={routes.app.agents} className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" aria-hidden /> {ta('detail.back')}
        </Link>
        <PageHeader
          title={
            <span className="flex flex-wrap items-center gap-2">
              {data.name}
              <TierBadge tier={data.draft?.settings.tier ?? data.tier} />
              <AgentStatusBadge status={data.status} />
            </span>
          }
          description={ta('detail.subtitle', { live: data.published_version ? `v${data.published_version}` : ta('notPublished'), draft: data.draft_version ? `v${data.draft_version}` : '–' })}
        />
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label={ta('detail.tabs')}>
          {AGENT_TABS.map((key) => (
            <TabsTrigger key={key} value={key}>
              {ta(`tabs.${key}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="overview">{tab === 'overview' ? <OverviewTab agent={data} /> : null}</TabsContent>
        <TabsContent value="brief">{tab === 'brief' ? <BriefTab key={data.draft?.version_no ?? 'none'} agent={data} canEdit={canEdit} /> : null}</TabsContent>
        <TabsContent value="prompt">{tab === 'prompt' ? <PromptTab agent={data} canEdit={canEdit} /> : null}</TabsContent>
        <TabsContent value="voice">{tab === 'voice' ? <VoiceTab key={data.draft?.version_no ?? 'none'} agent={data} canEdit={canEdit} /> : null}</TabsContent>
        <TabsContent value="knowledge">{tab === 'knowledge' ? <KnowledgeTab agent={data} canEdit={canEdit} /> : null}</TabsContent>
        <TabsContent value="test">{tab === 'test' ? <TestTab agent={data} canEdit={canEdit} /> : null}</TabsContent>
        <TabsContent value="versions">{tab === 'versions' ? <VersionsTab agent={data} canEdit={canEdit} /> : null}</TabsContent>
        <TabsContent value="settings">{tab === 'settings' ? <SettingsTab key={data.draft?.version_no ?? 'none'} agent={data} canEdit={canEdit} canAdmin={canAdmin} /> : null}</TabsContent>
      </Tabs>

      {tab !== 'test' ? <PublishBar agent={data} canEdit={canEdit} /> : null}
    </>
  );
}
