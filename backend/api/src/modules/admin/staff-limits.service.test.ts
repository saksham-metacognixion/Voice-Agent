import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Admin §2.2 / §10: per-role staff limits, enforced server-side (D12, D13, QA-034,
 * QA-037). `staff_role_limits`, `support_tickets` and `credit_adjustments` are replaced
 * with in-memory rows; the limits arithmetic and the refusals are what is asserted.
 */

const db = vi.hoisted(() => ({
  staffRoleLimit: { findUnique: vi.fn(), findMany: vi.fn() },
  supportTicket: { findFirst: vi.fn() },
  creditAdjustment: { findMany: vi.fn() },
}));
vi.mock('@portal/db', () => ({ adminDb: db }));

import { limitInCurrency } from '@portal/schemas';
import { StaffLimitsService } from './staff-limits.service';

const dec = (n: number) => ({ toNumber: () => n });

function row(role: string, over: Record<string, unknown> = {}) {
  return {
    role,
    creditAdjustMaxPerAction: dec(100),
    creditAdjustMaxPerDay: dec(500),
    refundMaxCents: 10_000,
    canListenRecordings: false,
    canChangePlan: false,
    canPauseTenant: false,
    canEditPricingDraft: false,
    canPublishPricing: false,
    canEditAgentStack: false,
    canPublishAgentStack: false,
    canManageFlags: false,
    canViewAsCustomer: false,
    canActAsCustomer: false,
    canDeleteCustomerData: false,
    canManageStaff: false,
    canExport: false,
    ...over,
  };
}

const ROWS = [
  row('super_admin', { creditAdjustMaxPerAction: null, creditAdjustMaxPerDay: null, refundMaxCents: null, canPauseTenant: true, canManageStaff: true }),
  row('ops', { refundMaxCents: 0, canPauseTenant: true }),
  row('finance', { creditAdjustMaxPerAction: dec(1_000), refundMaxCents: 50_000 }),
  row('support', { creditAdjustMaxPerAction: dec(25), creditAdjustMaxPerDay: dec(50), refundMaxCents: 0, canPauseTenant: true }),
  row('read_only', { creditAdjustMaxPerAction: dec(0), creditAdjustMaxPerDay: dec(0), refundMaxCents: 0 }),
];

const staff = (role: string, staffId = `${role}-1`) => ({ staffId, role, email: `${role}@oraly.ai` }) as never;

beforeEach(() => {
  db.staffRoleLimit.findUnique.mockReset().mockImplementation(({ where }: { where: { role: string } }) =>
    Promise.resolve(ROWS.find((r) => r.role === where.role) ?? null),
  );
  db.staffRoleLimit.findMany.mockReset().mockResolvedValue(ROWS);
  db.supportTicket.findFirst.mockReset();
  db.creditAdjustment.findMany.mockReset().mockResolvedValue([]);
});

const limits = new StaffLimitsService();

describe('limitsFor', () => {
  it('maps the row to the wire shape, decimals as numbers and null as unlimited', async () => {
    await expect(limits.limitsFor('finance')).resolves.toMatchObject({ credit_adjust_max_per_action: 1_000, credit_adjust_max_per_day: 500, refund_max_cents: 50_000 });
    await expect(limits.limitsFor('super_admin')).resolves.toMatchObject({ credit_adjust_max_per_action: null, refund_max_cents: null, can_manage_staff: true });
  });

  it('a role with no row gets nothing: every capability off, no credit, no refund', async () => {
    const none = await limits.limitsFor('ghost' as never);
    expect(none.credit_adjust_max_per_action).toBe(0);
    expect(none.refund_max_cents).toBe(0);
    expect(Object.entries(none).filter(([k, v]) => k.startsWith('can_') && v)).toEqual([]);
  });
});

describe('assertCan', () => {
  it('passes a role that holds the capability', async () => {
    await expect(limits.assertCan(staff('ops'), 'can_pause_tenant')).resolves.toMatchObject({ can_pause_tenant: true });
  });

  it('refuses with STAFF_LIMIT_EXCEEDED naming the roles that could', async () => {
    await expect(limits.assertCan(staff('finance'), 'can_pause_tenant')).rejects.toMatchObject({
      code: 'STAFF_LIMIT_EXCEEDED',
      message: 'Your role (finance) cannot pause a workspace. This requires super admin or ops or support.',
    });
  });

  it('falls back to "a super admin" when no row grants the capability', async () => {
    await expect(limits.assertCan(staff('ops'), 'can_act_as_customer')).rejects.toMatchObject({
      message: expect.stringContaining('This requires a super admin.'),
    });
  });
});

