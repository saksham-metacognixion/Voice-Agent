import { Controller, Get, Query } from '@nestjs/common';
import {
  type AdminConcurrencyResponse,
  type AdminProvisioningJob,
  type Page,
  adminProvisioningQuery,
} from '@portal/schemas';
import { AdminOperationsService } from './admin-operations.service';

/**
 * SA7 (admin §4, D13): the provisioning queue and the live-concurrency view. Reads only,
 * any staff role; the retry stays `POST /admin/jobs/:id/retry`.
 */
@Controller('admin')
export class AdminOperationsController {
  constructor(private readonly operations: AdminOperationsService) {}

  @Get('provisioning')
  provisioning(@Query() query: Record<string, unknown>): Promise<Page<AdminProvisioningJob>> {
    return this.operations.provisioning(adminProvisioningQuery.parse(query));
  }

  @Get('concurrency')
  concurrency(): Promise<AdminConcurrencyResponse> {
    return this.operations.concurrency();
  }
}
