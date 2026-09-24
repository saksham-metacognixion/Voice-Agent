'use client';

import { useApi, useGetStats } from '@portal/api-client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from '@portal/ui';
import { Activity } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { LoadError } from '@/src/components/dashboard/query-states';
import { formatCreditsValue, formatDuration, formatNumber } from '@/src/lib/format';

/**
 * D1 "Today" (spec p. 33): `GET /stats?range=today`, whole local days in the workspace
 * timezone (`resolveWindow` on the API). Refreshed on every `call:` frame.
 */
export function TodayCard() {
  const t = useTranslations('dashboard.home.today');
  const api = useApi();
  const stats = useGetStats(api, { range: 'today' }, { staleTime: 30_000 });

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="size-4 text-primary" aria-hidden /> {t('title')}
        </CardTitle>
        {stats.data ? <CardDescription>{t('timezone', { tz: stats.data.timezone })}</CardDescription> : null}
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        {stats.isPending ? (
          <div className="grid grid-cols-2 gap-3" aria-busy>
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : stats.isError ? (
          <LoadError compact error={stats.error} onRetry={() => void stats.refetch()} />
        ) : (
          <dl className="grid grid-cols-2 gap-x-3 gap-y-4">
            <Stat label={t('calls')} value={formatNumber(stats.data.calls.total, 0)} hint={stats.data.calls.test ? t('ofWhichTests', { n: stats.data.calls.test }) : undefined} />
            <Stat label={t('missed')} value={formatNumber(stats.data.calls.missed, 0)} tone={stats.data.calls.missed > 0 ? 'danger' : undefined} />
            <Stat label={t('minutes')} value={formatNumber(stats.data.minutes, 1)} />
            <Stat label={t('credits')} value={formatCreditsValue(stats.data.credits_used)} />
            <Stat label={t('avgDuration')} value={formatDuration(stats.data.avg_duration_s)} />
            <Stat label={t('answered')} value={formatNumber(stats.data.calls.answered, 0)} />
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'danger' }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`text-xl font-semibold tabular-nums ${tone === 'danger' ? 'text-danger' : ''}`}>{value}</dd>
      {hint ? <dd className="text-[11px] text-muted-foreground">{hint}</dd> : null}
    </div>
  );
}
