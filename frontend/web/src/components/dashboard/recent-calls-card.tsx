'use client';

import { useApi, useListAgents, useListCalls } from '@portal/api-client';
import type { CallSummary } from '@portal/schemas';
import { Button, Card, CardContent, CardHeader, CardTitle, EmptyState, Skeleton } from '@portal/ui';
import { ChevronRight, PhoneCall } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { LoadError } from '@/src/components/dashboard/query-states';
import { CallStatusBadge, SentimentBadge } from '@/src/components/dashboard/status-badges';
import { formatCreditsValue, formatDateTime, formatDuration, formatPhone } from '@/src/lib/format';
import { callPath, routes } from '@/src/routes';
import { useWorkspace } from '@/src/workspace/workspace-provider';

/** D1 recent calls (spec p. 33): `GET /calls?limit=5`, each row opening the D2 drawer. */
export function RecentCallsCard() {
  const t = useTranslations('dashboard.home.recent');
  const tc = useTranslations('dashboard.calls');
  const api = useApi();
  const ws = useWorkspace();
  const calls = useListCalls(api, { limit: 5 }, { staleTime: 15_000 });
  const agents = useListAgents(api, { limit: 50 }, { staleTime: 60_000 });
  const agentName = React.useMemo(() => new Map((agents.data?.items ?? []).map((a) => [a.id, a.name])), [agents.data]);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <PhoneCall className="size-4 text-primary" aria-hidden /> {t('title')}
        </CardTitle>
        <Button size="sm" variant="ghost" asChild>
          <Link href={routes.app.calls}>
            {t('all')} <ChevronRight />
          </Link>
        </Button>
      </CardHeader>
      <CardContent>
        {calls.isPending ? (
          <div className="flex flex-col gap-2" aria-busy>
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </div>
        ) : calls.isError ? (
          <LoadError compact error={calls.error} onRetry={() => void calls.refetch()} />
        ) : calls.data.items.length === 0 ? (
          <EmptyState className="py-8" icon={<PhoneCall />} title={tc('empty')} />
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {calls.data.items.map((call) => (
              <RecentCallRow key={call.id} call={call} agent={call.agent_id ? agentName.get(call.agent_id) : undefined} timeZone={ws.workspace?.timezone} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function RecentCallRow({ call, agent, timeZone }: { call: CallSummary; agent: string | undefined; timeZone: string | undefined }) {
  const tc = useTranslations('dashboard.calls');
  return (
    <li>
      <Link href={callPath(call.id)} className="flex items-center gap-3 py-2.5 transition-colors hover:bg-muted/60 sm:gap-4">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{call.channel === 'web' ? tc('browserTest') : call.from_number ? formatPhone(call.from_number) : tc('unknownCaller')}</p>
          <p className="truncate text-xs text-muted-foreground">
            {formatDateTime(call.started_at ?? call.created_at, timeZone)}
            {agent ? ` · ${agent}` : ''}
          </p>
        </div>
        <span className="hidden text-xs tabular-nums text-muted-foreground sm:inline">{formatDuration(call.duration_s)}</span>
        <span className="hidden text-xs tabular-nums text-muted-foreground md:inline">{call.credits_charged !== null ? tc('creditsShort', { n: formatCreditsValue(call.credits_charged) }) : ''}</span>
        <SentimentBadge value={call.sentiment} compact />
        <CallStatusBadge status={call.status} />
      </Link>
    </li>
  );
}
