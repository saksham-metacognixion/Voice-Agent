import type { TicketPriority } from '@portal/schemas';

/**
 * Admin §4 SA4 — the SLA clock, in one place. First response is due 4 h after the ticket
 * opens (1 h when urgent); resolution is due 3 business days later. Business days skip
 * Saturday and Sunday in UTC — there is no staff calendar or holiday table yet (P2).
 */
export const TICKET_SLA = {
  first_response_hours: { default: 4, urgent: 1 } as const,
  resolution_business_days: 3,
} as const;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export function firstResponseDue(createdAt: Date, priority: TicketPriority): Date {
  const hours =
    priority === 'urgent'
      ? TICKET_SLA.first_response_hours.urgent
      : TICKET_SLA.first_response_hours.default;
  return new Date(createdAt.getTime() + hours * HOUR_MS);
}

export function resolutionDue(createdAt: Date): Date {
  return addBusinessDays(createdAt, TICKET_SLA.resolution_business_days);
}

/** `days` weekdays after `from`, keeping the time of day; a weekend start counts from the next Monday. */
export function addBusinessDays(from: Date, days: number): Date {
  let t = from.getTime();
  let remaining = days;
  while (remaining > 0) {
    t += DAY_MS;
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) remaining -= 1;
  }
  return new Date(t);
}

export function slaState(
  due: string | Date | null,
  doneAt: string | Date | null,
  now = new Date(),
): 'met' | 'due' | 'overdue' | 'none' {
  if (!due) return 'none';
  const dueMs = new Date(due).getTime();
  if (doneAt) return new Date(doneAt).getTime() <= dueMs ? 'met' : 'overdue';
  return now.getTime() > dueMs ? 'overdue' : 'due';
}
