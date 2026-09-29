'use client';

import { useAdminConcurrency, useApi } from '@portal/api-client';
import type { AdminConcurrencyResponse } from '@portal/schemas';
import { Alert, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Progress, Skeleton, cn } from '@portal/ui';
import Link from 'next/link';
import * as React from 'react';
import { DataTable, type DataColumn } from '@/src/components/common/data-table';
import { LoadError } from '@/src/components/common/query-states';
import { HealthBadge, PlanBadge } from '@/src/components/common/status-badges';
import { formatDateTime, formatNumber } from '@/src/lib/format';
import { customerPath } from '@/src/routes';

type Tenant = AdminConcurrencyResponse['tenants'][number];

/** SA7 concurrency (D13): live calls against the platform allowance and each plan's cap, refreshed every 15 s. */
export function ConcurrencyTab() {
  const api = useApi();
  const q = useAdminConcurrency(api, { refetchInterval: 15_000, staleTime: 5_000 });
  if (q.isPending) return <Skeleton className="h-64" aria-busy />;
  if (q.isError) return <LoadError error={q.error} onRetry={() => void q.refetch()} />;
  return <ConcurrencyView c={q.data} refreshing={q.isFetching} />;
}

function tone(signal: AdminConcurrencyResponse['signal']): string {
  return signal === 'down' ? 'text-danger' : signal === 'warn' ? 'text-warning-emphasis' : signal === 'unknown' ? 'text-muted-foreground' : 'text-foreground';
}

function ConcurrencyView({ c, refreshing }: { c: AdminConcurrencyResponse; refreshing: boolean }) {
  const unreadable = c.live === null;
  const pct = c.live !== null && c.allowance ? Math.min(100, Math.round((c.live / c.allowance) * 100)) : null;

  const columns: Array<DataColumn<Tenant>> = [
    {
      key: 'customer',
      header: 'Customer',
      cell: (r) => (
        <Link href={customerPath(r.tenant_id, 'calls')} className="hover:text-primary">
          {r.tenant_name}
        </Link>
      ),
    },
    { key: 'plan', header: 'Plan', cell: (r) => (r.plan_tier ? <PlanBadge tier={r.plan_tier} /> : <span className="text-muted-foreground">–</span>) },
    { key: 'live', header: 'Live', align: 'right', cell: (r) => <span className="font-semibold tabular-nums">{r.live}</span> },
    { key: 'cap', header: 'Cap', align: 'right', cell: (r) => (r.cap === null ? <span className="text-muted-foreground">?</span> : r.cap) },
    {
      key: 'pct',
      header: '% of cap',
      cell: (r) =>
        r.pct_of_cap === null ? (
          <span className="text-muted-foreground">–</span>
        ) : (
          <div className="flex min-w-32 items-center gap-2">
            <Progress value={Math.min(100, r.pct_of_cap)} className={cn('h-1.5', r.pct_of_cap >= 100 ? '[&>div]:bg-danger' : r.pct_of_cap >= c.alert_threshold_pct ? '[&>div]:bg-warning' : undefined)} aria-label={`${r.pct_of_cap}% of cap`} />
            <span className={cn('w-10 text-right text-xs tabular-nums', r.pct_of_cap >= 100 ? 'text-danger' : r.pct_of_cap >= c.alert_threshold_pct ? 'text-warning-emphasis' : 'text-muted-foreground')}>{r.pct_of_cap}%</span>
          </div>
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card className={cn(c.signal === 'down' && 'border-danger/40', c.signal === 'warn' && 'border-warning/50')}>
        <CardHeader className="flex-row items-start justify-between gap-3 pb-0">
          <div>
            <CardTitle className="text-sm">Live calls, platform-wide</CardTitle>
            <CardDescription className="text-xs">
              From the same live-call reservations the inbound checks read. Checked {formatDateTime(c.checked_at, { seconds: true })}
              {refreshing ? ' · refreshing' : ''}.
            </CardDescription>
          </div>
          <HealthBadge signal={c.signal} />
        </CardHeader>
        <CardContent className="flex flex-col gap-3 pt-4">
          {unreadable ? (
            <Alert variant="warning" title="Could not read live calls">
              {c.complete ? 'The cache did not answer.' : 'The cache did not answer, or the scan stopped before every workspace was walked.'} The table below shows what was seen, which is not a total. Calls are not affected — the inbound path fails open.
            </Alert>
          ) : (
            <>
              <div className="flex items-baseline gap-2">
                <span className={cn('text-4xl font-semibold tabular-nums', tone(c.signal))}>{formatNumber(c.live, 0)}</span>
                <span className="text-sm text-muted-foreground">/ {c.allowance === null ? 'no allowance set' : `${formatNumber(c.allowance, 0)} allowance`}</span>
              </div>
              {pct !== null ? <Progress value={pct} className={cn(c.signal === 'down' ? '[&>div]:bg-danger' : c.signal === 'warn' ? '[&>div]:bg-warning' : undefined)} aria-label={`${pct}% of the platform allowance`} /> : null}
              <p className="text-xs text-muted-foreground">
                {c.allowance === null ? 'Set CONCURRENCY_PLATFORM_LIMIT on the API to gauge against the platform plan.' : `Ops is paged at ${c.alert_threshold_pct}% of the allowance (${Math.ceil((c.allowance * c.alert_threshold_pct) / 100)} calls).`}
                {' '}
                {c.tenants.length} workspace{c.tenants.length === 1 ? '' : 's'} on a call.
              </p>
            </>
          )}
        </CardContent>
      </Card>
      {c.tenants.length ? (
        <DataTable rows={c.tenants} columns={columns} rowKey={(r) => r.tenant_id} label="Live calls by workspace" dense />
      ) : unreadable ? null : (
        <EmptyState title="No live calls right now" description="Workspaces appear here while one of their numbers or a browser test is on a call." />
      )}
      {c.tenants.some((t) => t.pct_of_cap !== null && t.pct_of_cap >= 100) ? (
        <p className="text-xs text-muted-foreground">
          <Badge variant="danger">at cap</Badge> A workspace at its cap answers the next inbound call with a busy tone (§13.9); a larger pack raises the cap.
        </p>
      ) : null}
    </div>
  );
}
