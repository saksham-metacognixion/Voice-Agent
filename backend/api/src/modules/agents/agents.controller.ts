import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, Query } from '@nestjs/common';
import {
  type AgentDetail,
  type AgentSummary,
  type AgentVersionDetail,
  type AgentVersionSummary,
  type Page,
  type PublishResponse,
  type TemplateSummary,
  agentDraftPatch,
  agentsQuery,
  createAgentRequest,
  promptUpdate,
  publishRequest,
  selectVersionRequest,
  uuid,
} from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { Ctx, Roles } from '../auth';
import type { WorkspaceContext } from '../auth';
import { AgentPublishService } from './agent-publish.service';
import { AgentsService } from './agents.service';
import { TemplatesService } from './templates.service';

/**
 * D3 Agents and the W1–W3 wizard steps (§16).
 *
 * The §6.1 role matrix, applied per route rather than per controller:
 *   create / edit / publish / test   owner, admin, editor
 *   pause / delete                   owner, admin        (D3: "Delete — Owner/Admin")
 *   read                             every role, viewer included
 *
 * Every route is workspace-scoped by the global guards, and every service method takes the
 * `ctx` they produced. There is no route here that accepts a workspace id in the body or
 * the path: the only workspace any of this can touch is `X-Workspace-Id`'s, and the
 * membership behind it was checked before the handler ran.
 */
@Controller('agents')
export class AgentsController {
  constructor(
    private readonly agents: AgentsService,
    private readonly publishing: AgentPublishService,
  ) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query() query: Record<string, unknown>): Promise<Page<AgentSummary>> {
    return this.agents.list(ctx, agentsQuery.parse(query));
  }

  /** W1 Continue — creates the agent and its v1 draft from a template (§9.2). */
  @Post()
  @Roles('owner', 'admin', 'editor')
  create(@Ctx() ctx: WorkspaceContext, @Body() body: unknown): Promise<AgentDetail> {
    return this.agents.create(ctx, createAgentRequest.parse(body));
  }

  @Get(':id')
  get(@Ctx() ctx: WorkspaceContext, @Param('id') id: string): Promise<AgentDetail> {
    return this.agents.get(ctx, agentId(id));
  }

  /** W2/W3 autosave and the D3 Brief/Voice tabs. No LLM call (spec p. 19). */
  @Patch(':id/draft')
  @Roles('owner', 'admin', 'editor')
  patchDraft(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Body() body: unknown): Promise<AgentDetail> {
    return this.agents.patchDraft(ctx, agentId(id), agentDraftPatch.parse(body));
  }

  /** §13.5 Undo, and "Restore as draft" in the D3 Versions tab. A pointer move. */
  @Post(':id/draft/select')
  @Roles('owner', 'admin', 'editor')
  selectDraft(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Body() body: unknown): Promise<AgentDetail> {
    return this.agents.selectDraft(ctx, agentId(id), selectVersionRequest.parse(body).version_no);
  }

  @Get(':id/versions')
  versions(@Ctx() ctx: WorkspaceContext, @Param('id') id: string): Promise<AgentVersionSummary[]> {
    return this.agents.listVersions(ctx, agentId(id));
  }

  @Get(':id/versions/:v')
  version(
    @Ctx() ctx: WorkspaceContext,
    @Param('id') id: string,
    @Param('v', ParseIntPipe) versionNo: number,
  ): Promise<AgentVersionDetail> {
    return this.agents.getVersion(ctx, agentId(id), versionNo);
  }

  /**
   * The Advanced editor's "Save as new version" (§9.1). The body it takes is the prompt
   * *without* the platform rules; they are re-appended server-side and cannot be edited
   * through this or any other route (§9.4).
   */
  @Put(':id/versions/:v/prompt')
  @Roles('owner', 'admin', 'editor')
  savePrompt(
    @Ctx() ctx: WorkspaceContext,
    @Param('id') id: string,
    @Param('v', ParseIntPipe) versionNo: number,
    @Body() body: unknown,
  ): Promise<AgentVersionDetail> {
    return this.agents.saveManualPrompt(ctx, agentId(id), versionNo, promptUpdate.parse(body));
  }

  /** §13.6. Synchronous: it ends with the agent live, or with nothing changed. */
  @Post(':id/publish')
  @Roles('owner', 'admin', 'editor')
  publish(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Body() body: unknown): Promise<PublishResponse> {
    return this.publishing.publish(ctx, agentId(id), publishRequest.parse(body ?? {}).version_no);
  }

  @Post(':id/pause')
  @Roles('owner', 'admin')
  pause(@Ctx() ctx: WorkspaceContext, @Param('id') id: string): Promise<AgentDetail> {
    return this.publishing.pause(ctx, agentId(id));
  }

  @Post(':id/resume')
  @Roles('owner', 'admin')
  resume(@Ctx() ctx: WorkspaceContext, @Param('id') id: string): Promise<AgentDetail> {
    return this.publishing.resume(ctx, agentId(id));
  }

  @Delete(':id')
  @Roles('owner', 'admin')
  remove(@Ctx() ctx: WorkspaceContext, @Param('id') id: string): Promise<{ deleted: boolean }> {
    return this.publishing.remove(ctx, agentId(id));
  }
}

/** W1's template picker (§9.2). Read-only and the same for every workspace. */
@Controller('templates')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  list(): Promise<TemplateSummary[]> {
    return this.templates.list();
  }
}

/**
 * A path parameter reaches Postgres as a uuid cast, and a malformed one would be a 500
 * there. Rejecting it here makes it a 404 — the same answer another workspace's agent
 * gets, so neither can be used to probe for the other.
 */
function agentId(value: string): string {
  const parsed = uuid.safeParse(value);
  if (!parsed.success) throw AppError.notFound('Agent');
  return parsed.data;
}
