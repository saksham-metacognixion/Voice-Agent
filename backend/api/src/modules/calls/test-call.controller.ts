import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { type TestWebCallResponse, testWebCallRequest, uuid } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { Ctx, RequireEmailVerified, Roles } from '../auth';
import type { WorkspaceContext } from '../auth';
import { TestCallService } from './test-call.service';

/**
 * §13.4 `POST /agents/:id/test/web`. Editor and above, like every other edit-and-try
 * route on an agent; a verified email, because a test call spends credits (§16
 * `EMAIL_UNVERIFIED`).
 */
@Controller('agents')
export class TestCallController {
  constructor(private readonly tests: TestCallService) {}

  @Post(':id/test/web')
  @HttpCode(201)
  @Roles('owner', 'admin', 'editor')
  @RequireEmailVerified()
  startWeb(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Body() body: unknown): Promise<TestWebCallResponse> {
    const agentId = uuid.safeParse(id);
    if (!agentId.success) throw AppError.notFound('Agent');
    return this.tests.startWebCall(ctx, agentId.data, testWebCallRequest.parse(body ?? {}).version_no);
  }
}
