import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { adminDb } from '@portal/db';
import {
  type AdminConcurrencyResponse,
  type AdminJobResponse,
  type AdminKbResponse,
  type AdminProvisioningJob,
  type AdminSettingsResponse,
  type Page,
  STAFF_ROUTE_ROLES,
  adminConcurrencyAllowanceRequest,
  adminKbsQuery,
  adminProvisioningQuery,
  adminSettingsUpdateRequest,
  staffActionRequest,
} from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { StaffCtx, StaffRoles } from '../auth';
import type { StaffContext } from '../auth';
import { AdminJobsService } from './admin-jobs.service';
import { AdminOperationsService, PROVISIONING_JOB_TYPES } from './admin-operations.service';
import { AdminReportsService } from './admin-reports.service';
import { AdminSettingsService } from './admin-settings.service';
import { uuidParam } from './admin.helpers';

/**
 * SA7 (admin §4, D13): the provisioning queue and the live-concurrency view, read by any
 * staff role, plus the queue's Retry (admin §9 `POST /admin/provisioning/:jobId/retry`).
 */
@Controller('admin')
export class AdminOperationsController {
  constructor(
    private readonly operations: AdminOperationsService,
    private readonly jobs: AdminJobsService,
    private readonly reports: AdminReportsService,
    private readonly settings: AdminSettingsService,
  ) {}

  @Get('provisioning')
  provisioning(@Query() query: Record<string, unknown>): Promise<Page<AdminProvisioningJob>> {
    return this.operations.provisioning(adminProvisioningQuery.parse(query));
  }

  /**
   * The same retry as `POST /admin/jobs/:id/retry` — same checks, same audit rows, same
   * re-enqueue — narrowed to the provisioning queue's job types, so a link from this tab
   * cannot retry anything else.
   */
  @Post('provisioning/:jobId/retry')
  @HttpCode(200)
  @StaffRoles(...STAFF_ROUTE_ROLES.system)
  async retry(
    @StaffCtx() staff: StaffContext,
    @Param('jobId') jobId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminJobResponse> {
    const row = await adminDb.job.findUnique({ where: { id: uuidParam(jobId, 'Job') }, select: { type: true } });
    if (!row || !(PROVISIONING_JOB_TYPES as readonly string[]).includes(row.type)) throw AppError.notFound('Job');
    return this.jobs.retry(staff, jobId, staffActionRequest.parse(body), request);
  }

  /** Admin §9 `GET /admin/kbs`: every agent with knowledge, across workspaces. */
  @Get('kbs')
  kbs(@Query() query: Record<string, unknown>): Promise<Page<AdminKbResponse>> {
    return this.reports.kbs(adminKbsQuery.parse(query));
  }

  @Get('concurrency')
  concurrency(): Promise<AdminConcurrencyResponse> {
    return this.operations.concurrency();
  }

  /** Admin §9: the voice platform's concurrent-call allowance, edited on the Concurrency tab. */
  @Put('concurrency/allowance')
  @StaffRoles(...STAFF_ROUTE_ROLES.system)
  async allowance(@StaffCtx() staff: StaffContext, @Body() body: unknown, @Req() request: FastifyRequest): Promise<AdminConcurrencyResponse> {
    await this.settings.setAllowance(staff, adminConcurrencyAllowanceRequest.parse(body), request);
    return this.operations.concurrency();
  }

  /** Admin §9 platform settings: the knobs that were environment variables. Read by any staff role. */
  @Get('settings')
  getSettings(): Promise<AdminSettingsResponse> {
    return this.settings.get();
  }

  @Put('settings')
  @StaffRoles(...STAFF_ROUTE_ROLES.system)
  putSettings(@StaffCtx() staff: StaffContext, @Body() body: unknown, @Req() request: FastifyRequest): Promise<AdminSettingsResponse> {
    return this.settings.update(staff, adminSettingsUpdateRequest.parse(body), request);
  }
}
