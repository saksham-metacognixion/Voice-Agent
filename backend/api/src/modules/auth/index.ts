export { AuthModule } from './auth.module';
export { AuthConfig } from './auth.config';
export { JwtVerifier } from './jwt-verifier.service';
export { AuthGuard, StaffRolesGuard, namespaceForPath, STAFF_PATH_PREFIX } from './auth.guard';
export { WorkspaceGuard } from './workspace.guard';
export {
  Public,
  NoWorkspace,
  Roles,
  StaffRoles,
  RequireEmailVerified,
  Ctx,
  StaffCtx,
} from './auth.decorators';
export type {
  AuthenticatedUser,
  WorkspaceContext,
  StaffContext,
  AuthNamespace,
} from './auth.types';
