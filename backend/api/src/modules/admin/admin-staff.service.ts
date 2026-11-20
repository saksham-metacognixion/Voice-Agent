import { Injectable, Logger } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Prisma, adminDb } from '@portal/db';
import {
  type AdminInviteStaffRequest,
  type AdminStaffLimitsRequest,
  type AdminStaffLimitsResponse,
  type AdminUpdateStaffRequest,
  type StaffLimits,
  type StaffLimitsMatrix,
  type StaffMemberResponse,
  type StaffRole,
  staffRole,
} from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { STAFF_INVITE_PREFIX } from '../auth';
import type { StaffContext } from '../auth';
import { iso, uuidParam } from './admin.helpers';
import { StaffAuditService } from './staff-audit.service';
import { StaffLimitsService } from './staff-limits.service';

/**
 * The placeholder `auth_provider_id` an invited colleague carries until their first
 * sign-in. `AuthGuard.authenticateStaff()` binds it to the real `sub` on that request
 * (matched on the token's `https://portal/email` claim), atomically, so two first
 * requests racing cannot both claim the row and a second identity for the same email
 * is refused. The prefix itself lives in `auth` (the guard cannot import this module).
 */
export { STAFF_INVITE_PREFIX };

export function staffInvitePlaceholder(email: string): string {
  return `${STAFF_INVITE_PREFIX}${email.trim().toLowerCase()}`;
}

/**
 * The one place `STAFF_ALLOWED_EMAIL_DOMAIN` is read on the API. The staff tenant's
 * Post-Login Action enforces the same domain at sign-in (`ALLOWED_EMAIL_DOMAIN`), so an
 * invite outside it would be a row nobody can ever bind. Unset (a dev box, CI) answers
 * null and the invite falls back to the inviter's own domain.
 */
export function staffEmailDomain(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.STAFF_ALLOWED_EMAIL_DOMAIN?.trim().toLowerCase().replace(/^@/, '');
  return raw || null;
}

const ROLES: readonly StaffRole[] = staffRole.options;
const MAX_LISTED = 500;

const SELECT = {
  id: true,
  authProviderId: true,
  email: true,
  name: true,
  role: true,
  mfaEnforced: true,
  active: true,
  lastLoginAt: true,
  createdAt: true,
} satisfies Prisma.StaffUserSelect;
type Row = Prisma.StaffUserGetPayload<{ select: typeof SELECT }>;

/**
 * SA13 "Staff & settings" (admin §4, §2.1, §2.2, §10 — D13): who has console access,
 * with which role, and the per-role limits. Every write here is a super-admin write
 * behind `can_manage_staff` — the route matrix says super admin, the limits table says
 * the role may manage staff, both enforced server-side — and every one is audited in
 * the same transaction as the change. These are not customer-affecting, so they carry
 * no reason code; the audit row is still the record.
 *
 * Guards that keep the console reachable: nobody changes their own role or deactivates
 * themselves, the last active super admin cannot be demoted or deactivated, and the
 * super admin row of the limits matrix must keep `can_manage_staff`.
 */
@Injectable()
export class AdminStaffService {
  private readonly log = new Logger(AdminStaffService.name);

  constructor(
    private readonly audit: StaffAuditService,
    private readonly limits: StaffLimitsService,
  ) {}

  // ------------------------------------------------------------------ members

  async list(): Promise<StaffMemberResponse[]> {
    const rows = await adminDb.staffUser.findMany({
      select: SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MAX_LISTED,
    });
    return rows.map(toResponse);
  }

  async invite(
    staff: StaffContext,
    body: AdminInviteStaffRequest,
    request: FastifyRequest,
  ): Promise<StaffMemberResponse> {
    await this.limits.assertCan(staff, 'can_manage_staff');
    const email = body.email;
    const domain = staffEmailDomain() ?? staff.email.split('@')[1]?.toLowerCase() ?? null;
    if (!domain || !email.endsWith(`@${domain}`)) {
      throw new AppError('VALIDATION_FAILED', 'Staff accounts must use the company domain.', [
        {
          field: 'email',
          message: domain
            ? `Must be an @${domain} address.`
            : 'No staff email domain is configured.',
        },
      ]);
    }
    const existing = await adminDb.staffUser.findUnique({ where: { email }, select: { id: true } });
    if (existing) throw new AppError('CONFLICT', 'A staff member with this email already exists.');

    const created = await adminDb.$transaction(async (tx) => {
      const row = await tx.staffUser.create({
        data: {
          authProviderId: staffInvitePlaceholder(email),
          email,
          name: body.name ?? null,
          role: body.role,
          active: true,
        },
        select: SELECT,
      });
      await this.audit.record(
        {
          staff,
          action: 'staff.invited',
          targetType: 'staff',
          targetId: row.id,
          after: { email: row.email, name: row.name, role: row.role },
          request,
        },
        tx,
      );
      return row;
    });
    this.log.log(`staff ${created.email} invited as ${created.role} by ${staff.email}`);
    return toResponse(created);
  }

