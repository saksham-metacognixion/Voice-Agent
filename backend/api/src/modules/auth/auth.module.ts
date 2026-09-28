import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthConfig } from './auth.config';
import { AuthGuard, StaffRolesGuard } from './auth.guard';
import { Auth0ManagementService } from './auth0-management.service';
import { ImpersonationTokenService } from './impersonation-token';
import { JwtVerifier } from './jwt-verifier.service';
import { UsersService } from './users.service';
import { WorkspaceGuard } from './workspace.guard';

/**
 * Authentication is on by default. A route is reachable without a token only if it says
 * so with @Public() — so a new controller added on a busy day is protected, not exposed.
 *
 * Guard order matters and is the registration order below:
 *   AuthGuard       who are you        → request.auth / request.staff
 *   WorkspaceGuard  which workspace    → request.ctx, plus the @Roles check
 *   StaffRolesGuard which staff role   → the admin §2.2 matrix
 */
@Global()
@Module({
  providers: [
    // A factory, not useClass: the constructor takes the environment so it can be
    // unit-tested against one, and Nest must not try to inject that.
    { provide: AuthConfig, useFactory: () => new AuthConfig(process.env) },
    JwtVerifier,
    // The `users` mirror. Here rather than in `workspaces` because AuthGuard provisions a
    // row for a verified sign-in whose registration webhook never arrived (§13.2).
    UsersService,
    // D12: mints and checks the view-as credential (admin §7.4). Same shape as the
    // recording signer — the constructor reads the environment, so a factory.
    { provide: ImpersonationTokenService, useFactory: () => new ImpersonationTokenService(process.env) },
    // D12 SA3: the customer tenant's Management API (verify email, reset MFA, block, revoke sessions).
    { provide: Auth0ManagementService, useFactory: () => new Auth0ManagementService(process.env) },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: WorkspaceGuard },
    { provide: APP_GUARD, useClass: StaffRolesGuard },
  ],
  exports: [AuthConfig, JwtVerifier, UsersService, ImpersonationTokenService, Auth0ManagementService],
})
export class AuthModule {}
