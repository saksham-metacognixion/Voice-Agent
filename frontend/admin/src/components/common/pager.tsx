'use client';

import { Button } from '@portal/ui';

/** Previous / next under a §16 keyset list, with the API's `total` when it gives one. */
export function Pager({ page, pageSize, count, total, hasPrevious, hasNext, onPrevious, onNext }: { page: number; pageSize?: number; count?: number; total?: number; hasPrevious: boolean; hasNext: boolean; onPrevious: () => void; onNext: () => void }) {
  if (!hasPrevious && !hasNext && total === undefined) return null;
  const size = pageSize ?? 25;
  const from = (page - 1) * size + 1;
  const to = count !== undefined ? from + count - 1 : undefined;
  return (
    <div className="flex items-center justify-between gap-3">
      <Button variant="outline" size="sm" onClick={onPrevious} disabled={!hasPrevious}>
        Previous
      </Button>
      <span className="text-xs tabular-nums text-muted-foreground">
        {total !== undefined && to !== undefined ? `${Math.min(from, total)}–${Math.min(to, total)} of ${total}` : `Page ${page}`}
      </span>
      <Button variant="outline" size="sm" onClick={onNext} disabled={!hasNext}>
        Next
      </Button>
    </div>
  );
}
