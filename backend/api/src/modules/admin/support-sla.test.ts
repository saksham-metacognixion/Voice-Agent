import { describe, expect, it } from 'vitest';
import { derivedUuid } from './admin-support.service';
import { TICKET_SLA, addBusinessDays, firstResponseDue, resolutionDue, slaState } from './support-sla';

describe('SA4 SLA clock', () => {
  it('first response: 4 h by default, 1 h when urgent', () => {
    const at = new Date('2026-09-28T10:00:00Z');
    expect(firstResponseDue(at, 'normal').toISOString()).toBe('2026-09-28T14:00:00.000Z');
    expect(firstResponseDue(at, 'urgent').toISOString()).toBe('2026-09-28T11:00:00.000Z');
    expect(TICKET_SLA.resolution_business_days).toBe(3);
  });

  it('resolution: three business days, skipping the weekend', () => {
    // Monday 28 Sep 2026 → Thursday 1 Oct.
    expect(resolutionDue(new Date('2026-09-28T10:00:00Z')).toISOString()).toBe('2026-10-01T10:00:00.000Z');
    // Thursday 1 Oct → Tuesday 6 Oct (Fri, Mon, Tue).
    expect(resolutionDue(new Date('2026-10-01T10:00:00Z')).toISOString()).toBe('2026-10-06T10:00:00.000Z');
    // Saturday 3 Oct → Wednesday 7 Oct (Mon, Tue, Wed).
    expect(addBusinessDays(new Date('2026-10-03T10:00:00Z'), 3).toISOString()).toBe('2026-10-07T10:00:00.000Z');
  });

  it('slaState reads the clock', () => {
    const due = '2026-09-28T14:00:00Z';
    expect(slaState(null, null)).toBe('none');
    expect(slaState(due, null, new Date('2026-09-28T13:00:00Z'))).toBe('due');
    expect(slaState(due, null, new Date('2026-09-28T15:00:00Z'))).toBe('overdue');
    expect(slaState(due, '2026-09-28T13:30:00Z')).toBe('met');
    expect(slaState(due, '2026-09-28T16:00:00Z')).toBe('overdue');
  });
});

describe('derivedUuid', () => {
  it('is a stable, well-formed uuid scoped to its seed', () => {
    const a = derivedUuid('ticket-1-refund-call_x');
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(derivedUuid('ticket-1-refund-call_x')).toBe(a);
    expect(derivedUuid('ticket-2-refund-call_x')).not.toBe(a);
  });
});