describe('assertPauseTicket (admin §2.2, QA-034)', () => {
  it('needs no ticket from anyone but support', async () => {
    await expect(limits.assertPauseTicket(staff('ops'), 'ws-1', undefined, 'workspace')).resolves.toBeUndefined();
    expect(db.supportTicket.findFirst).not.toHaveBeenCalled();
  });

  it('refuses support without a ticket, naming the level', async () => {
    await expect(limits.assertPauseTicket(staff('support'), 'ws-1', undefined, 'agent')).rejects.toMatchObject({
      code: 'STAFF_LIMIT_EXCEEDED',
      message: 'Support pauses an agent against a ticket. Add the ticket number.',
    });
    await expect(limits.assertPauseTicket(staff('support'), 'ws-1', undefined, 'workspace')).rejects.toMatchObject({
      message: expect.stringContaining('a workspace'),
    });
  });

  it('refuses support with a ticket of another workspace, looked up by id and workspace', async () => {
    db.supportTicket.findFirst.mockResolvedValue(null);
    await expect(limits.assertPauseTicket(staff('support'), 'ws-1', 42, 'number')).rejects.toMatchObject({
      message: "Ticket #42 is not one of this workspace's tickets.",
    });
    expect(db.supportTicket.findFirst).toHaveBeenCalledWith({ where: { id: 42, tenantId: 'ws-1' }, select: { id: true } });
  });

  it('passes support with a ticket of this workspace', async () => {
    db.supportTicket.findFirst.mockResolvedValue({ id: 42 });
    await expect(limits.assertPauseTicket(staff('support'), 'ws-1', 42, 'workspace')).resolves.toBeUndefined();
  });
});

describe('assertCreditAdjustment (QA-037)', () => {
  it('passes up to the per-action ceiling, positive or negative', async () => {
    await expect(limits.assertCreditAdjustment(staff('support'), 25)).resolves.toBeTruthy();
    await expect(limits.assertCreditAdjustment(staff('support'), -25)).resolves.toBeTruthy();
  });

  it('refuses one credit over the per-action ceiling, naming roles with room', async () => {
    await expect(limits.assertCreditAdjustment(staff('support'), -26)).rejects.toMatchObject({
      code: 'STAFF_LIMIT_EXCEEDED',
      message: 'Your role may adjust up to 25 credits per action; this is 26. Requires super admin or ops or finance.',
    });
  });

  it('a zero ceiling reads as "cannot adjust credits"', async () => {
    await expect(limits.assertCreditAdjustment(staff('read_only'), 1)).rejects.toMatchObject({
      message: 'Your role (read only) cannot adjust credits.',
    });
  });

  it('sums the last 24 h in absolute credits against the daily ceiling', async () => {
    const now = new Date('2026-11-04T12:00:00Z');
    db.creditAdjustment.findMany.mockResolvedValue([{ delta: dec(20) }, { delta: dec(-20) }]);
    await expect(limits.assertCreditAdjustment(staff('support'), 10, now)).resolves.toBeTruthy();
    await expect(limits.assertCreditAdjustment(staff('support'), 11, now)).rejects.toMatchObject({
      message: 'Your role may adjust up to 50 credits per day; you have moved 40 in the last 24 hours.',
    });
    expect(db.creditAdjustment.findMany).toHaveBeenCalledWith({
      where: { staffId: 'support-1', createdAt: { gte: new Date('2026-11-03T12:00:00Z') } },
      select: { delta: true },
    });
  });

  it('inside a transaction, takes the per-staff lock and re-sums on that transaction', async () => {
    const tx = { $executeRaw: vi.fn().mockResolvedValue(1), creditAdjustment: { findMany: vi.fn().mockResolvedValue([{ delta: dec(45) }]) } };
    await expect(limits.assertCreditAdjustment(staff('support'), 10, new Date(), tx as never)).rejects.toMatchObject({ code: 'STAFF_LIMIT_EXCEEDED' });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw.mock.calls[0]!.slice(1)).toEqual(['staff-credit-adjust:support-1']);
    expect(tx.creditAdjustment.findMany).toHaveBeenCalled();
    expect(db.creditAdjustment.findMany).not.toHaveBeenCalled();
  });

  it('an unlimited role is never summed', async () => {
    await expect(limits.assertCreditAdjustment(staff('super_admin'), 1_000_000)).resolves.toBeTruthy();
    expect(db.creditAdjustment.findMany).not.toHaveBeenCalled();
  });
});

