import { Controller, Delete, Get, Logger, Param, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AccountSessionsResponse, EndSessionResponse } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { Auth0ManagementService, NoWorkspace } from '../auth';
import type { AuthenticatedUser } from '../auth';

/**
 * §6.2 Settings → Security, "where you're signed in" (`GET /sessions`, `DELETE /sessions/:id`).
 *
 * Sessions belong to the person, not a workspace, so these are `@NoWorkspace()` and read
 * the signed-in user's `sub`; nothing in a path or body names whose sessions they are, and
 * a session id that is not this person's is a 404 (`Auth0ManagementService.endSession`).
 *
 * A staff view-as session is refused on both: `@NoWorkspace()` skips the workspace guard
 * that makes view-as read-only, and a customer's devices and addresses are not something
 * view-as needs to see.
 */
@Controller('sessions')
export class SessionsController {
  private readonly log = new Logger(SessionsController.name);

  constructor(private readonly auth0: Auth0ManagementService) {}

  @Get()
  @NoWorkspace()
  async list(@Req() request: FastifyRequest): Promise<AccountSessionsResponse> {
    const auth = personOf(request);
    try {
      const sessions = await this.auth0.listSessions(auth.subject);
      return sessions === null ? { available: false, sessions: [] } : { available: true, sessions };
    } catch (error) {
      this.log.warn(`sessions of ${auth.userId}: ${error instanceof Error ? error.message : String(error)}`);
      throw new AppError('UPSTREAM_UNAVAILABLE', 'We could not load your sessions just now. Try again in a moment.');
    }
  }

  @Delete(':id')
  @NoWorkspace()
  async end(@Req() request: FastifyRequest, @Param('id') id: string): Promise<EndSessionResponse> {
    const auth = personOf(request);
    if (!/^[\w-]{1,128}$/.test(id)) throw AppError.notFound('Session');
    let result: Awaited<ReturnType<Auth0ManagementService['endSession']>>;
    try {
      result = await this.auth0.endSession(auth.subject, id);
    } catch (error) {
      this.log.warn(`end session ${id} of ${auth.userId}: ${error instanceof Error ? error.message : String(error)}`);
      throw new AppError('UPSTREAM_UNAVAILABLE', 'We could not sign that device out just now. Try again in a moment.');
    }
    if (result.outcome === 'not_found') throw AppError.notFound('Session');
    if (result.outcome === 'skipped') throw new AppError('NOT_CONFIGURED', 'Sessions cannot be managed in this environment.');
    this.log.log(`user ${auth.userId} ended session ${id} (${result.refreshTokensRevoked} refresh tokens revoked)`);
    return { ended: true, refresh_tokens_revoked: result.refreshTokensRevoked };
  }
}

function personOf(request: FastifyRequest): AuthenticatedUser {
  if (request.impersonation) throw new AppError('IMPERSONATION_READ_ONLY', 'Viewing as a customer does not show their sign-in sessions.');
  const auth = request.auth;
  if (!auth) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
  return auth;
}
