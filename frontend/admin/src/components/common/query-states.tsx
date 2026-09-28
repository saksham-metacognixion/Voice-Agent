'use client';

import { Button, EmptyState, ErrorState, Skeleton } from '@portal/ui';
import * as React from 'react';
import { errorMessage } from '@/src/lib/errors';

/** The one error block every card shows: what failed, and a retry. */
export function LoadError({ error, onRetry, title, compact }: { error: unknown; onRetry: () => void; title?: string; compact?: boolean }) {
  return (
    <ErrorState
      className={compact ? 'py-6' : undefined}
      title={title ?? 'Could not load'}
      description={errorMessage(error)}
      action={
        <Button size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      }
    />
  );
}

export function Lines({ count = 3, className }: { count?: number; className?: string }) {
  return (
    <div className={className ?? 'flex flex-col gap-2'} aria-busy>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className="h-4" style={{ width: `${100 - (i % 3) * 15}%` }} />
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4" aria-busy>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-8 w-full" />
      ))}
    </div>
  );
}

/**
 * Pending / error / empty / rows, for every list on the console. Keeps each page to
 * the columns and the filters and nothing else.
 */
export function QueryList<T>({
  query,
  rows,
  empty,
  children,
}: {
  query: { isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };
  rows: T[] | undefined;
  empty: { title: string; description?: string };
  children: (rows: T[]) => React.ReactNode;
}) {
  if (query.isPending && !rows) return <TableSkeleton />;
  if (query.isError && !rows) return <LoadError error={query.error} onRetry={() => void query.refetch()} />;
  if (!rows?.length) return <EmptyState title={empty.title} description={empty.description} />;
  return <>{children(rows)}</>;
}

/** `<dt>/<dd>` pair used by every facts grid. */
export function Fact({ label, children, className, wrap = false }: { label: React.ReactNode; children: React.ReactNode; className?: string; wrap?: boolean }) {
  return (
    <div className={`flex min-w-0 flex-col gap-0.5 ${className ?? ''}`}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`${wrap ? 'break-words' : 'truncate'} text-sm font-medium`}>{children}</dd>
    </div>
  );
}

const FACT_GRID_COLUMNS = {
  /** Wide surfaces: 2 → 3 → 4 columns as the viewport grows. */
  4: 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4',
  /** Narrow surfaces (sheets, cards): two columns at every width. A `className` override
   * cannot do this — the default `lg:grid-cols-4` wins in the generated CSS whatever the
   * order of the class names. */
  2: 'grid-cols-2',
} as const;

export function FactGrid({ children, className, columns = 4 }: { children: React.ReactNode; className?: string; columns?: keyof typeof FACT_GRID_COLUMNS }) {
  return <dl className={`grid ${FACT_GRID_COLUMNS[columns]} gap-x-6 gap-y-3 ${className ?? ''}`}>{children}</dl>;
}
