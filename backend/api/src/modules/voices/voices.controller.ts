import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { type VoicePreviewResponse, type VoicesResponse, voicePreviewRequest, voicesQuery } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { Ctx } from '../auth';
import type { WorkspaceContext } from '../auth';
import { VoicesService } from './voices.service';

/**
 * W3 (§16): `GET /voices?lang=&gender=&tier=&multilingual=` and
 * `POST /voices/:id/preview {text}`.
 *
 * Both are workspace-scoped rather than public, for two different reasons: the catalogue
 * is a competitive detail we do not publish, and the preview is rate-limited per
 * workspace, which needs a workspace. Every role may read and preview — choosing a voice
 * is part of editing an agent, and the write it leads to is gated on the draft PATCH.
 */
@Controller('voices')
export class VoicesController {
  constructor(private readonly voices: VoicesService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query() query: Record<string, unknown>): Promise<VoicesResponse> {
    return this.voices.list(ctx, voicesQuery.parse(query));
  }

  @Post(':id/preview')
  preview(
    @Ctx() ctx: WorkspaceContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<VoicePreviewResponse> {
    return this.voices.preview(ctx, voiceId(id), voicePreviewRequest.parse(body ?? {}));
  }
}

/**
 * Provider voice ids look like `11labs-Adrian`. Anything outside that alphabet is not an
 * id we could have cached, so it is a 404 rather than a query.
 */
function voiceId(value: string): string {
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(value)) throw AppError.notFound('Voice');
  return value;
}
