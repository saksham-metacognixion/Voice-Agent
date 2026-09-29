export { AuthModule } from './auth.module';
export { AuthConfig } from './auth.config';
export { JwtVerifier } from './jwt-verifier.service';
export { AuthGuard, StaffRolesGuard, namespaceForPath, STAFF_PATH_PREFIX, STAFF_INVITE_PREFIX } from './auth.guard';
export { WorkspaceGuard } from './workspace.guard';
export { UsersService, SecondIdentityRefused, DisposableEmailRefused } from './users.service';
export { isDisposableEmail } from './disposable-email';
export { ImpersonationTokenService, IMPERSONATION_PREFIX, IMPERSONATION_TTL_S } from './impersonation-token';
export type { ImpersonationClaims } from './impersonation-token';
export { Auth0ManagementService } from './auth0-management.service';
export type { ProviderUserFacts } from './auth0-management.service';
export type { AuthUpsertOutcome } from './users.service';
export {
  Public,
  NoWorkspace,
  Roles,
  StaffRoles,
  RequireEmailVerified,
  AllowImpersonationWrite,
  Ctx,
  StaffCtx,
} from './auth.decorators';
export type {
  AuthenticatedUser,
  WorkspaceContext,
  StaffContext,
  ImpersonationContext,
  AuthNamespace,
} from './auth.types';
