'use client';

import { useAdminGetBreakageReport, useAdminGetCogsReport, useAdminGetDeferredReport, useApi } from '@portal/api-client';
import type { AdminCogsReport, AdminRange } from '@portal/schemas';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from '@portal/ui';
import * as React from 'react';
import { Stat, Tile } from '@/src/components/billing/revenue-tab';
import { DataTable, type DataColumn } from '@/src/components/common/data-table';
import { LoadError } from '@/src/components/common/query-states';
import { SeriesChart } from '@/src/components/overview/series-chart';
import { formatCents, formatCredits, formatDateTime, formatMinutes, formatNumber, formatPercent } from '@/src/lib/format';

/*
 * Admin §9 finance reports beside SA9's revenue: what calls cost us (COGS), what paid
 * credits are still owed as service (deferred), and what expired unused (breakage).
 * Credits are valued at the price their own pack paid; currencies are never added up.
 */

function Loading({ query }: { query: { isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown } }) {
  if (query.isPending) return <Skeleton className="h-96" aria-busy />;
  if (query.isError) return <LoadError error={query.error} onRetry={() => void query.refetch()} />;
  return null;
}

export function CogsTab({ range }: { range: AdminRange }) {
  const api = useApi();
  const report = useAdminGetCogsReport(api, { range }, { staleTime: 60_000 });
  const r = report.data;
  if (!r) return <Loading query={report} />;
  const price = r.price_currency ?? 'USD';
  const tierColumns: Array<DataColumn<AdminCogsReport['by_tier'][number]>> = [
    { key: 'tier', header: 'Tier', cell: (t) => <span className="capitalize">{t.tier}</span> },
    { key: 'calls', header: 'Calls', align: 'right', cell: (t) => formatNumber(t.calls, 0) },
    { key: 'credits', header: 'Credits billed', align: 'right', cell: (t) => formatCredits(t.credits_billed) },
    { key: 'cost', header: 'Platform cost', align: 'right', cell: (t) => formatCents(t.platform_cost_cents) },
    { key: 'per', header: 'Cost per credit', align: 'right', cell: (t) => (t.credits_billed > 0 ? formatCents(t.platform_cost_cents / t.credits_billed) : '–') },
  ];
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        {formatDateTime(r.from)} → {formatDateTime(r.to)} · every call that rang (declined ones cost nothing), tests included
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        <Tile title="Usage" description="What the calls billed">
          <Stat label="Calls" value={formatNumber(r.calls, 0)} />
          <Stat label="Minutes" value={formatMinutes(r.billed_seconds / 60)} />
          <Stat label="Credits" value={formatCredits(r.credits_billed)} />
        </Tile>
        <Tile title="Cost and margin" description={r.avg_price_cents_per_credit === null ? 'No single sale price to estimate revenue with' : `Revenue estimated at ${formatCents(r.avg_price_cents_per_credit, price)} per credit (12-month average)`}>
          <Stat label="Platform cost" value={formatCents(r.platform_cost_cents)} hint={r.calls_without_cost ? `${r.calls_without_cost} calls not costed yet` : undefined} tone={r.calls_without_cost ? 'warning' : undefined} />
          <Stat label="Est. revenue" value={r.estimated_revenue_cents === null ? '–' : formatCents(r.estimated_revenue_cents, price)} />
          <Stat label="Est. margin" value={formatPercent(r.estimated_margin_pct)} tone={r.estimated_margin_pct !== null && r.estimated_margin_pct < 0 ? 'danger' : undefined} />
        </Tile>
      </div>
      <Card>
        <CardHeader className="pb-0">
          <CardTitle className="text-sm">Platform cost per day</CardTitle>
          <CardDescription className="text-xs">One bar per UTC day</CardDescription>
        </CardHeader>
        <CardContent className="pt-4">{r.by_day.length ? <SeriesChart series={r.by_day.map((d) => ({ day: d.day, value: d.platform_cost_cents }))} label="Platform cost per day" format={(v) => formatCents(v)} /> : <p className="py-10 text-center text-sm text-muted-foreground">No calls in range.</p>}</CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-0">
          <CardTitle className="text-sm">By tier</CardTitle>
        </CardHeader>
        <CardContent className="pt-4">{r.by_tier.length ? <DataTable rows={r.by_tier} columns={tierColumns} rowKey={(t) => t.tier} label="Cost by tier" dense /> : <p className="text-sm text-muted-foreground">No calls in range.</p>}</CardContent>
      </Card>
    </div>
  );
}

