'use client';

import type { AdminSystemHealthResponse } from '@portal/schemas';
import { Badge, Card, CardContent, CardHeader, CardTitle, cn } from '@portal/ui';
import * as React from 'react';
import { HealthBadge } from '@/src/components/common/status-badges';
import { signalDot } from '@/src/components/shell/health-strip';
import { formatDateTime, formatNumber, relativeTime } from '@/src/lib/format';

function HealthCard({ title, check, children }: { title: string; check: { signal: string; detail: string | null; latency_ms: number | null }; children?: React.ReactNode }) {
  return (
    <Card className={cn(check.signal === 'down' && 'border-danger/40', check.signal === 'warn' && 'border-warning/50')}>
      <CardHeader className="flex-row items-center justify-between gap-3 pb-0">
        <CardTitle className="flex items-center gap-2 text-sm">
          <span className={cn('size-2.5 rounded-full', signalDot(check.signal))} aria-hidden /> {title}
        </CardTitle>
        <HealthBadge signal={check.signal} />
      </CardHeader>
      <CardContent className="flex flex-col gap-1 pt-3 text-sm">
        <p className={cn('text-muted-foreground', check.signal === 'down' && 'text-danger')}>{check.detail ?? 'No detail'}</p>
        {check.latency_ms !== null ? <p className="text-xs tabular-nums text-muted-foreground">{formatNumber(check.latency_ms, 0)} ms</p> : null}
        {children}
      </CardContent>
    </Card>
  );
}

/** SA12 Health tab: the full `GET /admin/system/health` answer as cards. */
export function HealthCards({ h }: { h: AdminSystemHealthResponse }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        Environment <Badge variant="outline">{h.env}</Badge> · checked {formatDateTime(h.time, { seconds: true })}
      </p>
      {h.kill_switches_on.length ? (
        <Card className="border-danger/50 bg-danger/5">
          <CardContent className="flex flex-wrap items-center gap-2 p-4 text-sm">
            <span className="font-medium text-danger">Kill switches on:</span>
            {h.kill_switches_on.map((k) => (
              <Badge key={k} variant="danger">
                {k}
              </Badge>
            ))}
          </CardContent>
        </Card>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <HealthCard title="API" check={h.api} />
        <HealthCard title="Postgres" check={h.postgres} />
        <HealthCard title="Redis" check={h.redis} />
        <HealthCard title="Worker" check={h.worker}>
          <p className="text-xs text-muted-foreground">
            Last seen {h.worker.last_seen ? relativeTime(h.worker.last_seen) : 'never'} · {h.worker.schedulers ?? '?'} schedulers registered
          </p>
        </HealthCard>
        <HealthCard title="Voice platform" check={h.retell} />
        <HealthCard title="Stripe" check={h.stripe}>
          <p className="text-xs text-muted-foreground">
            Last webhook {h.stripe.last_webhook_at ? relativeTime(h.stripe.last_webhook_at) : 'never'} · {h.stripe.unprocessed} unprocessed
          </p>
        </HealthCard>
        <HealthCard title="Webhooks" check={h.webhooks}>
          <p className="text-xs text-muted-foreground">
            {h.webhooks.unprocessed} unprocessed · {h.webhooks.failed} failed
          </p>
        </HealthCard>
        <HealthCard title="Jobs" check={h.jobs}>
          <p className="text-xs text-muted-foreground">
            {h.jobs.failed_24h} failed in 24 h · {h.jobs.queued} queued
          </p>
        </HealthCard>
        <HealthCard title="Concurrency" check={h.concurrency}>
          <p className="text-xs text-muted-foreground">
            {h.concurrency.live ?? '?'} live / {h.concurrency.allowance} allowance
          </p>
        </HealthCard>
      </div>
    </div>
  );
}
