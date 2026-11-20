import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { type AccountResponse, type ForgetDevicesResponse, type MfaDisableResponse, type SignInMethodsResponse, type TermsStatus, type VerificationEmailResponse, termsAcceptRequest } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { NoWorkspace } from '../auth';
import type { AuthenticatedUser } from '../auth';
import { AccountService } from './account.service';

/**
 * The signed-in person, before any workspace (ADR 0036): who they are, whether they have
 * accepted the Terms in force (§6.3 A1), and A2's "Resend". `@NoWorkspace()`, scoped by
 * the token's subject only — nothing in a path or body names whose account it is. A staff
 * view-as session is refused: it is read-only and these are the customer's own records.
 */
@Controller('me')
export class AccountController {
  constructor(private readonly account: AccountService) {}

  @Get()
  @NoWorkspace()
  me(@Req() request: FastifyRequest): Promise<AccountResponse> {
    return this.account.me(personOf(request));
  }

  /** §6.3 A1 "[x] I agree to the Terms and Privacy Policy" — the box the person ticked. */
  @Post('terms')
  @NoWorkspace()
  acceptTerms(@Req() request: FastifyRequest, @Body() body: unknown): Promise<TermsStatus> {
    const input = termsAcceptRequest.parse(body);
    return this.account.acceptTerms(personOf(request), input.version, { ip: request.ip ?? null, userAgent: header(request, 'user-agent') });
  }

  /**
   * A4 "Remember this device" (ADR 0036 §4): every browser that skips the second factor
   * for 30 days asks for it again at its next sign-in. Settings → Security.
   */
  @Post('devices/forget')
  @NoWorkspace()
  forgetDevices(@Req() request: FastifyRequest): Promise<ForgetDevicesResponse> {
    return this.account.forgetDevices(personOf(request), request.ip ?? null);
  }

  /** D6 Security "MFA … disable (with re-auth)": the session must have passed a factor in the last five minutes. */
  @Post('mfa/disable')
  @NoWorkspace()
  disableMfa(@Req() request: FastifyRequest): Promise<MfaDisableResponse> {
    return this.account.disableMfa(personOf(request), request.ip ?? null);
  }

  /** D6 Security "connected SSO accounts". */
  @Get('sign-in-methods')
  @NoWorkspace()
  signInMethods(@Req() request: FastifyRequest): Promise<SignInMethodsResponse> {
    return this.account.signInMethods(personOf(request));
  }

  /** §6.3 A2 "Resend" — 60-second cooldown, 5 an hour, both counted here. */
  @Post('verification-email')
  @NoWorkspace()
  resendVerification(@Req() request: FastifyRequest): Promise<VerificationEmailResponse> {
    return this.account.resendVerification(personOf(request));
  }
}

function personOf(request: FastifyRequest): AuthenticatedUser {
  if (request.impersonation) throw new AppError('IMPERSONATION_READ_ONLY', 'Viewing as a customer does not show their account.');
  const auth = request.auth;
  if (!auth) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
  return auth;
}

function header(request: FastifyRequest, name: string): string | null {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value ? value.slice(0, 300) : null;
}
