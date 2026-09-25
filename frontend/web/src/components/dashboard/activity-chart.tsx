'use client';

import { useApi, useGetStats } from '@portal/api-client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Skeleton, cn } from '@portal/ui';
import { BarChart3 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { activitySeries, seriesTotal, type ActivityMetric, type ActivityPoint } from '@/src/dashboard/activity-series';
import { LoadError } from '@/src/components/dashboard/query-states';
import { formatCreditsValue, formatDayLabel, formatNumber } from '@/src/lib/format';

const METRICS: ActivityMetric[] = ['calls', 'minutes', 'credits'];

/**
 * D1 30-day activity (spec p. 33): `GET /stats?range=30d`, one bar per local day of the
 * workspace, oldest left. One series at a time (calls, minutes or credits — a second
 * axis would be a second chart), the brand hue for the marks, recessive grid, a hover
 * tooltip on every bar and a table view for anyone who cannot read the colour. Days
 * without a call are the zeros they are; nothing is drawn that the API did not return.
 */
export function ActivityChart() {
  const t = useTranslations('dashboard.home.activity');
  const api = useApi();
  const stats = useGetStats(api, { range: '30d' }, { staleTime: 60_000 });
  const [metric, setMetric] = React.useState<ActivityMetric>('calls');
  const series = React.useMemo(() => (stats.data ? activitySeries(stats.data) : []), [stats.data]);
  const total = seriesTotal(series, metric);
  const hasAny = series.some((p) => p.calls > 0);

  return (
    <Card className="flex flex-col">
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="size-4 text-primary" aria-hidden /> {t('title')}
          </CardTitle>
          {stats.data ? <CardDescription>{t('total', { value: metric === 'credits' ? formatCreditsValue(total) : formatNumber(total, metric === 'minutes' ? 1 : 0), metric: t(`metric.${metric}`).toLowerCase() })}</CardDescription> : null}
        </div>
        <div role="tablist" aria-label={t('metricLabel')} className="inline-flex rounded-md border border-border bg-muted p-0.5 text-xs">
          {METRICS.map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={metric === m}
              onClick={() => setMetric(m)}
              className={cn('rounded px-2.5 py-1 font-medium transition-colors', metric === m ? 'bg-card text-foreground shadow-card' : 'text-muted-foreground hover:text-foreground')}
            >
              {t(`metric.${m}`)}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        {stats.isPending ? (
          <Skeleton className="h-48 w-full" aria-busy />
        ) : stats.isError ? (
          <LoadError compact error={stats.error} onRetry={() => void stats.refetch()} />
        ) : !hasAny ? (
          <EmptyState className="py-10" icon={<BarChart3 />} title={t('empty')} description={t('emptyHint')} />
        ) : (
          <>
            <ActivityBars series={series} metric={metric} />
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">{t('table')}</summary>
              <div className="mt-2 max-h-56 overflow-auto rounded-md border border-border">
                <table className="w-full text-left tabular-nums">
                  <thead className="sticky top-0 bg-muted text-muted-foreground">
                    <tr>
                      <th className="px-2 py-1 font-medium">{t('day')}</th>
                      <th className="px-2 py-1 text-right font-medium">{t('metric.calls')}</th>
                      <th className="px-2 py-1 text-right font-medium">{t('missed')}</th>
                      <th className="px-2 py-1 text-right font-medium">{t('metric.minutes')}</th>
                      <th className="px-2 py-1 text-right font-medium">{t('metric.credits')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {series.map((p) => (
                      <tr key={p.date} className="border-t border-border">
                        <td className="px-2 py-1">{formatDayLabel(p.date, 'weekday')}</td>
                        <td className="px-2 py-1 text-right">{p.calls}</td>
                        <td className="px-2 py-1 text-right">{p.missed}</td>
                        <td className="px-2 py-1 text-right">{formatNumber(p.minutes, 1)}</td>
                        <td className="px-2 py-1 text-right">{formatCreditsValue(p.credits)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </>
        )}
      </CardContent>
    </Card>
  );
}

const W = 600;
const H = 180;
const PAD = { top: 8, right: 4, bottom: 22, left: 30 };

/** The bars alone, shared with the D5 usage chart. */
export function ActivityBars({ series, metric, label }: { series: ActivityPoint[]; metric: ActivityMetric; label?: string }) {
  const t = useTranslations('dashboard.home.activity');
  const [hover, setHover] = React.useState<number | null>(null);
  const max = Math.max(1, ...series.map((p) => p[metric]));
  const niceMax = niceCeil(max);
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const slot = innerW / series.length;
  const gap = 2;
  const barW = Math.max(2, slot - gap);
  const y = (v: number) => PAD.top + innerH - (v / niceMax) * innerH;
  const ticks = [0, niceMax / 2, niceMax];
  const fmt = (v: number) => (metric === 'credits' ? formatCreditsValue(v) : formatNumber(v, metric === 'minutes' ? 1 : 0));
  const active = hover !== null ? series[hover] : null;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-48 w-full" role="img" aria-label={label ?? t('title')} onMouseLeave={() => setHover(null)}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} className="stroke-border" strokeWidth={1} />
            <text x={PAD.left - 6} y={y(v) + 3} textAnchor="end" className="fill-muted-foreground" fontSize={10}>
              {fmt(v)}
            </text>
          </g>
        ))}
        {series.map((p, i) => {
          const v = p[metric];
          const x = PAD.left + i * slot + gap / 2;
          const top = y(v);
          const h = Math.max(0, PAD.top + innerH - top);
          const r = Math.min(4, barW / 2, h);
          // A label every week plus the last day; a weekly label within two days of the end would collide with it.
          const showLabel = i === series.length - 1 || (i % 7 === 0 && i < series.length - 3);
          return (
            <g key={p.date} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} tabIndex={0} aria-label={`${formatDayLabel(p.date, 'weekday')}: ${fmt(v)}`} className="outline-none">
              {/* hit target: the whole column, taller than the mark */}
              <rect x={PAD.left + i * slot} y={PAD.top} width={slot} height={innerH} fill="transparent" />
              {h > 0 ? (
                <path
                  d={`M${x},${PAD.top + innerH} v${-(h - r)} a${r},${r} 0 0 1 ${r},${-r} h${barW - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${h - r} z`}
                  className={cn('fill-primary transition-opacity', hover !== null && hover !== i && 'opacity-50')}
                />
              ) : (
                <rect x={x} y={PAD.top + innerH - 1} width={barW} height={1} className="fill-border" />
              )}
              {showLabel ? (
                <text x={x + barW / 2} y={H - 6} textAnchor="middle" className="fill-muted-foreground" fontSize={10}>
                  {formatDayLabel(p.date)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      {active && hover !== null ? (
        <div
          role="tooltip"
          className="pointer-events-none absolute -top-1 z-10 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-popover"
          style={{ left: `${((PAD.left + hover * slot + slot / 2) / W) * 100}%`, transform: `translateX(${hover > series.length / 2 ? '-100%' : '0'})` }}
        >
          <p className="font-medium">{formatDayLabel(active.date, 'weekday')}</p>
          <p className="text-muted-foreground">
            {t('tooltip', { calls: active.calls, missed: active.missed, minutes: formatNumber(active.minutes, 1), credits: formatCreditsValue(active.credits) })}
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** A round axis ceiling: 1, 2, 5 × 10ⁿ at or above the max. */
function niceCeil(value: number): number {
  if (value <= 1) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = 10 ** exp;
  for (const m of [1, 2, 5, 10]) if (m * base >= value) return m * base;
  return 10 * base;
}
