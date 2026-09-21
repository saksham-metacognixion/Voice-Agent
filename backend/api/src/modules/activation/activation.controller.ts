import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { type AcceptedJob, type ActivationView, activateRequest, uuid } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { Ctx, RequireEmailVerified, Roles } from '../auth';
import type { WorkspaceContext } from '../auth';
import { ActivationService } from './activation.service';

/**
 * §13.8. `POST /agents/:id/activate` answers 202 with the job id; the client subscribes
 * to `activation:{job_id}` and falls back to `GET /jobs/:id` or `GET /agents/:id/activation`.
 * Owner/admin: going live spends credits (the number rental) and needs a paid purchase.
 */
@Controller()
export class ActivationController {
  constructor(private readonly activation: ActivationService) {}

  @Post('agents/:id/activate')
  @HttpCode(202)
  @Roles('owner', 'admin')
  @RequireEmailVerified()
  activate(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Body() body: unknown): Promise<AcceptedJob> {
    return this.activation.activate(ctx, idOf(id, 'Agent'), activateRequest.parse(body ?? {}).version_no);
  }

  @Get('agents/:id/activation')
  latest(@Ctx() ctx: WorkspaceContext, @Param('id') id: string): Promise<ActivationView> {
    return this.activation.latest(ctx, idOf(id, 'Agent'));
  }

  @Get('activations/:id')
  get(@Ctx() ctx: WorkspaceContext, @Param('id') id: string): Promise<ActivationView> {
    return this.activation.get(ctx, idOf(id, 'Activation'));
  }
}

function idOf(value: string, what: string): string {
  const parsed = uuid.safeParse(value);
  if (!parsed.success) throw AppError.notFound(what);
  return parsed.data;
}
