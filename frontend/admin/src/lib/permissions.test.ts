import type { StaffLimits, StaffMeResponse, StaffRole } from '@portal/schemas';
import { describe, expect, it } from 'vitest';
import { can } from './permissions';

const ALL_ON: StaffLimits = {
  credit_adjust_max_per_action: null,
  credit_adjust_max_per_day: null,
  refund_max_cents: null,
  can_listen_recordings: true,
  can_change_plan: true,
  can_pause_tenant: true,
  can_edit_pricing_draft: true,
  can_publish_pricing: true,
  can_edit_agent_stack: true,
  can_publish_agent_stack: true,
  can_manage_flags: true,
  can_view_as_customer: true,
  can_act_as_customer: true,
  can_delete_customer_data: true,
  can_manage_staff: true,
  can_export: true,
};

function me(role: StaffRole, limits: Partial<StaffLimits> = {}): StaffMeResponse {
  return { id: '00000000-0000-4000-8000-000000000001', email: 'staff@example.com', name: null, role, limits: { ...ALL_ON, ...limits }, impersonations: [] };
}

describe('can() — route roles and limits together (QA-048)', () => {
  it('does not enable a button the route refuses, whatever SA13 ticked', () => {
    // Finance with "publish pricing" ticked: the route is super admin only.
    expect(can(me('finance')).publishPricing()).toMatch(/Needs Super admin/);
    expect(can(me('finance')).manageFlags()).toMatch(/Needs/);
    expect(can(me('read_only')).pauseTenant()).toMatch(/Needs/);
    expect(can(me('read_only')).viewAs()).toMatch(/Needs/);
    expect(can(me('support')).editPricingDraft()).toMatch(/Needs/);
  });

  it('still applies the limit for a role the route accepts', () => {
    expect(can(me('super_admin', { can_publish_pricing: false })).publishPricing()).toMatch(/cannot publish/);
    expect(can(me('ops', { can_manage_flags: false })).manageFlags()).toMatch(/cannot manage flags/);
    expect(can(me('finance', { can_edit_pricing_draft: true })).editPricingDraft()).toBeNull();
    expect(can(me('support')).pauseTenant()).toBeNull();
  });
});
