'use client';

import { useAdminFunnel, useAdminKpis, useApi } from '@portal/api-client';
import type { AdminRange } from '@portal/schemas';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton, cn } from '@portal/ui';
import * as React from 'react';
import { AdminShell } from '@/src/components/shell/admin-shell';
import { PageHeader } from '@/src/components/shell/page-header';
import { LoadError } from '@/src/components/common/query-states';
import { AttentionList, KpiCards } from '@/src/components/overview/kpi-cards';
import { Funnel } from '@/src/components/overview/funnel';
import { SeriesChart } from '@/src/components/overview/series-chart';
import { formatCents, formatCredits, formatDateTime, formatNumber } from '@/src/lib/format';
import { pickParam, setParam, useUrlQuery } from '@/src/lib/use-url-query';

const RANGES: AdminRange[] = ['7d', '30d', '90d'];
type Metric = 'calls' | 'credits_used' | 'signups' | 'sales_cents';
const METRICS: Array<{ key: Metric; label: string }> = [
  { key: 'calls', label: 'Calls' },
  { key: 'credits_used', label: 'Credits' },
  { key: 'signups', label: 'Sign-ups' },
  { key: 'sales_cents', label: 'Sales' },
];

export default function OverviewPage() {
  return (
    <AdminShell>
      <Overview />
    </AdminShell>
  );
}

function Overview() {
  const api = useApi();
  const [params, setQuery] = useUrlQuery();
  const range = pickParam(params, 'range', RANGES, '30d');
  const kpis = useAdminKpis(api, { range }, { staleTime: 60_000 });
  const funnel = useAdminFunnel(api, { range }, { staleTime: 60_000 });
  const [metric, setMetric] = React.useState<Metric>('calls');
  const series = React.useMemo(() => (kpis.data?.series ?? []).map((d) => ({ day: d.day, value: d[metric] })), [kpis.data, metric]);
  const fmt = (v: number) => (metric === 'sales_cents' ? formatCents(v, kpis.data?.credit_sales.by_currency[0]?.currency ?? 'USD') : metric === 'credits_used' ? formatCredits(v) : formatNumber(v, 0));

  return (
    <>
      <PageHeader
        title="Overview"
        crumbs={[{ label: 'Overview' }]}
        description={kpis.data ? `${formatDateTime(kpis.data.from)} → ${formatDateTime(kpis.data.to)}` : undefined}
        actions={
          <div role="tablist" aria-label="Range" className="inline-flex rounded-md border border-border bg-muted p-0.5 text-xs">
            {RANGES.map((r) => (
              <button key={r} type="button" role="tab" aria-selected={range === r} onClick={() => setQuery((q) => setParam(q, 'range', r === '30d' ? null : r), 'replace')} className={cn('rounded px-3 py-1.5 font-medium transition-colors', range === r ? 'bg-card text-foreground shadow-card' : 'text-muted-foreground hover:text-foreground')}>
                {r}
              </button>
            ))}
          </div>
        }
      />

      {kpis.isPending ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-busy>
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      ) : kpis.isError ? (
        <LoadError error={kpis.error} onRetry={() => void kpis.refetch()} />
      ) : (
        <>
          <KpiCards k={kpis.data} />
          <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
            <Card>
              <CardHeader className="flex-row flex-wrap items-start justify-between gap-3 pb-0">
                <div>
                  <CardTitle className="text-sm">Daily activity</CardTitle>
                  <CardDescription className="text-xs">One bar per UTC day in range</CardDescription>
                </div>
                <div role="tablist" aria-label="Metric" className="inline-flex rounded-md border border-border bg-muted p-0.5 text-xs">
                  {METRICS.map((m) => (
                    <button key={m.key} type="button" role="tab" aria-selected={metric === m.key} onClick={() => setMetric(m.key)} className={cn('rounded px-2.5 py-1 font-medium transition-colors', metric === m.key ? 'bg-card text-foreground shadow-card' : 'text-muted-foreground hover:text-foreground')}>
                      {m.label}
                    </button>
                  ))}
                </div>
              </CardHeader>
              <CardContent className="pt-4">
                {series.length ? <SeriesChart series={series} label={`${METRICS.find((m) => m.key === metric)?.label} per day`} format={fmt} /> : <p className="py-10 text-center text-sm text-muted-foreground">No days in range.</p>}
              </CardContent>
            </Card>
            <AttentionList a={kpis.data.attention} />
          </div>
        </>
      )}

      {funnel.isPending ? <Skeleton className="h-64" aria-busy /> : funnel.isError ? <LoadError error={funnel.error} onRetry={() => void funnel.refetch()} /> : <Funnel f={funnel.data} />}
    </>
  );
}
