import type { StaffLimits, StaffMeResponse, StaffRole } from '@portal/schemas';

/**
 * Permission-aware UI (admin §2.2). The API enforces every rule again; this only keeps a
 * person from walking into a dead end. Each check answers `null` when allowed, else the
 * sentence the tooltip shows.
 */
export type Denied = string | null;

export const ROLE_LABELS: Record<StaffRole, string> = {
  super_admin: 'Super admin',
  ops: 'Ops',
  finance: 'Finance',
  support: 'Support',
  read_only: 'Read-only',
};

function needsRole(role: StaffRole, allowed: StaffRole[]): Denied {
  if (allowed.includes(role)) return null;
  return `Needs ${allowed.map((r) => ROLE_LABELS[r]).join(' or ')}.`;
}

function needsLimit(limits: StaffLimits, key: keyof StaffLimits, label: string): Denied {
  return limits[key] ? null : `Your role cannot ${label}.`;
}

export function can(me: StaffMeResponse | null | undefined) {
  const role = me?.role ?? 'read_only';
  const limits = me?.limits;
  const missing = 'Loading your permissions…';
  return {
    pauseTenant: (): Denied => (limits ? needsLimit(limits, 'can_pause_tenant', 'pause or resume a customer') : missing),
    adjustCredits: (): Denied => {
      if (!limits) return missing;
      if (limits.credit_adjust_max_per_action === 0) return 'Your role cannot adjust credits.';
      return needsRole(role, ['super_admin', 'ops', 'finance', 'support']);
    },
    creditCap: (): number | null => limits?.credit_adjust_max_per_action ?? null,
    viewAs: (): Denied => (limits ? needsLimit(limits, 'can_view_as_customer', 'view as a customer') : missing),
    manageFlags: (): Denied => (limits ? needsLimit(limits, 'can_manage_flags', 'manage flags and kill switches') : missing),
    /** SA13 (D13): invite, change roles, deactivate, edit the limits matrix — super admin with `can_manage_staff`. */
    manageStaff: (): Denied => (limits ? (needsRole(role, ['super_admin']) ?? needsLimit(limits, 'can_manage_staff', 'manage staff')) : missing),
    editPricingDraft: (): Denied => (limits ? needsLimit(limits, 'can_edit_pricing_draft', 'edit the pricing draft') : missing),
    publishPricing: (): Denied => (limits ? needsLimit(limits, 'can_publish_pricing', 'publish or roll back pricing') : missing),
    /** Jobs and webhooks actions: super admin or ops. */
    operateQueues: (): Denied => needsRole(role, ['super_admin', 'ops']),
    /** Agent / number / user actions: super admin, ops, support. */
    supportActions: (): Denied => needsRole(role, ['super_admin', 'ops', 'support']),
    /** SA9 refunds: the MONEY matrix at the route, `refund_max_cents` inside it (0 = cannot). */
    refund: (): Denied => {
      if (!limits) return missing;
      if (limits.refund_max_cents === 0) return 'Your role cannot issue refunds.';
      return needsRole(role, ['super_admin', 'ops', 'finance', 'support']);
    },
    /** The per-refund ceiling in cents, null when unlimited. */
    refundCap: (): number | null => limits?.refund_max_cents ?? null,
    /** SA9 top-up actions: the same MONEY matrix. */
    topupActions: (): Denied => needsRole(role, ['super_admin', 'ops', 'finance', 'support']),
    editCosts: (): Denied => needsRole(role, ['super_admin', 'finance']),
    /** SA4 tickets: open, reply, assign, change status — everyone but read-only (finance runs the money macros). */
    supportTickets: (): Denied => needsRole(role, ['super_admin', 'ops', 'support', 'finance']),
    /** SA4 `rerun_activation`: the support trio, not finance. */
    rerunActivation: (): Denied => needsRole(role, ['super_admin', 'ops', 'support']),
    /** SA4 canned responses are the desk's own text. */
    manageCanned: (): Denied => needsRole(role, ['super_admin', 'ops', 'support']),
    isSuperAdmin: (): boolean => role === 'super_admin',
  };
}
