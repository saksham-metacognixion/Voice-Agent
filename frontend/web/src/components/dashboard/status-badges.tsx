'use client';

import type { AgentStatus, AgentTier, CallDisplayStatus } from '@portal/schemas';
import { Badge, Spinner } from '@portal/ui';
import { Frown, Meh, Smile } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { sentimentOf } from '@/src/dashboard/analysis';

/** `calls.status` as the customer reads it (D2): declined is Missed, in_progress is Live. */
export function CallStatusBadge({ status }: { status: CallDisplayStatus }) {
  const t = useTranslations('dashboard.calls.status');
  switch (status) {
    case 'in_progress':
      return (
        <Badge variant="info">
          <Spinner className="size-3" /> {t('in_progress')}
        </Badge>
      );
    case 'registered':
      return <Badge variant="info">{t('registered')}</Badge>;
    case 'missed':
      return <Badge variant="danger">{t('missed')}</Badge>;
    case 'analyzed':
      return <Badge variant="success">{t('analyzed')}</Badge>;
    default:
      return <Badge>{t('ended')}</Badge>;
  }
}

export function AgentStatusBadge({ status }: { status: AgentStatus }) {
  const t = useTranslations('dashboard.agents.status');
  if (status === 'live') return <Badge variant="success">{t('live')}</Badge>;
  if (status === 'paused') return <Badge variant="warning">{t('paused')}</Badge>;
  return <Badge variant="outline">{t('draft')}</Badge>;
}

export function TierBadge({ tier }: { tier: AgentTier }) {
  const t = useTranslations('common');
  return <Badge variant={tier === 'premium' ? 'premium' : 'outline'}>{tier === 'premium' ? t('premium') : t('standard')}</Badge>;
}

/** The D2 mood column (spec p. 34, ☺ ☻ ☹): an icon with a label, never colour alone. */
export function SentimentBadge({ value, compact }: { value: string | null | undefined; compact?: boolean }) {
  const t = useTranslations('dashboard.calls.sentiment');
  const s = sentimentOf(value);
  if (!s) return <span className="text-muted-foreground">–</span>;
  const Icon = s === 'positive' ? Smile : s === 'negative' ? Frown : Meh;
  const tone = s === 'positive' ? 'text-success-emphasis' : s === 'negative' ? 'text-danger' : 'text-muted-foreground';
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${tone}`} title={t(s)}>
      <Icon className="size-4" aria-hidden />
      {compact ? <span className="sr-only">{t(s)}</span> : <span>{t(s)}</span>}
    </span>
  );
}
