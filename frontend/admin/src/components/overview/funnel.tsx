'use client';

import type { AdminFunnelResponse } from '@portal/schemas';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@portal/ui';
import { formatMinutes, formatNumber, formatPercent } from '@/src/lib/format';

const STEP_NAMES: Record<number, string> = { 1: 'Template', 2: 'Brief', 3: 'Voice', 4: 'Knowledge', 5: 'Test call', 6: 'Phone number', 7: 'Checkout' };

/** SA1 funnel: sign-up → live as horizontal bars, % of the cohort. */
export function Funnel({ f }: { f: AdminFunnelResponse }) {
  const max = Math.max(1, f.cohort_size, ...f.steps.map((s) => s.count));
  // The median is taken over the workspaces that went live, so that is its sample size.
  const liveCount = f.steps.find((s) => s.key === 'live')?.count;
  return (
    <Card>
      <CardHeader className="pb-0">
        <CardTitle className="text-sm">Sign-up to live</CardTitle>
        <CardDescription className="text-xs">Cohort: {formatNumber(f.cohort_size, 0)} workspaces created in range</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5 pt-4">
        <ol className="flex flex-col gap-2">
          {f.steps.map((s) => {
            const pct = f.cohort_size > 0 ? (s.count / f.cohort_size) * 100 : 0;
            return (
              <li key={s.key} className="grid grid-cols-[8rem_1fr_5rem] items-center gap-3 text-sm">
                <span className="truncate text-muted-foreground" title={s.label}>
                  {s.label}
                </span>
                <span className="h-5 overflow-hidden rounded bg-muted">
                  <span className="block h-full rounded bg-primary" style={{ width: `${(s.count / max) * 100}%` }} aria-hidden />
                </span>
                <span className="text-right tabular-nums">
                  {formatNumber(s.count, 0)} <span className="text-xs text-muted-foreground">({formatPercent(pct, 0)})</span>
                </span>
              </li>
            );
          })}
        </ol>
        <dl className="grid grid-cols-2 gap-4 border-t border-border pt-4 sm:grid-cols-3">
          <div>
            <dt className="text-xs text-muted-foreground">Activation rate</dt>
            <dd className="text-lg font-semibold tabular-nums">{f.activation_rate === null ? '–' : formatPercent(f.activation_rate * (f.activation_rate <= 1 ? 100 : 1), 1)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Median time to live</dt>
            <dd className="text-lg font-semibold tabular-nums">
              {formatMinutes(f.median_minutes_to_live)}
              {f.median_minutes_to_live !== null && liveCount !== undefined ? <span className="ms-1 text-xs font-normal text-muted-foreground">(n = {formatNumber(liveCount, 0)})</span> : null}
            </dd>
          </div>
          <div className="col-span-2 sm:col-span-1">
            <dt className="text-xs text-muted-foreground">Stuck by step</dt>
            <dd className="flex flex-wrap gap-1 text-xs">
              {f.stuck_by_step.length ? (
                f.stuck_by_step.map((s) => (
                  <span key={s.step} className="rounded-full bg-muted px-2 py-0.5 tabular-nums">
                    {STEP_NAMES[s.step] ?? `Step ${s.step}`}: {s.count}
                  </span>
                ))
              ) : (
                <span className="text-muted-foreground">None</span>
              )}
            </dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}
