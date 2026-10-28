import { STAFF_ROUTE_ROLES, type StaffLimits, type StaffMeResponse, type StaffRole } from '@portal/schemas';

/**
 * Permission-aware UI (admin §2.2). The API enforces every rule again; this only keeps a
 * person from walking into a dead end. Each check answers `null` when allowed, else the
 * sentence the tooltip shows. A check is the route's role list (`STAFF_ROUTE_ROLES`, the
 * same lists `@StaffRoles` reads) **and** the role's limits: a limit ticked in SA13 for a
 * role the route does not accept still answers 403, so it must not enable the button (QA-048).
 */
export type Denied = string | null;

export const ROLE_LABELS: Record<StaffRole, string> = {
  super_admin: 'Super admin',
  ops: 'Ops',
  finance: 'Finance',
  support: 'Support',
  read_only: 'Read-only',
};

function needsRole(role: StaffRole, allowed: readonly StaffRole[]): Denied {
  if (allowed.includes(role)) return null;
  return `Needs ${allowed.map((r) => ROLE_LABELS[r]).join(' or ')}.`;
}

function needsLimit(limits: StaffLimits, key: keyof StaffLimits, label: string): Denied {
  return limits[key] ? null : `Your role cannot ${label}.`;
}

const R = STAFF_ROUTE_ROLES;

export function can(me: StaffMeResponse | null | undefined) {
  const role = me?.role ?? 'read_only';
  const limits = me?.limits;
  const missing = 'Loading your permissions…';
  return {
    pauseTenant: (): Denied => needsRole(role, R.mutate) ?? (limits ? needsLimit(limits, 'can_pause_tenant', 'pause or resume a customer') : missing),
    adjustCredits: (): Denied => {
      if (!limits) return missing;
      if (limits.credit_adjust_max_per_action === 0) return 'Your role cannot adjust credits.';
      return needsRole(role, R.money);
    },
    creditCap: (): number | null => limits?.credit_adjust_max_per_action ?? null,
    viewAs: (): Denied => needsRole(role, R.viewAs) ?? (limits ? needsLimit(limits, 'can_view_as_customer', 'view as a customer') : missing),
    manageFlags: (): Denied => needsRole(role, R.system) ?? (limits ? needsLimit(limits, 'can_manage_flags', 'manage flags and kill switches') : missing),
    /** SA13 (D13): invite, change roles, deactivate, edit the limits matrix — super admin with `can_manage_staff`. */
    manageStaff: (): Denied => (limits ? (needsRole(role, ['super_admin']) ?? needsLimit(limits, 'can_manage_staff', 'manage staff')) : missing),
    editPricingDraft: (): Denied => needsRole(role, R.pricingEdit) ?? (limits ? needsLimit(limits, 'can_edit_pricing_draft', 'edit the pricing draft') : missing),
    publishPricing: (): Denied => needsRole(role, R.pricingPublish) ?? (limits ? needsLimit(limits, 'can_publish_pricing', 'publish or roll back pricing') : missing),
    /** Jobs and webhooks actions: super admin or ops. */
    operateQueues: (): Denied => needsRole(role, R.system),
    /** Agent / number / user actions: super admin, ops, support. */
    supportActions: (): Denied => needsRole(role, R.mutate),
    /** Agent and number pause/resume: the support trio and `can_pause_tenant`, as the workspace's (QA-034). */
    pauseAgentOrNumber: (): Denied =>
      needsRole(role, R.mutate) ?? (limits ? needsLimit(limits, 'can_pause_tenant', 'pause or resume agents and numbers') : missing),
    /** Opening a stored webhook body (QA-033): everyone but read-only. */
    viewWebhookPayload: (): Denied => needsRole(role, R.payloadView),
    /** SA9 refunds: the MONEY matrix at the route, `refund_max_cents` inside it (0 = cannot). */
    refund: (): Denied => {
      if (!limits) return missing;
      if (limits.refund_max_cents === 0) return 'Your role cannot issue refunds.';
      return needsRole(role, R.money);
    },
    /** The refund ceiling per purchase in cents (all refunds on it counted), null when unlimited. */
    refundCap: (): number | null => limits?.refund_max_cents ?? null,
    /** SA9 top-up actions: the same MONEY matrix. */
    topupActions: (): Denied => needsRole(role, R.money),
    /** SA5 cost inputs: the draft's matrix and limit — the server asserts `can_edit_pricing_draft` (QA-054). */
    editCosts: (): Denied => needsRole(role, R.pricingEdit) ?? (limits ? needsLimit(limits, 'can_edit_pricing_draft', 'edit the cost inputs') : missing),
    /** SA4 tickets: open, reply, assign, change status — everyone but read-only (finance runs the money macros). */
    supportTickets: (): Denied => needsRole(role, ['super_admin', 'ops', 'support', 'finance']),
    /** SA4 `rerun_activation`: the support trio, not finance. */
    rerunActivation: (): Denied => needsRole(role, ['super_admin', 'ops', 'support']),
    /** Outbound compliance: a business verification verdict, a caller ID verified or revoked — super admin and ops. */
    compliance: (): Denied => needsRole(role, R.compliance),
    /** SA4 canned responses are the desk's own text. */
    manageCanned: (): Denied => needsRole(role, ['super_admin', 'ops', 'support']),
    isSuperAdmin: (): boolean => role === 'super_admin',
  };
}
