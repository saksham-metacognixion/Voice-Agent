'use client';

import { Button, ErrorState, Skeleton } from '@portal/ui';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { errorMessage } from '@/src/lib/errors';

/** The one error block every dashboard card shows: what failed, and a retry. */
export function LoadError({ error, onRetry, title, compact }: { error: unknown; onRetry: () => void; title?: string; compact?: boolean }) {
  const t = useTranslations();
  return (
    <ErrorState
      className={compact ? 'py-6' : undefined}
      title={title ?? t('errors.loadFailed')}
      description={errorMessage(error, t)}
      action={
        <Button size="sm" variant="outline" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      }
    />
  );
}

export function Lines({ count = 3, className }: { count?: number; className?: string }) {
  return (
    <div className={className ?? 'flex flex-col gap-2'} aria-busy>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className="h-4 w-full" style={{ width: `${100 - (i % 3) * 15}%` }} />
      ))}
    </div>
  );
}

/** `<dt>/<dd>` pair used by every facts grid. */
export function Fact({ label, children, className }: { label: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex min-w-0 flex-col gap-0.5 ${className ?? ''}`}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm font-medium">{children}</dd>
    </div>
  );
}
