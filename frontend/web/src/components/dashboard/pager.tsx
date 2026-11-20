'use client';

import { Button } from '@portal/ui';
import { useTranslations } from 'next-intl';

/** Previous / next under a §16 keyset list. */
export function Pager({ page, hasPrevious, hasNext, onPrevious, onNext }: { page: number; hasPrevious: boolean; hasNext: boolean; onPrevious: () => void; onNext: () => void }) {
  const tc = useTranslations();
  if (!hasPrevious && !hasNext) return null;
  return (
    <div className="flex items-center justify-between gap-3">
      <Button variant="outline" size="sm" onClick={onPrevious} disabled={!hasPrevious}>
        {tc('common.previous')}
      </Button>
      <span className="text-xs text-muted-foreground">{tc('common.pageN', { n: page })}</span>
      <Button variant="outline" size="sm" onClick={onNext} disabled={!hasNext}>
        {tc('common.next')}
      </Button>
    </div>
  );
}
