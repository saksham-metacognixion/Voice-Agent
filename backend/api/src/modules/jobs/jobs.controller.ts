import { Controller, Get, Param } from '@nestjs/common';
import { type JobResponse, uuid } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { Ctx } from '../auth';
import type { WorkspaceContext } from '../auth';
import { JobRecordsService } from './job-records.service';

/**
 * `GET /jobs/:id` (§16) — the polling fallback behind every `202 {job_id}`.
 *
 * The client's first choice is SSE; this is what it falls back to every 3 s when the
 * stream is not available, and what it reads after a reload. Every role may look: a job
 * is progress, not data, and the §6.1 matrix gates the action that *started* it.
 */
@Controller('jobs')
export class JobsController {
  constructor(private readonly jobs: JobRecordsService) {}

  @Get(':id')
  get(@Ctx() ctx: WorkspaceContext, @Param('id') id: string): Promise<JobResponse> {
    const parsed = uuid.safeParse(id);
    if (!parsed.success) throw AppError.notFound('Job');
    return this.jobs.get(ctx, parsed.data);
  }
}
