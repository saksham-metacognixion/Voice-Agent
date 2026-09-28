import { Injectable } from '@nestjs/common';
import { adminDb } from '@portal/db';
import type { StaffLimits, StaffRole } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import type { StaffContext } from '../auth';
import { DAY_MS, numOrNull } from './admin.helpers';

export type StaffCapability = keyof Pick<
  StaffLimits,
  | 'can_listen_recordings'
  | 'can_change_plan'
  | 'can_pause_tenant'
  | 'can_edit_pricing_draft'
  | 'can_publish_pricing'
  | 'can_edit_agent_stack'
  | 'can_publish_agent_stack'
  | 'can_manage_flags'
  | 'can_view_as_customer'
  | 'can_act_as_customer'
  | 'can_delete_customer_data'
  | 'can_manage_staff'
  | 'can_export'
>;

const LABEL: Record<StaffCapability, string> = {
  can_listen_recordings: 'listen to recordings',
  can_change_plan: 'change a plan',
  can_pause_tenant: 'pause a workspace',
  can_edit_pricing_draft: 'edit the pricing draft',
  can_publish_pricing: 'publish pricing',
  can_edit_agent_stack: 'edit the agent stack',
  can_publish_agent_stack: 'publish the agent stack',
  can_manage_flags: 'manage flags and kill switches',
  can_view_as_customer: 'view as a customer',
  can_act_as_customer: 'act as a customer',
  can_delete_customer_data: 'delete customer data',
  can_manage_staff: 'manage staff',
  can_export: 'export',
};

/** The seed's defaults, for a role whose row is missing: everything off, no credit. */
const NOTHING: StaffLimits = {
  credit_adjust_max_per_action: 0,
  credit_adjust_max_per_day: 0,
  refund_max_cents: 0,
  can_listen_recordings: false,
  can_change_plan: false,
  can_pause_tenant: false,
  can_edit_pricing_draft: false,
  can_publish_pricing: false,
  can_edit_agent_stack: false,
  can_publish_agent_stack: false,
  can_manage_flags: false,
  can_view_as_customer: false,
  can_act_as_customer: false,
  can_delete_customer_data: false,
  can_manage_staff: false,
  can_export: false,
};

/**
 * Admin §2.2 / §10: the per-role limits, read from `staff_role_limits` so they are
 * tunable in SA13 without a deploy, and enforced here — server-side, on every write —
 * never only in the UI. `@StaffRoles(...)` on a route is the coarse matrix; this is the
 * fine one: how many credits, whether this role may pause, publish, view-as.
 *
 * Exceeding a limit is `403 STAFF_LIMIT_EXCEEDED` naming the role that could (admin §10);
 * the approval workflow that turns that into a request is P2.
 */
@Injectable()
export class StaffLimitsService {
  async limitsFor(role: StaffRole): Promise<StaffLimits> {
    const row = await adminDb.staffRoleLimit.findUnique({ where: { role } });
    if (!row) return NOTHING;
    return {
      credit_adjust_max_per_action: numOrNull(row.creditAdjustMaxPerAction),
      credit_adjust_max_per_day: numOrNull(row.creditAdjustMaxPerDay),
      refund_max_cents: row.refundMaxCents,
      can_listen_recordings: row.canListenRecordings,
      can_change_plan: row.canChangePlan,
      can_pause_tenant: row.canPauseTenant,
      can_edit_pricing_draft: row.canEditPricingDraft,
      can_publish_pricing: row.canPublishPricing,
      can_edit_agent_stack: row.canEditAgentStack,
      can_publish_agent_stack: row.canPublishAgentStack,
      can_manage_flags: row.canManageFlags,
      can_view_as_customer: row.canViewAsCustomer,
      can_act_as_customer: row.canActAsCustomer,
      can_delete_customer_data: row.canDeleteCustomerData,
      can_manage_staff: row.canManageStaff,
      can_export: row.canExport,
    };
  }

  async assertCan(staff: StaffContext, capability: StaffCapability): Promise<StaffLimits> {
    const limits = await this.limitsFor(staff.role);
    if (!limits[capability]) {
      throw new AppError(
        'STAFF_LIMIT_EXCEEDED',
        `Your role (${staff.role.replace('_', ' ')}) cannot ${LABEL[capability]}. This requires ${await this.rolesThatCan(capability)}.`,
      );
    }
    return limits;
  }

