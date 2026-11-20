import { Controller, Get } from '@nestjs/common';
import { Ctx, NoWorkspace, Public, Roles, StaffCtx, StaffRoles } from '../src/modules/auth';
import type { StaffContext, WorkspaceContext } from '../src/modules/auth';

/**
 * Stand-in routes covering each shape a real controller can take. They exist so the
 * auth tests can assert on the guards rather than on whatever a feature module happens
 * to do this week.
 */
@Controller()
export class ProbeController {
  @Get('probe/public')
  @Public()
  publicRoute() {
    return { ok: true };
  }

  @Get('probe/me')
  @NoWorkspace()
  me() {
    return { ok: true };
  }

  @Get('probe/workspace')
  workspace(@Ctx() ctx: WorkspaceContext) {
    return ctx;
  }

  @Get('probe/owner-only')
  @Roles('owner')
  ownerOnly(@Ctx() ctx: WorkspaceContext) {
    return ctx;
  }

  @Get('probe/editor-and-up')
  @Roles('owner', 'admin', 'editor')
  editorAndUp(@Ctx() ctx: WorkspaceContext) {
    return ctx;
  }

  @Get('admin/probe')
  adminRoute(@StaffCtx() staff: StaffContext) {
    return staff;
  }

  @Get('admin/probe/super-only')
  @StaffRoles('super_admin')
  superOnly(@StaffCtx() staff: StaffContext) {
    return staff;
  }

  @Get('administrators')
  notAStaffRoute(@Ctx() ctx: WorkspaceContext) {
    return ctx;
  }
}
