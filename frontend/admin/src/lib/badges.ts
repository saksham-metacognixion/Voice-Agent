import type { BadgeProps } from '@portal/ui';

type Variant = NonNullable<BadgeProps['variant']>;

/** Status → badge tone. Pure, so a table and a header agree. */
export function customerStatusVariant(status: string): Variant {
  switch (status) {
    case 'active':
      return 'success';
    case 'onboarding':
      return 'info';
    case 'paused':
      return 'warning';
    case 'at_risk':
      return 'danger';
    case 'churned':
      return 'outline';
    default:
      return 'default';
  }
}

export function agentStatusVariant(status: string): Variant {
  if (status === 'live') return 'success';
  if (status === 'paused') return 'warning';
  return 'outline';
}

export function numberStatusVariant(status: string): Variant {
  switch (status) {
    case 'active':
      return 'success';
    case 'provisioning':
    case 'releasing':
      return 'info';
    case 'paused':
      return 'warning';
    case 'failed':
      return 'danger';
    default:
      return 'outline';
  }
}

export function callStatusVariant(status: string): Variant {
  switch (status) {
    case 'in_progress':
    case 'registered':
      return 'info';
    case 'missed':
      return 'danger';
    case 'analyzed':
      return 'success';
    default:
      return 'default';
  }
}

export function jobStatusVariant(status: string): Variant {
  switch (status) {
    case 'succeeded':
      return 'success';
    case 'failed':
      return 'danger';
    case 'running':
      return 'info';
    default:
      return 'outline';
  }
}

export function webhookStatusVariant(status: string): Variant {
  if (status === 'processed') return 'success';
  if (status === 'failed') return 'danger';
  return 'warning';
}

export function purchaseStatusVariant(status: string): Variant {
  switch (status) {
    case 'paid':
      return 'success';
    case 'pending':
      return 'warning';
    case 'abandoned':
      return 'outline';
    case 'refunded':
      return 'info';
    default:
      return 'default';
  }
}

export function healthVariant(signal: string): Variant {
  if (signal === 'ok') return 'success';
  if (signal === 'warn') return 'warning';
  if (signal === 'down') return 'danger';
  return 'outline';
}

export function planVariant(tier: string): Variant {
  if (tier === 'trial') return 'outline';
  if (tier === 'pro' || tier === 'volume') return 'premium';
  return 'primary';
}

export function stripeSyncVariant(status: string): Variant {
  if (status === 'synced') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'pending') return 'warning';
  return 'outline';
}

/** The balance tone the pill and the customers table share (§7.2): red at or below 0, amber under 20 % of the last pack. */
export function balanceTone(balance: number, lastPack: number | null): 'danger' | 'warning' | 'default' {
  if (balance <= 0) return 'danger';
  const reference = lastPack && lastPack > 0 ? lastPack : 20;
  return balance < reference * 0.2 ? 'warning' : 'default';
}
