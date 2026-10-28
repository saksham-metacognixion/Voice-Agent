import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { adminDb } from '@portal/db';
import {
  type AdminConcurrencyResponse,
  type AdminJobResponse,
  type AdminKbResponse,
  type AdminProvisioningJob,
  type Page,
  STAFF_ROUTE_ROLES,
  adminKbsQuery,
  adminProvisioningQuery,
  staffActionRequest,
} from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { StaffCtx, StaffRoles } from '../auth';
import type { StaffContext } from '../auth';
import { AdminJobsService } from './admin-jobs.service';
import { AdminOperationsService, PROVISIONING_JOB_TYPES } from './admin-operations.service';
import { AdminReportsService } from './admin-reports.service';
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
}
