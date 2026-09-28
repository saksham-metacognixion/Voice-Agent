'use client';

import type { AdminKpisResponse } from '@portal/schemas';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, cn } from '@portal/ui';
import Link from 'next/link';
import * as React from 'react';
import { formatCents, formatCredits, formatNumber } from '@/src/lib/format';
import { routes, systemPath } from '@/src/routes';

function Stat({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: 'danger' | 'warning' }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn('text-lg font-semibold tabular-nums leading-tight', tone === 'danger' && 'text-danger', tone === 'warning' && 'text-warning-emphasis')}>{value}</span>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

function KpiCard({ title, description, children, className }: { title: string; description?: string; children: React.ReactNode; className?: string }) {
  return (
    <Card className={className}>
      <CardHeader className="pb-0">
        <CardTitle className="text-sm">{title}</CardTitle>
        {description ? <CardDescription className="text-xs">{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-x-4 gap-y-3 pt-4 sm:grid-cols-3">{children}</CardContent>
    </Card>
  );
}

/** SA1 KPI cards (admin Appendix A), from one `GET /admin/kpis` answer. */
export function KpiCards({ k }: { k: AdminKpisResponse }) {
  const rangeLabel = k.range === '7d' ? '7 days' : k.range === '30d' ? '30 days' : '90 days';
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      <KpiCard title="Customers" description="Active = a connected call or paid purchase in the trailing 30 days">
        <Stat label="Total" value={formatNumber(k.customers.total, 0)} />
        <Stat label="Active" value={formatNumber(k.customers.active, 0)} />
        <Stat label="Onboarding" value={formatNumber(k.customers.onboarding, 0)} />
        <Stat label="Paused" value={formatNumber(k.customers.paused, 0)} tone={k.customers.paused ? 'warning' : undefined} />
        <Stat label="At risk" value={formatNumber(k.customers.at_risk, 0)} tone={k.customers.at_risk ? 'danger' : undefined} hint="Balance ≤ 0 for 3+ days" />
        <Stat label={`New in ${rangeLabel}`} value={formatNumber(k.customers.new_in_range, 0)} />
      </KpiCard>
      <KpiCard title="Agents and numbers">
        <Stat label="Agents live" value={formatNumber(k.agents.live, 0)} />
        <Stat label="Draft" value={formatNumber(k.agents.draft, 0)} />
        <Stat label="Paused" value={formatNumber(k.agents.paused, 0)} />
        <Stat label="Numbers active" value={formatNumber(k.numbers.active, 0)} />
        <Stat label="Provisioning" value={formatNumber(k.numbers.provisioning, 0)} />
        <Stat label="Released in range" value={formatNumber(k.numbers.released_in_range, 0)} />
      </KpiCard>
      <KpiCard title="Credit sales" description={`Paid purchases in the last ${rangeLabel}`}>
        {k.credit_sales.by_currency.length ? (
          k.credit_sales.by_currency.map((c) => <Stat key={c.currency} label={c.currency} value={formatCents(c.amount_cents, c.currency)} hint={`${c.purchases} purchase${c.purchases === 1 ? '' : 's'}`} />)
        ) : (
          <Stat label="Sales" value="–" hint="No paid purchases in range" />
        )}
        {k.credit_sales.by_pack.slice(0, 4).map((p) => (
          <Stat key={p.pack_id} label={`Pack: ${p.pack_id}`} value={formatNumber(p.purchases, 0)} hint={`${formatNumber(p.credits, 0)} credits`} />
        ))}
      </KpiCard>
      <KpiCard title="Credits used">
        <Stat label="Total" value={formatCredits(k.credits_used.total)} />
        <Stat label="Standard" value={formatCredits(k.credits_used.standard)} />
        <Stat label="Premium" value={formatCredits(k.credits_used.premium)} />
        <Stat label="Test calls" value={formatCredits(k.credits_used.test)} />
        <Stat label="Outstanding" value={formatCredits(k.wallet.outstanding_credits)} hint="Unexpired lot balance (liability)" />
        <Stat label="Expired in range" value={formatCredits(k.wallet.expired_in_range)} />
      </KpiCard>
      <KpiCard title="Calls">
        <Stat label="Connected" value={formatNumber(k.calls.connected, 0)} />
        <Stat label="Declined" value={formatNumber(k.calls.declined, 0)} tone={k.calls.declined ? 'warning' : undefined} hint={declinedHint(k.calls.declined_by_reason)} />
        <Stat label="Minutes" value={formatNumber(k.calls.minutes, 1)} />
      </KpiCard>
      <KpiCard title="Platform">
        <Stat label="Concurrency" value={`${k.concurrency.live ?? '?'} / ${k.concurrency.allowance}`} hint="Live calls / platform allowance" />
        <Stat label="Knowledge bases" value={formatNumber(k.knowledge.bases, 0)} />
      </KpiCard>
    </div>
  );
}

function declinedHint(byReason: Record<string, number>): string | undefined {
  const parts = Object.entries(byReason)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `${r} ${n}`);
  return parts.length ? parts.join(' · ') : undefined;
}

/** SA1 "Needs attention" — each line links where the fix lives. */
export function AttentionList({ a }: { a: AdminKpisResponse['attention'] }) {
  const items: Array<{ label: string; count: number; href: string; tone: 'danger' | 'warning' }> = [
    { label: 'Failed activations (24 h)', count: a.failed_activations_24h, href: systemPath('jobs'), tone: 'danger' },
    { label: 'Failed auto top-ups (24 h)', count: a.failed_topups_24h, href: `${routes.customers}`, tone: 'danger' },
    { label: 'Failed jobs (24 h)', count: a.failed_jobs_24h, href: systemPath('jobs'), tone: 'danger' },
    { label: 'Paid, onboarding not finished (> 7 d)', count: a.onboarding_stuck, href: `${routes.customers}?status=onboarding`, tone: 'warning' },
    { label: 'Unprocessed webhooks', count: a.unprocessed_webhooks, href: systemPath('webhooks'), tone: 'warning' },
    { label: 'Pending purchases', count: a.pending_purchases, href: `${routes.customers}`, tone: 'warning' },
    { label: 'Overdue number rentals', count: a.overdue_rentals, href: `${routes.customers}?status=at_risk`, tone: 'warning' },
    { label: 'Open customer alerts', count: a.open_alerts, href: `${routes.customers}?sort=balance&order=asc`, tone: 'warning' },
  ];
  const open = items.filter((i) => i.count > 0);
  return (
    <Card>
      <CardHeader className="pb-0">
        <CardTitle className="text-sm">Needs attention</CardTitle>
      </CardHeader>
      <CardContent className="pt-4">
        {open.length ? (
          <ul className="flex flex-col divide-y divide-border">
            {open.map((i) => (
              <li key={i.label}>
                <Link href={i.href} className="flex items-center justify-between gap-3 py-2 text-sm hover:text-primary">
                  <span>{i.label}</span>
                  <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums', i.tone === 'danger' ? 'bg-danger/12 text-danger' : 'bg-warning/20 text-warning-emphasis')}>{i.count}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Nothing outstanding.</p>
        )}
      </CardContent>
    </Card>
  );
}

