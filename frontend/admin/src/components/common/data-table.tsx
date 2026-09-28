'use client';

import { cn } from '@portal/ui';
import * as React from 'react';

export interface DataColumn<T> {
  key: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  align?: 'right' | 'center';
  /** Extra classes for the `<td>`/`<th>`, e.g. a hidden-below-md column. */
  className?: string;
}

/**
 * The console's list pattern (copied from the portal's D10 table, without the phone
 * cards: the console is used at ≥ 768 px and every table scrolls sideways instead).
 * `onRowClick` makes rows open something; interactive cells stop the event themselves.
 */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  label,
  onRowClick,
  rowClassName,
  className,
  dense,
}: {
  rows: T[];
  columns: Array<DataColumn<T>>;
  rowKey: (row: T) => string;
  label: string;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string | undefined;
  className?: string;
  dense?: boolean;
}) {
  const activate = (row: T) => (e: React.KeyboardEvent) => {
    if (!onRowClick) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onRowClick(row);
    }
  };
  const pad = dense ? 'px-3 py-1.5' : 'px-3 py-2.5';

  return (
    <div className={cn('overflow-x-auto rounded-lg border border-border bg-card', className)}>
      <table className="w-full text-left text-sm" aria-label={label}>
        <thead className="bg-muted/60 text-xs text-muted-foreground">
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cn(pad, 'whitespace-nowrap font-medium', c.align === 'right' && 'text-right', c.align === 'center' && 'text-center', c.className)}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className={cn(onRowClick && 'cursor-pointer transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none', rowClassName?.(row))}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={onRowClick ? activate(row) : undefined}
              tabIndex={onRowClick ? 0 : undefined}
            >
              {columns.map((c) => (
                <td key={c.key} className={cn(pad, 'align-middle', c.align === 'right' && 'text-right tabular-nums', c.align === 'center' && 'text-center', c.className)}>
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Stops a click inside a cell from opening the row. */
export function CellActions({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex justify-end gap-1', className)} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      {children}
    </div>
  );
}
