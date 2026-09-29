import { Body, Controller, Get, Param, Patch, Post, Put, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  type AdminStaffLimitsResponse,
  type StaffMemberResponse,
  adminInviteStaffRequest,
  adminStaffLimitsRequest,
  adminUpdateStaffRequest,
} from '@portal/schemas';
import { StaffCtx, StaffRoles } from '../auth';
import type { StaffContext } from '../auth';
import { AdminStaffService } from './admin-staff.service';

const STAFF_ADMIN = ['super_admin'] as const;

/**
 * SA13 — staff members and the role-limits matrix (admin §4 SA13, §2.2). Reads are open
 * to every staff role (the console shows who is who); writes are super admin on the
 * route and `can_manage_staff` inside the service. `limits` is declared before `:id` so
 * the static segment never reads as an id.
 */
@Controller('admin/staff')
export class AdminStaffController {
  constructor(private readonly staff: AdminStaffService) {}

  @Get()
  list(): Promise<StaffMemberResponse[]> {
    return this.staff.list();
  }

  @Get('limits')
  limits(): Promise<AdminStaffLimitsResponse> {
    return this.staff.limitsMatrix();
  }

  @Put('limits')
  @StaffRoles(...STAFF_ADMIN)
  updateLimits(
    @StaffCtx() staff: StaffContext,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminStaffLimitsResponse> {
    return this.staff.updateLimits(staff, adminStaffLimitsRequest.parse(body), request);
  }

  @Post()
  @StaffRoles(...STAFF_ADMIN)
  invite(
    @StaffCtx() staff: StaffContext,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<StaffMemberResponse> {
    return this.staff.invite(staff, adminInviteStaffRequest.parse(body), request);
  }

  @Patch(':id')
  @StaffRoles(...STAFF_ADMIN)
  update(
    @StaffCtx() staff: StaffContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<StaffMemberResponse> {
    return this.staff.update(staff, id, adminUpdateStaffRequest.parse(body), request);
  }
}
