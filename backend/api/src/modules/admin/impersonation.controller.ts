import { Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { EndedResponse, ImpersonationContext } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { AllowImpersonationWrite, NoWorkspace } from '../auth';
import { ImpersonationService } from './impersonation.service';

/**
 * The customer-namespace half of admin §7.4 (D12): what the portal's banner reads and
 * the one write a view-as session may make — ending itself. Both need the impersonation
 * credential; an ordinary customer token is a 404 here, because there is no session.
 */
@Controller('impersonation')
export class ImpersonationController {
  constructor(private readonly impersonation: ImpersonationService) {}

  @Get()
  @NoWorkspace()
  current(@Req() request: FastifyRequest): ImpersonationContext {
    if (!request.impersonation) throw AppError.notFound('Impersonation session');
    return this.impersonation.context(request.impersonation);
  }

  @Post('end')
  @HttpCode(200)
  @NoWorkspace()
  @AllowImpersonationWrite()
  end(@Req() request: FastifyRequest): Promise<EndedResponse> {
    if (!request.impersonation) throw AppError.notFound('Impersonation session');
    return this.impersonation.endFromPortal(request.impersonation, request);
  }
}
