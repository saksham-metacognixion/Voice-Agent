'use client';

import { useApi, useListCalls, useListVoices } from '@portal/api-client';
import type { AgentDetail } from '@portal/schemas';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Skeleton } from '@portal/ui';
import { PhoneCall } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { BriefCard } from '@/src/components/wizard/brief-card';
import { Fact, LoadError } from '@/src/components/dashboard/query-states';
import { AgentStatusBadge, CallStatusBadge, TierBadge } from '@/src/components/dashboard/status-badges';
import { formatDateTime, formatDuration, formatPhone } from '@/src/lib/format';
import { agentPath, callPath, routes } from '@/src/routes';
import { useWorkspace } from '@/src/workspace/workspace-provider';

/**
 * D3 Overview (spec p. 36): what is live and what is drafted, side by side — tier,
 * voice, languages, limits — from `GET /agents/:id` (the `agents` columns are the live
 * copy, `draft.settings` the draft's), the generated brief card, and this agent's last
 * calls.
 */
export function OverviewTab({ agent }: { agent: AgentDetail }) {
  const t = useTranslations('dashboard.agents.overview');
  const ta = useTranslations('dashboard.agents');
  const tl = useTranslations('dashboard.calls');
  const api = useApi();
  const ws = useWorkspace();
  const live = agent.published;
  const draft = agent.draft;
  const shown = draft ?? live;
  const voices = useListVoices(api, { lang: shown?.settings.primary_language ?? agent.primary_language }, { staleTime: 5 * 60_000 });
  const tw = useTranslations('wizard.w3');
  // Never the raw id: a voice missing from the catalogue is still the agent's voice.
  const voiceName = (id: string | null) => (id ? voices.data?.items.find((v) => v.id === id)?.name ?? tw('currentVoice') : '–');
  const calls = useListCalls(api, { agent_id: agent.id, limit: 5 }, { staleTime: 15_000 });

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>{t('configuration')}</CardTitle>
            <CardDescription>{live ? t('liveVsDraft') : t('draftOnly')}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr>
                    <th className="py-1.5 text-start font-medium">{t('setting')}</th>
                    <th className="py-1.5 text-start font-medium">{ta('live')} {live ? `v${live.version_no}` : ''}</th>
                    <th className="py-1.5 text-start font-medium">{ta('draft')} {draft ? `v${draft.version_no}` : ''}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  <Row label={t('tier')} live={live ? <TierBadge tier={agent.tier} /> : '–'} draft={draft ? <TierBadge tier={draft.settings.tier} /> : '–'} changed={Boolean(live && draft && agent.tier !== draft.settings.tier)} />
                  <Row label={t('voice')} live={live ? voiceName(agent.voice_id) : '–'} draft={draft ? voiceName(draft.settings.voice_id) : '–'} changed={Boolean(live && draft && agent.voice_id !== draft.settings.voice_id)} />
                  <Row label={t('language')} live={live ? [agent.primary_language, ...agent.languages].join(', ') : '–'} draft={draft ? [draft.settings.primary_language, ...draft.settings.languages].join(', ') : '–'} changed={Boolean(live && draft && [agent.primary_language, ...agent.languages].join() !== [draft.settings.primary_language, ...draft.settings.languages].join())} />
                  <Row label={t('maxDuration')} live={live ? formatDuration(agent.max_call_duration_s) : '–'} draft={draft ? formatDuration(draft.settings.max_call_duration_s) : '–'} changed={Boolean(live && draft && agent.max_call_duration_s !== draft.settings.max_call_duration_s)} />
                  <Row label={t('recording')} live={live ? (agent.recording_enabled ? t('on') : t('off')) : '–'} draft={draft ? (draft.settings.recording_enabled ? t('on') : t('off')) : '–'} changed={Boolean(live && draft && agent.recording_enabled !== draft.settings.recording_enabled)} />
                  <Row label={t('greeting')} live={live?.greeting ?? '–'} draft={draft?.greeting ?? '–'} changed={Boolean(live && draft && live.greeting !== draft.greeting)} />
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>{t('recentCalls')}</CardTitle>
            <Button size="sm" variant="ghost" asChild>
              <Link href={`${routes.app.calls}?agent=${agent.id}`}>{t('allCalls')}</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {calls.isPending ? (
              <Skeleton className="h-24 w-full" aria-busy />
            ) : calls.isError ? (
              <LoadError compact error={calls.error} onRetry={() => void calls.refetch()} />
            ) : calls.data.items.length === 0 ? (
              <EmptyState className="py-6" icon={<PhoneCall />} title={t('noCalls')} />
            ) : (
              <ul className="divide-y divide-border">
                {calls.data.items.map((call) => (
                  <li key={call.id}>
                    <Link href={callPath(call.id)} className="flex items-center gap-3 py-2 text-sm hover:bg-muted/60">
                      <span className="min-w-0 flex-1 truncate">{call.channel === 'web' ? tl('browserTest') : formatPhone(call.from_number)}</span>
                      <span className="text-xs text-muted-foreground">{formatDateTime(call.started_at ?? call.created_at, ws.workspace?.timezone)}</span>
                      <span className="text-xs tabular-nums text-muted-foreground">{formatDuration(call.duration_s)}</span>
                      <CallStatusBadge status={call.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <aside className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>{t('status')}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-3">
              <Fact label={t('statusLabel')}>
                <AgentStatusBadge status={agent.status} />
              </Fact>
              <Fact label={t('numbers')}>
                {agent.numbers_attached ? (
                  <Link href={routes.app.numbers} className="text-primary hover:underline">
                    {ta('numbers', { n: agent.numbers_attached })}
                  </Link>
                ) : (
                  t('noNumbers')
                )}
              </Fact>
              <Fact label={ta('live')}>{agent.published_version ? `v${agent.published_version}` : ta('notPublished')}</Fact>
              <Fact label={ta('draft')}>
                {agent.draft_version ? `v${agent.draft_version}` : '–'} {agent.has_unpublished_changes ? <Badge variant="warning">{ta('unpublished')}</Badge> : null}
              </Fact>
              <Fact label={t('template')}>{agent.template_id ? ta(`templates.${agent.template_id}`) : ta('templates.custom')}</Fact>
              <Fact label={t('created')}>{formatDateTime(agent.created_at, ws.workspace?.timezone)}</Fact>
              {live?.published_at ? <Fact label={t('publishedAt')}>{formatDateTime(live.published_at, ws.workspace?.timezone)}</Fact> : null}
              {draft ? <Fact label={t('draftUpdated')}>{formatDateTime(draft.created_at, ws.workspace?.timezone)}</Fact> : null}
            </dl>
            {!shown?.has_prompt ? (
              <Button className="mt-4 w-full" variant="outline" asChild>
                <Link href={agentPath(agent.id, 'brief')}>{t('finishBrief')}</Link>
              </Button>
            ) : null}
          </CardContent>
        </Card>
        {shown ? <BriefCard brief={shown.brief} generated={shown.brief_card} agentName={shown.brief.agent_name ?? agent.name} /> : null}
      </aside>
    </div>
  );
}

function Row({ label, live, draft, changed }: { label: string; live: React.ReactNode; draft: React.ReactNode; changed: boolean }) {
  return (
    <tr>
      <td className="py-2 pe-3 text-muted-foreground">{label}</td>
      <td className="py-2 pe-3">{live}</td>
      <td className={`py-2 ${changed ? 'font-medium text-warning-emphasis' : ''}`}>{draft}</td>
    </tr>
  );
}
