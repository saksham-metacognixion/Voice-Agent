'use client';

import { useApi, useGetAgentKnowledgeStats } from '@portal/api-client';
import type { KnowledgeStatsResponse } from '@portal/schemas';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton } from '@portal/ui';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { Fact, LoadError } from '@/src/components/dashboard/query-states';
import { formatNumber } from '@/src/lib/format';

const WINDOWS = [7, 30, 90] as const;
type Window = (typeof WINDOWS)[number];

/**
 * D16: how often this agent used what it knows, over real callers' calls (test calls are
 * left out). `GET /agents/:id/knowledge/stats`; the numbers come from each call's own
 * record, written after the call, so a call from the last minute may not be in them yet.
 */
export function KnowledgeUsage({ agentId }: { agentId: string }) {
  const t = useTranslations('dashboard.agents.knowledge.usage');
  const api = useApi();
  const [days, setDays] = React.useState<Window>(30);
  const stats = useGetAgentKnowledgeStats(api, { id: agentId }, { days }, { staleTime: 60_000 });

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('body')}</CardDescription>
        </div>
        <Select value={String(days)} onValueChange={(v) => setDays(Number(v) as Window)}>
          <SelectTrigger className="w-40" aria-label={t('window')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WINDOWS.map((d) => (
              <SelectItem key={d} value={String(d)}>
                {t('lastDays', { days: d })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent>
        {stats.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : stats.isError ? (
          <LoadError error={stats.error} onRetry={() => void stats.refetch()} />
        ) : (
          <UsageBody stats={stats.data} />
        )}
      </CardContent>
    </Card>
  );
}

function UsageBody({ stats }: { stats: KnowledgeStatsResponse }) {
  const t = useTranslations('dashboard.agents.knowledge.usage');
  if (stats.calls_with_lookups === 0) {
    return <p className="text-sm text-muted-foreground">{stats.calls === 0 ? t('noCalls') : t('notUsed', { calls: stats.calls })}</p>;
  }
  const answerRate = stats.lookups > 0 ? Math.round((stats.hits / stats.lookups) * 100) : 0;
  const top = Math.max(1, ...stats.sources.map((s) => s.hits));
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
        <Fact label={t('callsUsed')}>{t('callsOf', { used: stats.calls_with_lookups, calls: stats.calls })}</Fact>
        <Fact label={t('lookups')}>{formatNumber(stats.lookups, 0)}</Fact>
        <Fact label={t('answered')}>{t('answeredValue', { hits: stats.hits, pct: answerRate })}</Fact>
      </dl>
      {stats.sources.length ? (
        <ul className="flex flex-col gap-2 text-sm" aria-label={t('bySource')}>
          {stats.sources.map((s) => (
            <li key={s.source_id} className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate" dir="auto">
                  {s.name}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">{s.hits === 0 ? t('unused') : t('sourceValue', { hits: s.hits, calls: s.calls })}</span>
              </div>
              {/* One series, one hue; the bar is relative to the busiest source. */}
              <div className="h-1.5 rounded-full bg-muted" aria-hidden>
                <div className="h-1.5 rounded-full bg-primary" style={{ width: `${Math.round((s.hits / top) * 100)}%` }} />
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {stats.other_hits > 0 ? <p className="text-xs text-muted-foreground">{t('other', { hits: stats.other_hits })}</p> : null}
    </div>
  );
}
