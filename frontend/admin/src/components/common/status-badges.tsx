'use client';

import { Badge, Spinner } from '@portal/ui';
import { Frown, Meh, Smile } from 'lucide-react';
import {
  agentStatusVariant, callStatusVariant, customerStatusVariant, healthVariant, jobStatusVariant, numberStatusVariant, planVariant, purchaseStatusVariant, stripeSyncVariant, webhookStatusVariant,
} from '@/src/lib/badges';
import { humanize } from '@/src/lib/format';

export function CustomerStatusBadge({ status }: { status: string }) {
  return <Badge variant={customerStatusVariant(status)}>{humanize(status)}</Badge>;
}
export function PlanBadge({ tier }: { tier: string }) {
  return <Badge variant={planVariant(tier)}>{humanize(tier)}</Badge>;
}
export function AgentStatusBadge({ status }: { status: string }) {
  return <Badge variant={agentStatusVariant(status)}>{humanize(status)}</Badge>;
}
export function TierBadge({ tier }: { tier: string }) {
  return <Badge variant={tier === 'premium' ? 'premium' : 'outline'}>{humanize(tier)}</Badge>;
}
export function NumberStatusBadge({ status }: { status: string }) {
  return <Badge variant={numberStatusVariant(status)}>{humanize(status)}</Badge>;
}
export function CallStatusBadge({ status }: { status: string }) {
  if (status === 'in_progress') {
    return (
      <Badge variant="info">
        <Spinner className="size-3" /> Live
      </Badge>
    );
  }
  return <Badge variant={callStatusVariant(status)}>{status === 'missed' ? 'Missed' : humanize(status)}</Badge>;
}
export function JobStatusBadge({ status }: { status: string }) {
  return <Badge variant={jobStatusVariant(status)}>{humanize(status)}</Badge>;
}
export function WebhookStatusBadge({ status }: { status: string }) {
  return <Badge variant={webhookStatusVariant(status)}>{humanize(status)}</Badge>;
}
export function PurchaseStatusBadge({ status }: { status: string }) {
  return <Badge variant={purchaseStatusVariant(status)}>{humanize(status)}</Badge>;
}
export function HealthBadge({ signal }: { signal: string }) {
  return <Badge variant={healthVariant(signal)}>{humanize(signal)}</Badge>;
}
export function StripeSyncBadge({ status }: { status: string }) {
  return <Badge variant={stripeSyncVariant(status)}>{humanize(status)}</Badge>;
}
export function YesNo({ value, yes = 'Yes', no = 'No' }: { value: boolean; yes?: string; no?: string }) {
  return <Badge variant={value ? 'success' : 'outline'}>{value ? yes : no}</Badge>;
}

export function SentimentBadge({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-muted-foreground">–</span>;
  const v = value.trim().toLowerCase();
  const s = v.startsWith('pos') ? 'positive' : v.startsWith('neg') ? 'negative' : v.startsWith('neu') ? 'neutral' : 'unknown';
  const Icon = s === 'positive' ? Smile : s === 'negative' ? Frown : Meh;
  const tone = s === 'positive' ? 'text-success-emphasis' : s === 'negative' ? 'text-danger' : 'text-muted-foreground';
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${tone}`}>
      <Icon className="size-4" aria-hidden />
      {humanize(s)}
    </span>
  );
}
