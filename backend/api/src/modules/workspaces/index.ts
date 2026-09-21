export { WorkspacesModule } from './workspaces.module';
export { WorkspacesService } from './workspaces.service';
export { MembersService, hashToken, INVITE_TTL_MS } from './members.service';
// The `users` mirror moved to `auth` (AuthGuard provisions from it); re-exported for its importers.
export { UsersService } from '../auth';
export type { AuthUpsertOutcome } from '../auth';
export { WorkspacesController } from './workspaces.controller';
