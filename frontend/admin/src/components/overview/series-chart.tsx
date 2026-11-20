'use client';

import { cn } from '@portal/ui';
import * as React from 'react';
import { formatDayLabel, formatNumber } from '@/src/lib/format';

export interface SeriesPoint {
  day: string;
  value: number;
}

const W = 720;
const H = 200;
const PAD = { top: 8, right: 4, bottom: 22, left: 36 };

/**
 * One series, one hue — the portal's D1 inline SVG bars (ADR 0018), no chart library.
 * A hover tooltip on every bar, a label every week plus the last day.
 */
export function SeriesChart({ series, label, format = (v) => formatNumber(v, 0) }: { series: SeriesPoint[]; label: string; format?: (v: number) => string }) {
  const [hover, setHover] = React.useState<number | null>(null);
  const max = Math.max(1, ...series.map((p) => p.value));
  const niceMax = niceCeil(max);
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const slot = innerW / Math.max(series.length, 1);
  const gap = 2;
  const barW = Math.max(2, slot - gap);
  const y = (v: number) => PAD.top + innerH - (v / niceMax) * innerH;
  const ticks = [0, niceMax / 2, niceMax];
  const active = hover !== null ? series[hover] : null;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-52 w-full" role="img" aria-label={label} onMouseLeave={() => setHover(null)}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} className="stroke-border" strokeWidth={1} />
            <text x={PAD.left - 6} y={y(v) + 3} textAnchor="end" className="fill-muted-foreground" fontSize={10}>
              {format(v)}
            </text>
          </g>
        ))}
        {series.map((p, i) => {
          const x = PAD.left + i * slot + gap / 2;
          const top = y(p.value);
          const h = Math.max(0, PAD.top + innerH - top);
          const r = Math.min(4, barW / 2, h);
          const showLabel = i === series.length - 1 || (i % 7 === 0 && i < series.length - 3);
          return (
            <g key={p.day} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} tabIndex={0} aria-label={`${formatDayLabel(p.day, 'weekday')}: ${format(p.value)}`} className="outline-none">
              <rect x={PAD.left + i * slot} y={PAD.top} width={slot} height={innerH} fill="transparent" />
              {h > 0 ? (
                <path d={`M${x},${PAD.top + innerH} v${-(h - r)} a${r},${r} 0 0 1 ${r},${-r} h${barW - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${h - r} z`} className={cn('fill-primary transition-opacity', hover !== null && hover !== i && 'opacity-50')} />
              ) : (
                <rect x={x} y={PAD.top + innerH - 1} width={barW} height={1} className="fill-border" />
              )}
              {showLabel ? (
                <text x={x + barW / 2} y={H - 6} textAnchor="middle" className="fill-muted-foreground" fontSize={10}>
                  {formatDayLabel(p.day)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      {active && hover !== null ? (
        <div role="tooltip" className="pointer-events-none absolute -top-1 z-10 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-popover" style={{ left: `${((PAD.left + hover * slot + slot / 2) / W) * 100}%`, transform: `translateX(${hover > series.length / 2 ? '-100%' : '0'})` }}>
          <p className="font-medium">{formatDayLabel(active.day, 'weekday')}</p>
          <p className="text-muted-foreground">{format(active.value)}</p>
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