  /**
   * Credit adjustments have two ceilings: per action and per rolling day, both in absolute
   * credits. Per day counts what this staff member already moved in the last 24 h across
   * every workspace, from `credit_adjustments` (the staff-side record of every adjustment).
   */
  async assertCreditAdjustment(
    staff: StaffContext,
    delta: number,
    now = new Date(),
  ): Promise<StaffLimits> {
    const limits = await this.limitsFor(staff.role);
    const amount = Math.abs(delta);
    if (
      limits.credit_adjust_max_per_action !== null &&
      amount > limits.credit_adjust_max_per_action
    ) {
      throw new AppError(
        'STAFF_LIMIT_EXCEEDED',
        limits.credit_adjust_max_per_action === 0
          ? `Your role (${staff.role.replace('_', ' ')}) cannot adjust credits.`
          : `Your role may adjust up to ${limits.credit_adjust_max_per_action} credits per action; this is ${amount}. Requires ${await this.rolesThatCanAdjust(amount)}.`,
      );
    }
    if (limits.credit_adjust_max_per_day !== null) {
      const rows = await adminDb.creditAdjustment.findMany({
        where: { staffId: staff.staffId, createdAt: { gte: new Date(now.getTime() - DAY_MS) } },
        select: { delta: true },
      });
      const today = rows.reduce((sum, r) => sum + Math.abs(r.delta.toNumber()), 0);
      if (today + amount > limits.credit_adjust_max_per_day) {
        throw new AppError(
          'STAFF_LIMIT_EXCEEDED',
          `Your role may adjust up to ${limits.credit_adjust_max_per_day} credits per day; you have moved ${today} in the last 24 hours.`,
        );
      }
    }
    return limits;
  }

  /**
   * SA9 refunds (admin §2.2, D13): `refund_max_cents` is a ceiling per purchase in cents —
   * this refund plus what the purchase has already refunded (or has in flight), whoever
   * issued it. null is unlimited (super admin), 0 is "cannot refund at all" (ops, support,
   * read-only in the seed). Exceeding it names the roles that could.
   */
  async assertRefund(
    staff: StaffContext,
    amountCents: number,
    alreadyRefundedCents = 0,
  ): Promise<StaffLimits> {
    const limits = await this.limitsFor(staff.role);
    const cap = limits.refund_max_cents;
    if (cap === null) return limits;
    const total = alreadyRefundedCents + amountCents;
    if (cap === 0) {
      throw new AppError(
        'STAFF_LIMIT_EXCEEDED',
        `Your role (${staff.role.replace('_', ' ')}) cannot issue refunds. This requires ${await this.rolesThatCanRefund(total)}.`,
      );
    }
    if (total > cap) {
      const already = alreadyRefundedCents
        ? ` (${(alreadyRefundedCents / 100).toFixed(2)} already refunded plus ${(amountCents / 100).toFixed(2)})`
        : '';
      throw new AppError(
        'STAFF_LIMIT_EXCEEDED',
        `Your role may refund up to ${(cap / 100).toFixed(2)} per purchase; this would make ${(total / 100).toFixed(2)}${already}. Requires ${await this.rolesThatCanRefund(total)}.`,
      );
    }
    return limits;
  }

  private async rolesThatCanRefund(amountCents: number): Promise<string> {
    const rows = await adminDb.staffRoleLimit.findMany();
    const names = rows
      .filter((r) => r.refundMaxCents === null || (r.refundMaxCents > 0 && r.refundMaxCents >= amountCents))
      .map((r) => r.role.replace('_', ' '));
    return names.length ? names.join(' or ') : 'a super admin';
  }

  private async rolesThatCan(capability: StaffCapability): Promise<string> {
    const rows = await adminDb.staffRoleLimit.findMany();
    const names = rows
      .filter((r) => {
        const map: Record<StaffCapability, boolean> = {
          can_listen_recordings: r.canListenRecordings,
          can_change_plan: r.canChangePlan,
          can_pause_tenant: r.canPauseTenant,
          can_edit_pricing_draft: r.canEditPricingDraft,
          can_publish_pricing: r.canPublishPricing,
          can_edit_agent_stack: r.canEditAgentStack,
          can_publish_agent_stack: r.canPublishAgentStack,
          can_manage_flags: r.canManageFlags,
          can_view_as_customer: r.canViewAsCustomer,
          can_act_as_customer: r.canActAsCustomer,
          can_delete_customer_data: r.canDeleteCustomerData,
          can_manage_staff: r.canManageStaff,
          can_export: r.canExport,
        };
        return map[capability];
      })
      .map((r) => r.role.replace('_', ' '));
    return names.length ? names.join(' or ') : 'a super admin';
  }

  private async rolesThatCanAdjust(amount: number): Promise<string> {
    const rows = await adminDb.staffRoleLimit.findMany();
    const names = rows
      .filter(
        (r) =>
          r.creditAdjustMaxPerAction === null || r.creditAdjustMaxPerAction.toNumber() >= amount,
      )
      .map((r) => r.role.replace('_', ' '));
    return names.length ? names.join(' or ') : 'a super admin';
  }
}
