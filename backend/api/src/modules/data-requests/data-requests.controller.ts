import { Body, Controller, Delete, Get, HttpCode, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Readable } from 'node:stream';
import { deleteWorkspaceRequest, type WorkspaceDeletionRequest } from '@portal/schemas';
import { Ctx, RequireEmailVerified, Roles } from '../auth';
import type { WorkspaceContext } from '../auth';
import { DataRequestsService } from './data-requests.service';
import { WorkspaceExportService } from './workspace-export.service';
import { zipStream } from './zip-stream';

/**
 * D6 Data & privacy (QA-081, spec p. 39, §17): "export all data" and "delete workspace".
 *
 * Both are POSTs, so a staff view-as session (read-only, ADR 0021) can do neither.
 */
@Controller('workspace')
export class DataRequestsController {
  constructor(
    private readonly exports: WorkspaceExportService,
    private readonly requests: DataRequestsService,
  ) {}

  /**
   * "Export all data" — a zip of the workspace's own data, streamed as it is read
   * (`WorkspaceExportService`). Owner/admin: it holds every member's email and the billing
   * history. The request is recorded before the first byte, so a refusal (`429
   * RATE_LIMITED`) is an ordinary JSON error. `@Res()` hands the reply to Fastify; the 200
   * is explicit because Nest answers a POST with 201.
   */
  @Post('export')
  @HttpCode(200)
  @Roles('owner', 'admin')
  @RequireEmailVerified()
  async export(@Ctx() ctx: WorkspaceContext, @Res() reply: FastifyReply): Promise<void> {
    const started = await this.exports.start(ctx);
    const stamp = started.at.toISOString().slice(0, 19).replace(/[:T]/g, '-');
    void reply
      .code(200)
      .headers({
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="workspace-export-${stamp}.zip"`,
        'cache-control': 'private, no-store',
      })
      .send(Readable.from(zipStream(this.exports.entries(ctx, started), started.at)));
  }

  /** The open deletion request, or null — any member, so everyone sees the workspace is going. */
  @Get('delete-request')
  openDeletion(@Ctx() ctx: WorkspaceContext): Promise<WorkspaceDeletionRequest | null> {
    return this.requests.openDeletion(ctx);
  }

  /** "Delete workspace" — §6.1 owner only, typed confirmation, verified email. */
  @Post('delete-request')
  @Roles('owner')
  @RequireEmailVerified()
  requestDeletion(@Ctx() ctx: WorkspaceContext, @Body() body: unknown): Promise<WorkspaceDeletionRequest> {
    return this.requests.requestDeletion(ctx, deleteWorkspaceRequest.parse(body));
  }

  /** The owner withdraws an open request before staff carry it out. */
  @Delete('delete-request')
  @Roles('owner')
  withdrawDeletion(@Ctx() ctx: WorkspaceContext): Promise<{ revoked: boolean }> {
    return this.requests.withdrawDeletion(ctx);
  }
}