describe('assertRefund (SA9, per purchase)', () => {
  it('null is unlimited', async () => {
    await expect(limits.assertRefund(staff('super_admin'), 9_999_999, 9_999_999)).resolves.toBeTruthy();
  });

  it('zero is "cannot refund", naming the roles that could cover the amount', async () => {
    await expect(limits.assertRefund(staff('ops'), 4_900)).rejects.toMatchObject({
      code: 'STAFF_LIMIT_EXCEEDED',
      message: 'Your role (ops) cannot issue refunds. This requires super admin or finance.',
    });
  });

  it('counts what the purchase already refunded against the cap (exactly the cap passes)', async () => {
    await expect(limits.assertRefund(staff('finance'), 30_000, 20_000)).resolves.toBeTruthy();
    await expect(limits.assertRefund(staff('finance'), 30_001, 20_000)).rejects.toMatchObject({
      message:
        'Your role may refund up to 500.00 per purchase; this would make 500.01 (200.00 already refunded plus 300.01). Requires super admin.',
    });
  });

  it('omits the "already refunded" clause on a first refund', async () => {
    await expect(limits.assertRefund(staff('finance'), 60_000)).rejects.toMatchObject({
      message: 'Your role may refund up to 500.00 per purchase; this would make 600.00. Requires super admin.',
    });
  });
});

/* ADR 0049: the cap is a USD figure. A CAD purchase is judged against it at that purchase's own rate. */
describe('assertRefund in CAD', () => {
  const at = (rate: string) => ({ currency: 'CAD', convert: (cents: number) => limitInCurrency(cents, 'CAD', rate)! });

  it('converts the USD cap with the purchase rate: 500.00 USD at 1.4291 is 714.55 CAD', async () => {
    await expect(limits.assertRefund(staff('finance'), 71_455, 0, at('1.4291'))).resolves.toBeTruthy();
    await expect(limits.assertRefund(staff('finance'), 71_456, 0, at('1.4291'))).rejects.toMatchObject({
      code: 'STAFF_LIMIT_EXCEEDED',
      message: "Your role may refund up to 714.55 CAD (500.00 USD at this purchase's rate) per purchase; this would make 714.56. Requires super admin.",
    });
  });

  it('uses the rate handed in, so a purchase made at another rate keeps its own ceiling', async () => {
    await expect(limits.assertRefund(staff('finance'), 67_500, 0, at('1.3500'))).resolves.toBeTruthy();
    await expect(limits.assertRefund(staff('finance'), 67_501, 0, at('1.3500'))).rejects.toMatchObject({ code: 'STAFF_LIMIT_EXCEEDED' });
    // The same 675.01 CAD is inside the cap of a purchase made at 1.4291.
    await expect(limits.assertRefund(staff('finance'), 67_501, 0, at('1.4291'))).resolves.toBeTruthy();
  });

  it('counts earlier CAD refunds on the purchase against the converted cap', async () => {
    await expect(limits.assertRefund(staff('finance'), 21_455, 50_000, at('1.4291'))).resolves.toBeTruthy();
    await expect(limits.assertRefund(staff('finance'), 21_456, 50_000, at('1.4291'))).rejects.toMatchObject({ code: 'STAFF_LIMIT_EXCEEDED' });
  });

  it('keeps "cannot refund" and "unlimited" as they are in any currency', async () => {
    await expect(limits.assertRefund(staff('ops'), 1, 0, at('1.4291'))).rejects.toMatchObject({ code: 'STAFF_LIMIT_EXCEEDED' });
    await expect(limits.assertRefund(staff('super_admin'), 9_999_999, 0, at('1.4291'))).resolves.toBeTruthy();
  });

  it('asks for the conversion only when the role has a cap to convert', async () => {
    const noRate = vi.fn(async (): Promise<never> => {
      throw new Error('no exchange rate');
    });
    await expect(limits.assertRefund(staff('super_admin'), 9_999_999, 0, noRate)).resolves.toBeTruthy();
    expect(noRate).not.toHaveBeenCalled();
    // A role that cannot refund at all is told so, not that a rate is missing.
    await expect(limits.assertRefund(staff('ops'), 1, 0, noRate)).rejects.toMatchObject({ code: 'STAFF_LIMIT_EXCEEDED' });
    // A capped role does need it, and its failure is the caller's error.
    await expect(limits.assertRefund(staff('finance'), 1, 0, noRate)).rejects.toThrow('no exchange rate');
    await expect(limits.assertRefund(staff('finance'), 71_455, 0, async () => at('1.4291'))).resolves.toBeTruthy();
  });

  it('a USD purchase is judged against the cap exactly as stored', async () => {
    await expect(limits.assertRefund(staff('finance'), 50_000, 0, { currency: 'USD', convert: (cents) => cents })).resolves.toBeTruthy();
    await expect(limits.assertRefund(staff('finance'), 50_001, 0, { currency: 'USD', convert: (cents) => cents })).rejects.toMatchObject({
      message: 'Your role may refund up to 500.00 per purchase; this would make 500.01. Requires super admin.',
    });
  });
});
