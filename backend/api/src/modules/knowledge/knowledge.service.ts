import { Injectable, Logger } from '@nestjs/common';
import { Prisma, adminDb, withWorkspace, type WorkspaceDb } from '@portal/db';
import {
  KNOWLEDGE_MAX_FILE_BYTES,
  KNOWLEDGE_MAX_SOURCES_PER_AGENT,
  type CreateKnowledgeSourceRequest,
  type KnowledgeSourceResponse,
} from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import type { WorkspaceContext } from '../auth';
import { PlatformConfigService } from '../config';
import { JobQueues } from '../jobs';

/** Hosts a URL source may never point at: the platform fetches the page from its own network. */
const PRIVATE_HOST_RE = /^(localhost|.*\.local|.*\.internal|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?|\[?fe80:.*|\[?fc00:.*|\[?fd[0-9a-f]{2}:.*)$/i;

/** What the customer reads when a sync could not start or has failed for good. */
export const KNOWLEDGE_NOT_QUEUED = 'We could not start reading this source. Try again in a moment.';

/**
 * W4 "what your agent knows" — the request half (§13.1 `knowledge`, §16).
 *
 *     POST → validate → gates and quotas → row (pending, payload) → enqueue knowledge-sync → 202
 *
 * Nothing here talks to the voice platform: a KB ingest is a dozen seconds of polling
 * (ADR 0003 §8) and belongs to the worker. The route's job is to refuse early — a plan
 * without the gate, an agent over its source limit, a private URL — and to make the row
 * the durable record the worker resumes from.
 *
 * Reads run inside `withWorkspace(ctx)`; the enqueue happens after the transaction has
 * closed. Every row carries `tenant_id`, so RLS is the second guard on every read.
 */
@Injectable()
export class KnowledgeService {
  private readonly log = new Logger(KnowledgeService.name);

  constructor(
    private readonly config: PlatformConfigService,
    private readonly queues: JobQueues,
  ) {}

  async create(ctx: WorkspaceContext, agentId: string, input: CreateKnowledgeSourceRequest): Promise<KnowledgeSourceResponse> {
    const decoded = decodeSource(input);
    const [flags, caps] = await Promise.all([this.config.flagsFor(ctx.workspaceId), this.config.capsFor(ctx.workspaceId)]);
    if (!flags.gates.knowledge_base) {
      throw new AppError('PLAN_LIMIT', 'Your plan does not include knowledge sources yet. Buy a pack that does to unlock them.');
    }

    const row = await withWorkspace(ctx, async (db) => {
      const agent = await this.loadAgent(db, ctx, agentId);
      if (agent.deletedAt) throw AppError.notFound('Agent');

      const [forAgent, agentsWithKnowledge] = await Promise.all([
        db.knowledgeSource.count({ where: { agentId, tenantId: ctx.workspaceId, status: { not: 'deleting' } } }),
        db.knowledgeSource.groupBy({ by: ['agentId'], where: { tenantId: ctx.workspaceId, status: { not: 'deleting' } } }),
      ]);
      if (forAgent >= KNOWLEDGE_MAX_SOURCES_PER_AGENT) {
        throw new AppError('PLAN_LIMIT', `An agent can know up to ${KNOWLEDGE_MAX_SOURCES_PER_AGENT} sources. Remove one to add another.`);
      }
      // §5.2: the allowance is knowledge *bases*, and there is one per agent (ADR 0003 §8).
      if (forAgent === 0 && agentsWithKnowledge.length >= caps.kb_allowance) {
        throw new AppError(
          'PLAN_LIMIT',
          caps.kb_allowance === 0
            ? 'Your plan does not include knowledge sources yet.'
            : `Your plan includes knowledge for ${caps.kb_allowance} agent${caps.kb_allowance === 1 ? '' : 's'}. Upgrade to add it to another.`,
        );
      }

      const created = await db.knowledgeSource.create({
        data: {
          tenantId: ctx.workspaceId,
          agentId,
          type: input.type,
          name: decoded.name,
          url: decoded.url,
          contentType: decoded.contentType,
          payload: decoded.payload ? new Uint8Array(decoded.payload) : null,
          sizeBytes: decoded.sizeBytes,
          status: 'pending',
          syncJson: { requested_by: ctx.userId, requested_at: new Date().toISOString() } as Prisma.InputJsonValue,
        },
      });
      await this.audit(db, ctx, 'knowledge.added', created.id, { agent_id: agentId, type: input.type, name: decoded.name, size_bytes: decoded.sizeBytes });
      return created;
    });

    const queued = await this.queues.enqueueKnowledgeSync({ sourceId: row.id, workspaceId: ctx.workspaceId, agentId });
    if (queued === 'failed') {
      await adminDb.knowledgeSource
        .update({ where: { id: row.id }, data: { status: 'failed', error: KNOWLEDGE_NOT_QUEUED, syncJson: { ...(row.syncJson as object), queued: false } } })
        .catch(() => undefined);
      throw new AppError('UPSTREAM_UNAVAILABLE', KNOWLEDGE_NOT_QUEUED);
    }
    this.log.log(`knowledge ${row.id} (${input.type}) for agent ${agentId} queued (${queued})`);
    return toResponse(row);
  }

  async list(ctx: WorkspaceContext, agentId?: string): Promise<KnowledgeSourceResponse[]> {
    const rows = await withWorkspace(ctx, async (db) => {
      if (agentId) await this.loadAgent(db, ctx, agentId);
      return db.knowledgeSource.findMany({
        where: { tenantId: ctx.workspaceId, ...(agentId ? { agentId } : {}) },
        orderBy: { createdAt: 'asc' },
      });
    });
    return rows.map(toResponse);
  }

  async get(ctx: WorkspaceContext, sourceId: string): Promise<KnowledgeSourceResponse> {
    const row = await withWorkspace(ctx, (db) => db.knowledgeSource.findFirst({ where: { id: sourceId, tenantId: ctx.workspaceId } }));
    if (!row) throw AppError.notFound('Knowledge source');
    return toResponse(row);
  }

  /**
   * DELETE. A source the platform never received is removed outright; one it holds is
   * parked in `deleting` and the worker removes the platform copy first, then the row —
   * a row deleted ahead of the platform copy would leave the agent answering from
   * knowledge the customer believes is gone.
   */
  async remove(ctx: WorkspaceContext, sourceId: string, agentId?: string): Promise<{ deleted: boolean; pending: boolean }> {
    const outcome = await withWorkspace(ctx, async (db) => {
      const row = await db.knowledgeSource.findFirst({ where: { id: sourceId, tenantId: ctx.workspaceId, ...(agentId ? { agentId } : {}) } });
      if (!row) throw AppError.notFound('Knowledge source');
      if (row.status === 'deleting') return { deleted: false, pending: true, row };

      if (!row.retellSourceId) {
        await db.knowledgeSource.delete({ where: { id: row.id } });
        await this.audit(db, ctx, 'knowledge.removed', row.id, { agent_id: row.agentId, name: row.name, platform_copy: false });
        return { deleted: true, pending: false, row };
      }
      await db.knowledgeSource.update({ where: { id: row.id }, data: { status: 'deleting' } });
      await this.audit(db, ctx, 'knowledge.removal_requested', row.id, { agent_id: row.agentId, name: row.name });
      return { deleted: false, pending: true, row };
    });

    if (outcome.pending) {
      const queued = await this.queues.enqueueKnowledgeSync({ sourceId, workspaceId: ctx.workspaceId, agentId: outcome.row.agentId, purpose: 'delete' });
      if (queued === 'failed') this.log.error(`knowledge ${sourceId}: delete stored but not queued; the kb-sync schedule will retry`);
    }
    return { deleted: outcome.deleted, pending: outcome.pending };
  }

  private async loadAgent(db: WorkspaceDb, ctx: WorkspaceContext, agentId: string) {
    const agent = await db.agent.findFirst({ where: { id: agentId, tenantId: ctx.workspaceId, deletedAt: null }, select: { id: true, deletedAt: true } });
    if (!agent) throw AppError.notFound('Agent');
    return agent;
  }

  private async audit(db: WorkspaceDb, ctx: WorkspaceContext, action: string, targetId: string, meta: Record<string, unknown>): Promise<void> {
    await db.auditLog.create({
      data: { tenantId: ctx.workspaceId, actorUserId: ctx.userId, action, targetType: 'knowledge_source', targetId, metaJson: meta as Prisma.InputJsonValue },
    });
  }
}

interface DecodedSource {
  name: string;
  url: string | null;
  contentType: string | null;
  payload: Buffer | null;
  sizeBytes: number | null;
}

/** Validates what zod cannot: decoded file size, private hosts, and derives the display name. */
export function decodeSource(input: CreateKnowledgeSourceRequest): DecodedSource {
  switch (input.type) {
    case 'url': {
      const parsed = new URL(input.url);
      if (PRIVATE_HOST_RE.test(parsed.hostname) || !parsed.hostname.includes('.')) {
        throw new AppError('BAD_REQUEST', 'That address cannot be read from the internet.', [{ field: 'url', message: 'Public http(s) URL required' }]);
      }
      if (parsed.username || parsed.password) {
        throw new AppError('BAD_REQUEST', 'Remove the credentials from the URL.', [{ field: 'url', message: 'No credentials in URLs' }]);
      }
      return { name: input.name?.trim() || `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`.slice(0, 120), url: parsed.toString(), contentType: null, payload: null, sizeBytes: null };
    }
    case 'text': {
      const payload = Buffer.from(input.text, 'utf8');
      return { name: input.name, url: null, contentType: 'text/plain', payload, sizeBytes: payload.length };
    }
    case 'file': {
      const payload = Buffer.from(input.content_base64.replace(/\s+/g, ''), 'base64');
      if (payload.length === 0) throw new AppError('BAD_REQUEST', 'The file is empty.', [{ field: 'content_base64', message: 'Empty file' }]);
      if (payload.length > KNOWLEDGE_MAX_FILE_BYTES) {
        throw new AppError('BAD_REQUEST', `Files can be up to ${KNOWLEDGE_MAX_FILE_BYTES / (1024 * 1024)} MB.`, [{ field: 'content_base64', message: 'File too large' }]);
      }
      return { name: input.name, url: null, contentType: input.content_type, payload, sizeBytes: payload.length };
    }
  }
}

export function toResponse(row: {
  id: string;
  agentId: string;
  type: string;
  name: string;
  url: string | null;
  contentType: string | null;
  status: string;
  sizeBytes: number | null;
  error: string | null;
  syncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): KnowledgeSourceResponse {
  return {
    id: row.id,
    agent_id: row.agentId,
    type: row.type as KnowledgeSourceResponse['type'],
    name: row.name,
    url: row.url,
    content_type: row.contentType,
    status: row.status as KnowledgeSourceResponse['status'],
    size_bytes: row.sizeBytes,
    error: row.status === 'failed' ? row.error : null,
    synced_at: row.syncedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}
