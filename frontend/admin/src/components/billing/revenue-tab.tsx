'use client';

import { useAdminBillingSummary, useApi } from '@portal/api-client';
import type { AdminBillingSummaryResponse, AdminRange } from '@portal/schemas';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton, cn } from '@portal/ui';
import * as React from 'react';
import { DataTable, type DataColumn } from '@/src/components/common/data-table';
import { LoadError } from '@/src/components/common/query-states';
import { SeriesChart } from '@/src/components/overview/series-chart';
import { formatCents, formatCredits, formatDateTime, formatNumber } from '@/src/lib/format';

type Metric = 'sales_cents' | 'refunds_cents' | 'purchases';
const METRICS: Array<{ key: Metric; label: string }> = [
  { key: 'sales_cents', label: 'Sales' },
  { key: 'refunds_cents', label: 'Refunds' },
  { key: 'purchases', label: 'Purchases' },
];

/** SA9 basic revenue report: sales, refunds, net and credits sold for a range, with a per-day bar. */
export function RevenueTab({ range }: { range: AdminRange }) {
  const api = useApi();
  const summary = useAdminBillingSummary(api, { range }, { staleTime: 60_000 });
  const [metric, setMetric] = React.useState<Metric>('sales_cents');
  const s = summary.data;
  const currency = s?.sales[0]?.currency ?? s?.refunds[0]?.currency ?? 'USD';
  const series = React.useMemo(() => (s?.series ?? []).map((d) => ({ day: d.day, value: d[metric] })), [s, metric]);
  const fmt = (v: number) => (metric === 'purchases' ? formatNumber(v, 0) : formatCents(v, currency));

  if (summary.isPending) return <Skeleton className="h-96" aria-busy />;
  if (summary.isError) return <LoadError error={summary.error} onRetry={() => void summary.refetch()} />;
  if (!s) return null;

  const currencies = [...new Set([...s.sales.map((x) => x.currency), ...s.refunds.map((x) => x.currency)])];
  const totalCredits = s.sales.reduce((n, x) => n + x.credits, 0);
  const reversed = s.refunds.reduce((n, x) => n + x.credits_reversed, 0);
  const packsSold = s.packs.reduce((n, p) => n + p.purchases, 0);

  const packColumns: Array<DataColumn<AdminBillingSummaryResponse['packs'][number]>> = [
    { key: 'pack', header: 'Pack', cell: (p) => p.pack_name ?? p.pack_id },
    { key: 'purchases', header: 'Purchases', align: 'right', cell: (p) => formatNumber(p.purchases, 0) },
    { key: 'credits', header: 'Credits', align: 'right', cell: (p) => formatCredits(p.credits) },
    { key: 'amount', header: 'Sales', align: 'right', cell: (p) => formatCents(p.amount_cents, currency) },
  ];

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        {formatDateTime(s.from)} → {formatDateTime(s.to)} · sales are purchases created in range and paid (a refunded sale still counts, its refund on the other side)
      </p>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {(currencies.length ? currencies : ['USD']).map((c) => {
          const sales = s.sales.find((x) => x.currency === c);
          const refunds = s.refunds.find((x) => x.currency === c);
          const net = (sales?.amount_cents ?? 0) - (refunds?.amount_cents ?? 0);
          return (
            <Tile key={c} title={`Money · ${c}`} description="Gross sales, refunds and net">
              <Stat label="Sales" value={formatCents(sales?.amount_cents ?? 0, c)} hint={`${sales?.purchases ?? 0} purchase${sales?.purchases === 1 ? '' : 's'}`} />
              <Stat label="Refunds" value={formatCents(refunds?.amount_cents ?? 0, c)} hint={`${refunds?.count ?? 0} refund${refunds?.count === 1 ? '' : 's'}`} tone={refunds?.amount_cents ? 'danger' : undefined} />
              <Stat label="Net" value={formatCents(net, c)} />
            </Tile>
          );
        })}
        <Tile title="Credits" description="Sold in range, minus what refunds drew back">
          <Stat label="Sold" value={formatCredits(totalCredits)} />
          <Stat label="Reversed" value={formatCredits(reversed)} tone={reversed ? 'danger' : undefined} />
          <Stat label="Net" value={formatCredits(Math.round((totalCredits - reversed) * 100) / 100)} />
        </Tile>
        <Tile title="Packs and top-ups">
          <Stat label="Packs sold" value={formatNumber(packsSold, 0)} />
          <Stat label="Failed top-ups" value={formatNumber(s.failed_topups, 0)} tone={s.failed_topups ? 'warning' : undefined} hint="Declined or never confirmed" />
        </Tile>
      </div>
      <Card>
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-3 pb-0">
          <div>
            <CardTitle className="text-sm">Per day</CardTitle>
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
        <CardContent className="pt-4">{series.length ? <SeriesChart series={series} label={`${METRICS.find((m) => m.key === metric)?.label} per day`} format={fmt} /> : <p className="py-10 text-center text-sm text-muted-foreground">No days in range.</p>}</CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-0">
          <CardTitle className="text-sm">Packs sold</CardTitle>
        </CardHeader>
        <CardContent className="pt-4">{s.packs.length ? <DataTable rows={s.packs} columns={packColumns} rowKey={(p) => p.pack_id} label="Packs sold" dense /> : <p className="text-sm text-muted-foreground">No paid purchases in range.</p>}</CardContent>
      </Card>
    </div>
  );
}

export function Tile({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-0">
        <CardTitle className="text-sm">{title}</CardTitle>
        {description ? <CardDescription className="text-xs">{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="grid grid-cols-3 gap-x-4 gap-y-3 pt-4">{children}</CardContent>
    </Card>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: 'danger' | 'warning' }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn('text-lg font-semibold tabular-nums leading-tight', tone === 'danger' && 'text-danger', tone === 'warning' && 'text-warning-emphasis')}>{value}</span>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}