export function DeferredTab() {
  const api = useApi();
  const report = useAdminGetDeferredReport(api, { staleTime: 60_000 });
  const r = report.data;
  if (!r) return <Loading query={report} />;
  type Month = (typeof r.by_expiry_month)[number];
  const monthColumns: Array<DataColumn<Month>> = [
    { key: 'month', header: 'Expires in', cell: (m) => m.month },
    { key: 'currency', header: 'Currency', cell: (m) => m.currency },
    { key: 'credits', header: 'Credits', align: 'right', cell: (m) => formatCredits(m.credits) },
    { key: 'value', header: 'Value', align: 'right', cell: (m) => formatCents(m.value_cents, m.currency) },
  ];
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">As of {formatDateTime(r.as_of)} · paid credits not yet used or expired, valued at what their own pack paid per credit</p>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {(r.paid.length ? r.paid : [{ currency: 'USD', credits: 0, value_cents: 0 }]).map((p) => (
          <Tile key={p.currency} title={`Deferred · ${p.currency}`} description="Owed as future calls">
            <Stat label="Value" value={formatCents(p.value_cents, p.currency)} />
            <Stat label="Credits" value={formatCredits(p.credits)} />
            <Stat label="Workspaces" value={formatNumber(r.workspaces, 0)} />
          </Tile>
        ))}
        <Tile title="Unpaid credits" description="Trial and staff adjustments: no revenue behind them">
          <Stat label="Credits" value={formatCredits(r.unpaid_credits)} />
        </Tile>
      </div>
      <Card>
        <CardHeader className="pb-0">
          <CardTitle className="text-sm">By expiry month</CardTitle>
          <CardDescription className="text-xs">What turns into breakage each month if it is not used</CardDescription>
        </CardHeader>
        <CardContent className="pt-4">{r.by_expiry_month.length ? <DataTable rows={r.by_expiry_month} columns={monthColumns} rowKey={(m) => `${m.month}-${m.currency}`} label="Deferred by expiry month" dense /> : <p className="text-sm text-muted-foreground">No paid credits outstanding.</p>}</CardContent>
      </Card>
    </div>
  );
}

export function BreakageTab({ range }: { range: AdminRange }) {
  const api = useApi();
  const report = useAdminGetBreakageReport(api, { range }, { staleTime: 60_000 });
  const r = report.data;
  const series = React.useMemo(() => {
    const byDay = new Map<string, number>();
    for (const d of r?.by_day ?? []) byDay.set(d.day, (byDay.get(d.day) ?? 0) + d.credits);
    return [...byDay].map(([day, value]) => ({ day, value }));
  }, [r]);
  if (!r) return <Loading query={report} />;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        {formatDateTime(r.from)} → {formatDateTime(r.to)} · credits that expired unused (12 months after purchase), valued per lot
      </p>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {(r.paid.length ? r.paid : [{ currency: 'USD', credits: 0, value_cents: 0 }]).map((p) => (
          <Tile key={p.currency} title={`Breakage · ${p.currency}`} description="Paid credits that expired">
            <Stat label="Value" value={formatCents(p.value_cents, p.currency)} />
            <Stat label="Credits" value={formatCredits(p.credits)} />
            <Stat label="Lots" value={formatNumber(r.lots, 0)} />
          </Tile>
        ))}
        <Tile title="Unpaid credits expired" description="Trial and staff adjustments">
          <Stat label="Credits" value={formatCredits(r.unpaid_credits)} />
        </Tile>
      </div>
      <Card>
        <CardHeader className="pb-0">
          <CardTitle className="text-sm">Paid credits expired per day</CardTitle>
          <CardDescription className="text-xs">One bar per UTC day, all currencies</CardDescription>
        </CardHeader>
        <CardContent className="pt-4">{series.length ? <SeriesChart series={series} label="Credits expired per day" format={(v) => formatCredits(v)} /> : <p className="py-10 text-center text-sm text-muted-foreground">Nothing expired in range.</p>}</CardContent>
      </Card>
    </div>
  );
}
