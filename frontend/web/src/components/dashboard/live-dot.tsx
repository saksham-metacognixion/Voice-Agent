'use client';

import type { StreamState } from '@portal/api-client';
import { cn } from '@portal/ui';
import { useTranslations } from 'next-intl';

/** The §7.2 "live" indicator: green while the SSE stream is open, amber while it reconnects. */
export function LiveDot({ state }: { state: StreamState }) {
  const t = useTranslations('shell');
  const live = state === 'live';
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
      <span className={cn('relative inline-flex size-2 rounded-full', live ? 'bg-success' : 'bg-warning')}>
        {live ? <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" /> : null}
      </span>
      {live ? t('live') : t('reconnecting')}
    </span>
  );
}
