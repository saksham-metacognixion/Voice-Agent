'use client';

import type { TicketPriority, TicketStatus } from '@portal/schemas';
import { Badge, type BadgeProps, cn } from '@portal/ui';
import { AlertTriangle } from 'lucide-react';
import { humanize, relativeTime } from '@/src/lib/format';

type Variant = NonNullable<BadgeProps['variant']>;

export function ticketStatusVariant(status: string): Variant {
  switch (status) {
    case 'open':
      return 'info';
    case 'pending':
      return 'warning';
    case 'resolved':
      return 'success';
    case 'closed':
      return 'outline';
    default:
      return 'default';
  }
}

export function ticketPriorityVariant(priority: string): Variant {
  switch (priority) {
    case 'urgent':
      return 'danger';
    case 'high':
      return 'warning';
    case 'low':
      return 'outline';
    default:
      return 'default';
  }
}

export function TicketStatusBadge({ status }: { status: TicketStatus | string }) {
  return <Badge variant={ticketStatusVariant(status)}>{humanize(status)}</Badge>;
}

export function TicketPriorityBadge({ priority }: { priority: TicketPriority | string }) {
  return <Badge variant={ticketPriorityVariant(priority)}>{humanize(priority)}</Badge>;
}

/**
 * The SLA cell: the clock that is still running — first response until it happened, then
 * resolution until the ticket is resolved or closed — red when past due, quiet once met.
 */
export interface SlaFacts {
  status: string;
  first_responded_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  sla_first_response_due: string | null;
  sla_resolution_due: string | null;
}

export type SlaView = { kind: 'none' } | { kind: 'met'; label: string } | { kind: 'due' | 'overdue'; label: string; due: string };

export function slaView(t: SlaFacts, now: number = Date.now()): SlaView {
  if (t.status === 'resolved' || t.status === 'closed') {
    const done = t.resolved_at ?? t.closed_at;
    if (!t.sla_resolution_due || !done) return { kind: 'none' };
    return new Date(done).getTime() <= new Date(t.sla_resolution_due).getTime() ? { kind: 'met', label: 'Resolved in time' } : { kind: 'met', label: 'Resolved late' };
  }
  if (!t.first_responded_at) {
    if (!t.sla_first_response_due) return { kind: 'none' };
    const overdue = now > new Date(t.sla_first_response_due).getTime();
    return { kind: overdue ? 'overdue' : 'due', label: `First reply ${relativeTime(t.sla_first_response_due, now)}`, due: t.sla_first_response_due };
  }
  if (!t.sla_resolution_due) return { kind: 'none' };
  const overdue = now > new Date(t.sla_resolution_due).getTime();
  return { kind: overdue ? 'overdue' : 'due', label: `Resolve ${relativeTime(t.sla_resolution_due, now)}`, due: t.sla_resolution_due };
}

export function SlaCell({ ticket, className }: { ticket: SlaFacts; className?: string }) {
  const view = slaView(ticket);
  if (view.kind === 'none') return <span className={cn('text-muted-foreground', className)}>–</span>;
  if (view.kind === 'met') return <span className={cn('text-xs text-muted-foreground', className)}>{view.label}</span>;
  return (
    <span className={cn('inline-flex items-center gap-1 whitespace-nowrap text-xs', view.kind === 'overdue' ? 'font-medium text-danger' : 'text-muted-foreground', className)} title={new Date(view.due).toLocaleString()}>
      {view.kind === 'overdue' ? <AlertTriangle className="size-3.5" aria-hidden /> : null}
      {view.label}
    </span>
  );
}
