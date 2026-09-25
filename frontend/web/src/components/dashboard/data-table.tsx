'use client';

import { cn } from '@portal/ui';
import * as React from 'react';

/**
 * Where a column goes in the phone card (§12.5 "tables become cards on < 640 px"):
 *
 *   title     the card's heading (bold, wraps)
 *   subtitle  under the heading, muted
 *   badge     top-right of the card (a status)
 *   field     a label/value row in the card's facts grid (the default)
 *   actions   the card's footer, full width, touch-sized
 *   none      desktop only — used for a column that another card slot already shows
 */
export type CardSlot = 'title' | 'subtitle' | 'badge' | 'field' | 'actions' | 'none';

export interface DataColumn<T> {
  key: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  card?: CardSlot;
  align?: 'right' | 'center';
  /** Extra classes for the desktop `<td>`/`<th>`, e.g. a hidden-below-md column. */
  className?: string;
}

/**
 * The dashboard's list pattern: the D10 table at ≥ 640 px, a stack of cards below it.
 * Both are rendered and CSS picks one, so nothing depends on measuring the viewport and
 * the first paint is already right. A card shows every column the table does (nothing
 * important is hidden on a phone); only its layout changes.
 *
 * `onRowClick` makes rows and cards open something; interactive cells should stop the
 * event themselves. `label` names the table for assistive tech.
 */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  label,
  onRowClick,
  rowClassName,
  className,
}: {
  rows: T[];
  columns: Array<DataColumn<T>>;
  rowKey: (row: T) => string;
  label: string;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string | undefined;
  className?: string;
}) {
  const bySlot = (slot: CardSlot) => columns.filter((c) => (c.card ?? 'field') === slot);
  const titles = bySlot('title');
  const subtitles = bySlot('subtitle');
  const badges = bySlot('badge');
  const fields = bySlot('field');
  const actions = bySlot('actions');

  const activate = (row: T) => (e: React.KeyboardEvent) => {
    if (!onRowClick) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onRowClick(row);
    }
  };

  return (
    <div className={className}>
      <div className="hidden overflow-x-auto rounded-lg border border-border bg-card sm:block">
        <table className="w-full text-left text-sm" aria-label={label}>
          <thead className="bg-muted/60 text-xs text-muted-foreground">
            <tr>
              {columns.map((c) => (
                <th key={c.key} scope="col" className={cn('px-3 py-2.5 font-medium', c.align === 'right' && 'text-right', c.align === 'center' && 'text-center', c.className)}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => (
              <tr
                key={rowKey(row)}
                className={cn(onRowClick && 'cursor-pointer transition-colors hover:bg-muted/50', rowClassName?.(row))}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={onRowClick ? activate(row) : undefined}
                tabIndex={onRowClick ? 0 : undefined}
              >
                {columns.map((c) => (
                  <td key={c.key} className={cn('px-3 py-2.5 align-middle', c.align === 'right' && 'text-right tabular-nums', c.align === 'center' && 'text-center', c.className)}>
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="flex flex-col gap-3 sm:hidden" aria-label={label}>
        {rows.map((row) => (
          <li
            key={rowKey(row)}
            className={cn('flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-4 shadow-card', onRowClick && 'cursor-pointer active:bg-muted/50', rowClassName?.(row))}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            onKeyDown={onRowClick ? activate(row) : undefined}
            tabIndex={onRowClick ? 0 : undefined}
          >
            {titles.length || badges.length ? (
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                  {titles.map((c) => (
                    <div key={c.key} className="break-words text-sm font-semibold">
                      {c.cell(row)}
                    </div>
                  ))}
                  {subtitles.map((c) => (
                    <div key={c.key} className="break-words text-xs text-muted-foreground">
                      {c.cell(row)}
                    </div>
                  ))}
                </div>
                {badges.length ? <div className="flex shrink-0 flex-col items-end gap-1">{badges.map((c) => <React.Fragment key={c.key}>{c.cell(row)}</React.Fragment>)}</div> : null}
              </div>
            ) : null}
            {fields.length ? (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
                {fields.map((c) => (
                  <div key={c.key} className="flex min-w-0 flex-col gap-0.5">
                    <dt className="text-xs text-muted-foreground">{c.header}</dt>
                    <dd className="break-words text-sm">{c.cell(row)}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {actions.length ? (
              <div className="flex flex-wrap gap-2 border-t border-border pt-3 [&_button]:min-h-10" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                {actions.map((c) => (
                  <React.Fragment key={c.key}>{c.cell(row)}</React.Fragment>
                ))}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
