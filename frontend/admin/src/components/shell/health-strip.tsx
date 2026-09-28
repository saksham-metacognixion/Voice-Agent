'use client';

import { useAdminSystemHealth, useApi } from '@portal/api-client';
import type { AdminSystemHealthResponse } from '@portal/schemas';
import { Badge, Tooltip, TooltipContent, TooltipTrigger, cn } from '@portal/ui';
import Link from 'next/link';
import { routes, systemPath } from '@/src/routes';

/**
 * Admin §3 health strip: one dot per dependency, the queue counts and live concurrency,
 * polled every 30 s. Clicking anything goes to /system/. A kill switch that is on is a
 * red pill — it is the one thing on this bar that a staff member set on purpose.
 */
export function HealthStrip({ className }: { className?: string }) {
  const api = useApi();
  const health = useAdminSystemHealth(api, { refetchInterval: 30_000, staleTime: 15_000 });
  const h = health.data;

  if (!h) {
    return (
      <Link href={routes.system} className={cn('hidden items-center gap-2 text-xs text-muted-foreground md:flex', className)} aria-label="System health">
        <span className="size-2 rounded-full bg-muted-foreground/40" aria-hidden />
        {health.isError ? 'Health unavailable' : 'Checking health…'}
      </Link>
    );
  }

  const dots: Array<{ key: string; label: string; signal: string; detail: string | null }> = [
    { key: 'retell', label: 'Voice platform', signal: h.retell.signal, detail: h.retell.detail },
    { key: 'stripe', label: 'Stripe', signal: h.stripe.signal, detail: h.stripe.detail },
    { key: 'worker', label: 'Worker', signal: h.worker.signal, detail: h.worker.detail },
    { key: 'postgres', label: 'Postgres', signal: h.postgres.signal, detail: h.postgres.detail },
    { key: 'redis', label: 'Redis', signal: h.redis.signal, detail: h.redis.detail },
  ];

  return (
    <div className={cn('hidden items-center gap-3 text-xs md:flex', className)}>
      <Link href={systemPath('health')} className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-muted" aria-label="System health">
        {dots.map((d) => (
          <Tooltip key={d.key}>
            <TooltipTrigger asChild>
              <span className="flex items-center gap-1">
                <span className={cn('size-2 rounded-full', signalDot(d.signal))} aria-hidden />
                <span className="sr-only">
                  {d.label}: {d.signal}
                </span>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {d.label}: {d.signal}
              {d.detail ? ` — ${d.detail}` : ''}
            </TooltipContent>
          </Tooltip>
        ))}
      </Link>
      {/* The counters need the room a laptop has; at md they pushed the header past the viewport (D13 QA, 768 px). */}
      <Link href={systemPath('jobs')} className={cn('hidden rounded-md px-1.5 py-1 tabular-nums hover:bg-muted lg:inline-flex', h.jobs.failed_24h > 0 ? 'text-danger' : 'text-muted-foreground')}>
        {h.jobs.failed_24h} failed job{h.jobs.failed_24h === 1 ? '' : 's'}
      </Link>
      <Link href={systemPath('webhooks')} className={cn('hidden rounded-md px-1.5 py-1 tabular-nums hover:bg-muted lg:inline-flex', h.webhooks.unprocessed > 0 ? 'text-warning-emphasis' : 'text-muted-foreground')}>
        {h.webhooks.unprocessed} unprocessed
      </Link>
      <Link href={systemPath('health')} className="hidden whitespace-nowrap rounded-md px-1.5 py-1 tabular-nums text-muted-foreground hover:bg-muted lg:inline-flex" title="Live calls / platform allowance">
        {h.concurrency.live ?? '?'} / {h.concurrency.allowance}
      </Link>
      {h.kill_switches_on.length ? (
        <Link href={systemPath('flags')}>
          <Badge variant="danger">
            {h.kill_switches_on.length} kill switch{h.kill_switches_on.length === 1 ? '' : 'es'} on
          </Badge>
        </Link>
      ) : null}
    </div>
  );
}

export function signalDot(signal: string): string {
  switch (signal) {
    case 'ok':
      return 'bg-success';
    case 'warn':
      return 'bg-warning';
    case 'down':
      return 'bg-danger';
    default:
      return 'bg-muted-foreground/40';
  }
}

export type HealthCheckKey = keyof Pick<AdminSystemHealthResponse, 'api' | 'postgres' | 'redis' | 'worker' | 'retell' | 'stripe' | 'webhooks' | 'jobs' | 'concurrency'>;