  async update(
    staff: StaffContext,
    idRaw: string,
    body: AdminUpdateStaffRequest,
    request: FastifyRequest,
  ): Promise<StaffMemberResponse> {
    await this.limits.assertCan(staff, 'can_manage_staff');
    const id = uuidParam(idRaw, 'Staff member');
    const row = await adminDb.staffUser.findUnique({ where: { id }, select: SELECT });
    if (!row) throw AppError.notFound('Staff member');

    const roleChanges = body.role !== undefined && body.role !== row.role;
    const deactivates = body.active === false && row.active;
    // The graver reason first: a lone super admin demoting themselves hears why it is refused.
    if (row.role === 'super_admin' && row.active && (roleChanges || deactivates)) {
      const others = await adminDb.staffUser.count({
        where: { role: 'super_admin', active: true, id: { not: row.id } },
      });
      if (others === 0) {
        throw new AppError('CONFLICT', 'This is the last active super admin. Promote someone else first.');
      }
    }
    if (row.id === staff.staffId && (roleChanges || deactivates)) {
      throw new AppError(
        'CONFLICT',
        'You cannot change your own role or deactivate yourself. Ask another super admin.',
      );
    }

    const data: Prisma.StaffUserUpdateInput = {};
    if (body.role !== undefined) data.role = body.role;
    if (body.active !== undefined) data.active = body.active;
    if (body.name !== undefined) data.name = body.name;
    if (body.mfa_enforced !== undefined) data.mfaEnforced = body.mfa_enforced;

    const updated = await adminDb.$transaction(async (tx) => {
      const next = await tx.staffUser.update({ where: { id }, data, select: SELECT });
      await this.audit.record(
        {
          staff,
          action: 'staff.updated',
          targetType: 'staff',
          targetId: id,
          note: body.note ?? null,
          before: snapshot(row),
          after: snapshot(next),
          request,
        },
        tx,
      );
      return next;
    });
    this.log.log(
      `staff ${updated.email} updated by ${staff.email}: ${Object.keys(data).join(', ')}`,
    );
    return toResponse(updated);
  }

  // ------------------------------------------------------------------ limits (admin §2.2)

  async limitsMatrix(): Promise<AdminStaffLimitsResponse> {
    const rows = await adminDb.staffRoleLimit.findMany();
    const limits = Object.fromEntries(
      await Promise.all(ROLES.map(async (role) => [role, await this.limits.limitsFor(role)])),
    ) as StaffLimitsMatrix;
    const newest = rows.reduce<Date | null>(
      (max, r) => (!max || r.updatedAt > max ? r.updatedAt : max),
      null,
    );
    return { limits, updated_at: iso(newest) };
  }

  async updateLimits(
    staff: StaffContext,
    body: AdminStaffLimitsRequest,
    request: FastifyRequest,
  ): Promise<AdminStaffLimitsResponse> {
    await this.limits.assertCan(staff, 'can_manage_staff');
    if (!body.limits.super_admin.can_manage_staff) {
      throw new AppError(
        'CONFLICT',
        'The super admin role must keep "manage staff", or nobody could change these limits again.',
      );
    }
    const before = await this.limitsMatrix();
    await adminDb.$transaction(async (tx) => {
      for (const role of ROLES) {
        const l = body.limits[role];
        const data = toColumns(l);
        await tx.staffRoleLimit.upsert({
          where: { role },
          create: { role, ...data },
          update: data,
        });
      }
      await this.audit.record(
        {
          staff,
          action: 'staff.limits_updated',
          targetType: 'staff_role_limits',
          targetId: 'matrix',
          note: body.note ?? null,
          before: before.limits,
          after: body.limits,
          request,
        },
        tx,
      );
    });
    this.log.warn(`staff role limits rewritten by ${staff.email}`);
    return this.limitsMatrix();
  }
}

function toColumns(l: StaffLimits): Omit<Prisma.StaffRoleLimitUncheckedCreateInput, 'role'> {
  return {
    creditAdjustMaxPerAction: l.credit_adjust_max_per_action,
    creditAdjustMaxPerDay: l.credit_adjust_max_per_day,
    refundMaxCents: l.refund_max_cents,
    canListenRecordings: l.can_listen_recordings,
    canChangePlan: l.can_change_plan,
    canPauseTenant: l.can_pause_tenant,
    canEditPricingDraft: l.can_edit_pricing_draft,
    canPublishPricing: l.can_publish_pricing,
    canEditAgentStack: l.can_edit_agent_stack,
    canPublishAgentStack: l.can_publish_agent_stack,
    canManageFlags: l.can_manage_flags,
    canViewAsCustomer: l.can_view_as_customer,
    canActAsCustomer: l.can_act_as_customer,
    canDeleteCustomerData: l.can_delete_customer_data,
    canManageStaff: l.can_manage_staff,
    canExport: l.can_export,
  };
}

function snapshot(r: Row) {
  return {
    email: r.email,
    name: r.name,
    role: r.role,
    active: r.active,
    mfa_enforced: r.mfaEnforced,
  };
}

function toResponse(r: Row): StaffMemberResponse {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    role: r.role,
    mfa_enforced: r.mfaEnforced,
    active: r.active,
    last_login_at: iso(r.lastLoginAt),
    created_at: r.createdAt.toISOString(),
    bound: !r.authProviderId.startsWith(STAFF_INVITE_PREFIX),
  };
}
