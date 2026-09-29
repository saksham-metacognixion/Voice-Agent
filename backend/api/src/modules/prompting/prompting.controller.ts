import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import {
  type AcceptedJob,
  type ExtractDocumentResponse,
  extractDocumentRequest,
  feedbackRequest,
  generateRequest,
  uuid,
} from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { Ctx, RequireEmailVerified, Roles } from '../auth';
import type { WorkspaceContext } from '../auth';
import { PromptingService } from './prompting.service';

/**
 * The two prompting routes (§16). They live on `/agents/:id` because that is where the
 * spec puts them and where the portal calls them; the module behind them is `prompting`
 * (§13.1), which is why they are not in the agents controller.
 *
 * Both answer `202 {job_id}` and never wait for the model (§13.3 step 1). Both are
 * Editor+ — generating rewrites the agent — and both require a verified email, because
 * generation is the first thing in the product that costs us money to run.
 */
@Controller('agents')
export class PromptingController {
  constructor(private readonly prompting: PromptingService) {}

  /** §13.3. `mode: regenerate` rewrites from the brief and keeps the test feedback (W2). */
  @Post(':id/generate')
  @HttpCode(202)
  @Roles('owner', 'admin', 'editor')
  @RequireEmailVerified()
  generate(
    @Ctx() ctx: WorkspaceContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<AcceptedJob> {
    return this.prompting.generate(ctx, agentId(id), generateRequest.parse(body ?? {}));
  }

  /**
   * ADR 0023 — a W2 document (file or photo) in, its plain text out. Synchronous: a
   * file is milliseconds, a photo is one vision call of a few seconds. Nothing is
   * stored; the portal writes the text into the brief and the autosave keeps it. Lives
   * here rather than on `agents` because the photo path needs the prompt provider.
   */
  @Post(':id/documents/extract')
  @Roles('owner', 'admin', 'editor')
  extractDocument(
    @Ctx() ctx: WorkspaceContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ExtractDocumentResponse> {
    return this.prompting.extractDocument(ctx, agentId(id), extractDocumentRequest.parse(body));
  }

  /** §13.5 — plain-language improvement, `source=feedback`. */
  @Post(':id/feedback')
  @HttpCode(202)
  @Roles('owner', 'admin', 'editor')
  @RequireEmailVerified()
  feedback(
    @Ctx() ctx: WorkspaceContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<AcceptedJob> {
    return this.prompting.feedback(ctx, agentId(id), feedbackRequest.parse(body));
  }
}

function agentId(value: string): string {
  const parsed = uuid.safeParse(value);
  if (!parsed.success) throw AppError.notFound('Agent');
  return parsed.data;
}
