import { Injectable, Logger } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { adminDb } from '@portal/db';
import type { AdminCallerIdRequest, AdminKycDecisionRequest, AdminKycResponse } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import type { StaffContext } from '../auth';
import { kycOf } from '../outbound';
import { uuidParam } from './admin.helpers';
import { StaffAuditService } from './staff-audit.service';

/**
 * D18 staff decisions behind outbound calling (ADR 0031 §1): the business verification
 * verdict, and a number's caller ID verified or revoked. Both are compliance decisions —
 * super admin and ops (`STAFF_ROUTE_ROLES.compliance`) — and both land in `staff_audit_log`
 * and the workspace's own `audit_log` inside the write's transaction, like every
 * customer-affecting staff write. Withdrawing either stops the next callback at once:
 * `OutboundCallService` reads both from Postgres on every attempt, nothing is cached.
 */
@Injectable()
export class AdminOutboundService {
  private readonly log = new Logger(AdminOutboundService.name);

  constructor(private readonly audit: StaffAuditService) {}

  async kyc(idRaw: string): Promise<AdminKycResponse> {
    const id = uuidParam(idRaw, 'Customer');
    const tenant = await adminDb.tenant.findUnique({
      where: { id },
      select: { id: true, name: true, kycStatus: true, kycJson: true, kycSubmittedAt: true, kycDecidedAt: true, kycReason: true },
    });
    if (!tenant) throw AppError.notFound('Customer');
    const kyc = kycOf(tenant);
    // Staff read the reason whatever the status: a withdrawn verification keeps its sentence.
    return { tenant_id: tenant.id, tenant_name: tenant.name, ...kyc, reason: tenant.kycReason };
  }

  /**
   * Approve or reject. Approving needs a submission to approve; rejecting works from any
   * status, so a verified business can be withdrawn (fraud, a complaint) without waiting
   * for it to resubmit.
   */
  async decideKyc(staff: StaffContext, idRaw: string, body: AdminKycDecisionRequest, request: FastifyRequest): Promise<AdminKycResponse> {
    const id = uuidParam(idRaw, 'Customer');
    const tenant = await adminDb.tenant.findUnique({ where: { id }, select: { id: true, kycStatus: true, kycJson: true } });
    if (!tenant) throw AppError.notFound('Customer');
    if (body.decision === 'verified' && tenant.kycJson === null) {
      throw new AppError('CONFLICT', 'The customer has not submitted their business details yet.');
    }
    if (tenant.kycStatus !== body.decision) {
      const action = body.decision === 'verified' ? 'workspace.kyc_verified' : 'workspace.kyc_rejected';
      await adminDb.$transaction(async (tx) => {
        await tx.tenant.update({
          where: { id },
          data: { kycStatus: body.decision, kycDecidedAt: new Date(), kycReason: body.decision === 'rejected' ? body.customer_reason! : null },
        });
        await tx.auditLog.create({
          data: { tenantId: id, action, targetType: 'workspace', targetId: id, metaJson: { by: 'staff', reason_code: body.reason_code } },
        });
        await this.audit.record(
          {
            staff,
            action,
            targetType: 'tenant',
            targetId: id,
            tenantId: id,
            reasonCode: body.reason_code,
            note: body.note,
            before: { kyc_status: tenant.kycStatus },
            after: { kyc_status: body.decision },
            request,
          },
          tx,
        );
      });
      this.log.log(`workspace ${id}: business verification ${body.decision} by ${staff.email} (${body.reason_code})`);
    }
    return this.kyc(id);
  }

  /**
   * A number's caller ID. Verifying a SIP import is staff confirming the customer holds the
   * number (an LOA or a carrier bill); revoking any number takes it out of outbound calling.
   * `via = staff` either way, so provisioning never re-verifies a revoked number.
   */
  async setCallerId(staff: StaffContext, idRaw: string, body: AdminCallerIdRequest, request: FastifyRequest): Promise<void> {
    const id = uuidParam(idRaw, 'Number');
    const row = await adminDb.phoneNumber.findUnique({ where: { id }, select: { id: true, tenantId: true, status: true, e164: true, callerIdVerifiedAt: true } });
    if (!row) throw AppError.notFound('Number');
    if (body.verified && (!row.e164 || (row.status !== 'active' && row.status !== 'paused'))) {
      throw new AppError('CONFLICT', 'Only a live number can be verified as a caller ID.');
    }
    const before = row.callerIdVerifiedAt !== null;
    if (before === body.verified) return;
    const action = body.verified ? 'number.caller_id_verified' : 'number.caller_id_revoked';
    await adminDb.$transaction(async (tx) => {
      await tx.phoneNumber.update({ where: { id }, data: { callerIdVerifiedAt: body.verified ? new Date() : null, callerIdVerifiedVia: 'staff' } });
      await tx.auditLog.create({
        data: { tenantId: row.tenantId, action, targetType: 'number', targetId: id, metaJson: { by: 'staff', reason_code: body.reason_code } },
      });
      await this.audit.record(
        {
          staff,
          action,
          targetType: 'phone_number',
          targetId: id,
          tenantId: row.tenantId,
          reasonCode: body.reason_code,
          note: body.note,
          before: { caller_id_verified: before },
          after: { caller_id_verified: body.verified },
          request,
        },
        tx,
      );
    });
    this.log.log(`number ${id}: caller ID ${body.verified ? 'verified' : 'revoked'} by ${staff.email} (${body.reason_code})`);
  }
}
