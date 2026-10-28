import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications';
import { RuntimeCacheModule } from '../runtime-cache';
import { WalletModule } from '../wallet';
import { MembersService } from './members.service';
import { WorkspacesController } from './workspaces.controller';
import { SessionsController } from './sessions.controller';
import { WorkspacesService } from './workspaces.service';

/**
 * Spec §13.1 `workspaces` — tenancy itself: creating a workspace and who is in it. The
 * Auth0 mirror of the people (`UsersService`) lives in `auth`, because the guard
 * provisions from it; `POST /webhooks/auth` drives the same service.
 *
 * It depends on the wallet because §13.2 puts the trial grant inside the same transaction
 * as the workspace, and on runtime-cache because a new or renamed workspace changes what
 * the §13.9 hot path reads, and on notifications for the D6 invitation email (the
 * outbox). Nothing depends on it in the other direction — `webhooks`
 * imports it for the user upsert, never the reverse.
 */
@Module({
  imports: [WalletModule, RuntimeCacheModule, NotificationsModule],
  controllers: [WorkspacesController, SessionsController],
  providers: [WorkspacesService, MembersService],
  exports: [WorkspacesService, MembersService],
})
export class WorkspacesModule {}
