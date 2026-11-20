import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { type KnowledgeSourceResponse, type KnowledgeStatsResponse, createKnowledgeRequest, createKnowledgeSourceRequest, knowledgeQuery, knowledgeStatsQuery, uuid } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { Ctx, Roles } from '../auth';
import type { WorkspaceContext } from '../auth';
import { KnowledgeService } from './knowledge.service';

/**
 * W4 / D3 Knowledge tab (§16): `POST /agents/:id/knowledge · GET /agents/:id/knowledge ·
 * DELETE /agents/:id/knowledge/:sourceId`. Writes need Editor or above; every role reads.
 *
 * POST answers 202: the row exists and the sync is queued; the source's own `status` is
 * the progress the client polls or watches (`agent:{id}` frames are not used here — a
 * source is its own resource).
 */
@Controller('agents/:id/knowledge')
export class AgentKnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Post()
  @HttpCode(202)
  @Roles('owner', 'admin', 'editor')
  create(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Body() body: unknown): Promise<KnowledgeSourceResponse> {
    return this.knowledge.create(ctx, idOf(id, 'Agent'), createKnowledgeSourceRequest.parse(body));
  }

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Param('id') id: string): Promise<KnowledgeSourceResponse[]> {
    return this.knowledge.list(ctx, idOf(id, 'Agent'));
  }

  /** D16: how often the agent used what it knows (every role reads). */
  @Get('stats')
  stats(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Query() query: Record<string, unknown>): Promise<KnowledgeStatsResponse> {
    return this.knowledge.stats(ctx, idOf(id, 'Agent'), knowledgeStatsQuery.parse(query).days);
  }

  @Delete(':sourceId')
  @Roles('owner', 'admin', 'editor')
  remove(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Param('sourceId') sourceId: string): Promise<{ deleted: boolean; pending: boolean }> {
    return this.knowledge.remove(ctx, idOf(sourceId, 'Knowledge source'), idOf(id, 'Agent'));
  }
}

/** The same resource addressed workspace-wide: `POST /knowledge {agent_id, …} · GET /knowledge[?agent_id=] · DELETE /knowledge/:id`. */
@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Post()
  @HttpCode(202)
  @Roles('owner', 'admin', 'editor')
  create(@Ctx() ctx: WorkspaceContext, @Body() body: unknown): Promise<KnowledgeSourceResponse> {
    const { agent_id, ...source } = createKnowledgeRequest.parse(body);
    return this.knowledge.create(ctx, agent_id, source);
  }

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query() query: Record<string, unknown>): Promise<KnowledgeSourceResponse[]> {
    return this.knowledge.list(ctx, knowledgeQuery.parse(query).agent_id);
  }

  @Get(':id')
  get(@Ctx() ctx: WorkspaceContext, @Param('id') id: string): Promise<KnowledgeSourceResponse> {
    return this.knowledge.get(ctx, idOf(id, 'Knowledge source'));
  }

  @Delete(':id')
  @Roles('owner', 'admin', 'editor')
  remove(@Ctx() ctx: WorkspaceContext, @Param('id') id: string): Promise<{ deleted: boolean; pending: boolean }> {
    return this.knowledge.remove(ctx, idOf(id, 'Knowledge source'));
  }
}

function idOf(value: string, what: string): string {
  const parsed = uuid.safeParse(value);
  if (!parsed.success) throw AppError.notFound(what);
  return parsed.data;
}
