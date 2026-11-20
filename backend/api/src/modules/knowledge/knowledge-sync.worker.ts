import { Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { Prisma, adminDb } from '@portal/db';
import { AgentPublishService } from '../agents';
import { JobQueues, type KnowledgeSyncJob } from '../jobs';
import { RedisCache } from '../redis';
import { RetellGateway, isRetellNotFound, retellErrorStatus, type KnowledgeBaseFacts, type KnowledgeSourcesInput } from '../retell';

/** How long one run waits for the platform to finish ingesting before handing off to a delayed poll. */
const INLINE_POLL_MS = 45_000;
const POLL_INTERVAL_MS = 3_000;
/** Delayed re-enqueues after the inline window; ~12 s is normal (ADR 0003 §8), so ten is generous. */
const MAX_POLLS = 10;
const POLL_DELAY_MS = 20_000;
/** The per-agent KB creation lock: long enough for one create round trip, short enough to self-heal. */
const KB_LOCK_TTL_S = 120;
/**
 * A delete of the last synced source waits for a sibling that is still being read (a
 * replace: "remove the old menu, upload the new one"), so the newcomer lands in the
 * existing knowledge base and only the old source is removed. Bounded: after this many
 * deferrals the base goes regardless — the sibling has failed, or is stuck, and will
 * create its own base when it finally syncs.
 */
const DELETE_DEFER_MS = 5_000;
const MAX_DELETE_DEFERRALS = 24;

/** One sentence the customer may read. Nothing here comes from a provider message. */
export const KNOWLEDGE_REASONS = {
  unreadable: 'We could not read this source. Check it opens in a browser and try again.',
  too_slow: 'Reading this source took too long. Remove it and add it again.',
  unavailable: 'Something went wrong while reading this source. Try again in a moment.',
  agent_gone: 'This agent no longer exists.',
} as const;

/**
 * The worker half of W4 (§13.1 `knowledge`, ADR 0003 §8):
 *
 *     load row → ensure the agent's knowledge base → add this source → poll to `complete`
 *       → ready (payload dropped)         | error → failed
 *     load row (deleting) → delete the platform source → delete the row
 *
 * Retry-safe by identity, not by luck. The platform has no idempotency key for
 * `add-sources`, so each step persists what it learned before the next round trip and
 * every retry first *looks* before it *adds*: the KB by its deterministic name, the
 * source by the id we embed in its title or filename (or, for a URL, the URL itself).
 * A job that dies after the platform accepted the source and before we stored its id
 * therefore adopts it on the next run rather than uploading a second copy.
 *
 * The one thing two concurrent syncs for one agent could still do is create two
 * knowledge bases; a short Redis lock per agent around the create makes the loser wait
 * for a retry, by which time `agents.retell_kb_id` is set.
 *
 * Knowledge is added after payment (ADR 0024), so the agent is usually live already
 * when its base is created. The platform versions the LLM with the agent, so a live
 * agent does not see a base attached after its publish: the sync that attaches one to a
 * published agent marks itself `republish` and, once the source is ready, republishes
 * the live version. The mark survives a failed republish, and a `ready` row still
 * carrying it is republished by the retry.
 */
@Injectable()
export class KnowledgeSyncWorker {
  private readonly log = new Logger(KnowledgeSyncWorker.name);

  constructor(
    private readonly retell: RetellGateway,
    private readonly cache: RedisCache,
    private readonly queues: JobQueues,
    private readonly publishing: AgentPublishService,
  ) {}

  async run(job: Job<KnowledgeSyncJob>): Promise<{ outcome: string; reason?: string }> {
    const { sourceId } = job.data;
    const attemptsLeft = Math.max(0, (job.opts.attempts ?? 1) - job.attemptsMade - 1);

    const row = await adminDb.knowledgeSource.findUnique({
      where: { id: sourceId },
      include: { agent: { select: AGENT_SELECT }, tenant: { select: { name: true } } },
    });
    if (!row) return { outcome: 'ignored', reason: 'source no longer exists' };
    if (row.tenantId !== job.data.workspaceId) return { outcome: 'ignored', reason: 'workspace mismatch' };

    if (row.status === 'deleting') return this.delete(row, job.data);
    if (row.status === 'ready' && republishPending(row.syncJson)) {
      await this.republish(row);
      return { outcome: 'ready' };
    }
    if (row.status !== 'pending' && row.status !== 'syncing') return { outcome: 'ignored', reason: `status is ${row.status}` };
    if (row.agent.deletedAt) {
      await this.fail(row.id, 'agent_gone', KNOWLEDGE_REASONS.agent_gone, 'agent was deleted');
      return { outcome: 'failed', reason: 'agent deleted' };
    }

    await adminDb.knowledgeSource.updateMany({
      where: { id: row.id, status: { in: ['pending', 'syncing'] } },
      data: { status: 'syncing', syncJson: merge(row.syncJson, { attempt: job.attemptsMade + 1, started_at: new Date().toISOString() }) },
    });

    let kbId: string | null = null;
    let ready = false;
    try {
      const kb = await this.ensureKnowledgeBase(row, job.id ?? sourceId);
      kbId = kb.kbId;
      if (kb.attached && row.agent.publishedVersion !== null) {
        const current = await adminDb.knowledgeSource.findUnique({ where: { id: row.id }, select: { syncJson: true } });
        row.syncJson = merge(current?.syncJson, { republish: true }) as Prisma.JsonValue;
        await adminDb.knowledgeSource.update({ where: { id: row.id }, data: { syncJson: row.syncJson as Prisma.InputJsonValue } });
      }
      const retellSourceId = row.retellSourceId ?? (await this.ensureSource(row, kbId));
      const status = await this.pollUntilSettled(kbId);

      if (status === 'complete') {
        await this.markReady(row.id, kbId, retellSourceId);
        this.log.log(`knowledge ${row.id} (${row.type}) ready in KB ${kbId} for agent ${row.agentId}`);
        ready = true;
      } else if (status === 'error') {
        await this.fail(row.id, 'platform_error', KNOWLEDGE_REASONS.unreadable, 'knowledge base reported error after ingest');
        return { outcome: 'failed', reason: 'ingest error' };
      } else {
        // Still ingesting after the inline window: hand off to a delayed poll rather than
        // hold a worker slot. The row stays `syncing`, which is what the customer sees.
        const poll = (job.data.poll ?? 0) + 1;
        if (poll > MAX_POLLS) {
          await this.fail(row.id, 'timeout', KNOWLEDGE_REASONS.too_slow, `still ${status} after ${MAX_POLLS} polls`);
          return { outcome: 'failed', reason: 'ingest timeout' };
        }
        await adminDb.knowledgeSource.update({ where: { id: row.id }, data: { syncJson: merge(row.syncJson, { polls: poll, platform_status: status }) } });
        const queued = await this.queues.enqueueKnowledgeSync({ ...job.data, poll }, { delayMs: POLL_DELAY_MS });
        if (queued === 'failed') throw new Error('could not queue the ingest poll');
        return { outcome: 'polling', reason: status };
      }
    } catch (error) {
      const status = retellErrorStatus(error);
      const detail = describe(error);
      // The base vanished under this sync: a delete of the previous last source took it
      // (the menu's replace flow, DELETE then POST in the same second — 25 Sep 2026). A
      // 404 here is not "this source cannot be read"; forget the base and try again, and
      // the retry creates a fresh one through the usual look-before-you-buy path.
      if (kbId && isRetellNotFound(error) && attemptsLeft > 0) {
        await adminDb.agent.updateMany({ where: { id: row.agentId, retellKbId: kbId }, data: { retellKbId: null } });
        await adminDb.knowledgeSource
          .update({ where: { id: row.id }, data: { retellSourceId: null, syncJson: merge(row.syncJson, { last_error: `knowledge base ${kbId} vanished mid-sync; retrying`, attempts_left: attemptsLeft }) } })
          .catch(() => undefined);
        this.log.warn(`knowledge ${row.id}: knowledge base ${kbId} vanished mid-sync (${detail}); retrying with a fresh one`);
        throw error;
      }
      const permanent = status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
      if (permanent || attemptsLeft === 0) {
        await this.fail(row.id, permanent ? 'rejected' : 'exhausted', permanent ? KNOWLEDGE_REASONS.unreadable : KNOWLEDGE_REASONS.unavailable, detail);
        this.log.error(`knowledge ${row.id}: sync failed for good (${detail})`);
        return { outcome: 'failed', reason: detail };
      }
      await adminDb.knowledgeSource
        .update({ where: { id: row.id }, data: { syncJson: merge(row.syncJson, { last_error: detail.slice(0, 300), attempts_left: attemptsLeft }) } })
        .catch(() => undefined);
      this.log.warn(`knowledge ${row.id}: sync attempt failed (${detail}); retrying`);
      throw error;
    }

    // Outside the try: a failed republish is not a failed read. The source stays `ready`
    // with its `republish` mark, and the thrown error is the job's retry.
    if (ready && republishPending(row.syncJson)) await this.republish(row);
    return { outcome: 'ready' };
  }

  // ------------------------------------------------------------------ steps

  /**
   * One KB per agent, named after the agent id so a lost create is found again.
   * `attached` is true when this call is the one that put the base on the agent.
   */
  private async ensureKnowledgeBase(row: SourceRow, lockToken: string): Promise<{ kbId: string; attached: boolean }> {
    if (row.agent.retellKbId) return { kbId: row.agent.retellKbId, attached: false };

    const lockKey = `kblock:{${row.agentId}}`;
    const locked = await this.cache.setIfAbsent(lockKey, lockToken, KB_LOCK_TTL_S);
    if (!locked) throw new Error(`another sync is creating the knowledge base for agent ${row.agentId}`);
    try {
      // Re-read under the lock: the other sync may have finished between our load and now.
      const fresh = await adminDb.agent.findUnique({ where: { id: row.agentId }, select: { retellKbId: true } });
      if (fresh?.retellKbId) return { kbId: fresh.retellKbId, attached: false };

      const name = kbName(row.agentId);
      const existing = await this.retell.findKnowledgeBaseByName(name);
      const kb = existing ?? (await this.retell.createKnowledgeBase({ name, autoRefresh: true, ...(await this.sourceInput(row)) }));
      await adminDb.agent.update({ where: { id: row.agentId }, data: { retellKbId: kb.knowledge_base_id } });
      this.log.log(`agent ${row.agentId}: ${existing ? 'adopted' : 'created'} knowledge base ${kb.knowledge_base_id}`);

      if (!existing) {
        // The create carried this source; record its id now so the add step is skipped.
        const found = findSource(kb, row);
        if (found) await adminDb.knowledgeSource.update({ where: { id: row.id }, data: { retellSourceId: found } });
      }
      return { kbId: kb.knowledge_base_id, attached: true };
    } finally {
      await this.cache.del(lockKey);
    }
  }

  /** Look first, then add — and persist the id before anything else happens. */
  private async ensureSource(row: SourceRow, kbId: string): Promise<string> {
    const stored = await adminDb.knowledgeSource.findUnique({ where: { id: row.id }, select: { retellSourceId: true } });
    if (stored?.retellSourceId) return stored.retellSourceId;

    const current = await this.retell.getKnowledgeBase(kbId);
    let sourceId = findSource(current, row);
    if (!sourceId) {
      const after = await this.retell.addKnowledgeSources(kbId, await this.sourceInput(row));
      sourceId = findSource(after, row);
      if (!sourceId) {
        // Accepted but not listed under the name we gave it: re-read once before giving up.
        sourceId = findSource(await this.retell.getKnowledgeBase(kbId), row);
      }
      if (!sourceId) throw new Error(`knowledge base ${kbId} accepted the source but did not list it`);
    }
    await adminDb.knowledgeSource.update({ where: { id: row.id }, data: { retellSourceId: sourceId } });
    return sourceId;
  }

  private async pollUntilSettled(kbId: string): Promise<KnowledgeBaseFacts['status']> {
    const deadline = Date.now() + INLINE_POLL_MS;
    let status = (await this.retell.getKnowledgeBase(kbId)).status;
    while ((status === 'in_progress' || status === 'refreshing_in_progress') && Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      status = (await this.retell.getKnowledgeBase(kbId)).status;
    }
    return status;
  }

  private async delete(row: SourceRow, data: KnowledgeSyncJob): Promise<{ outcome: string; reason?: string }> {
    const kbId = row.agent.retellKbId;
    if (row.retellSourceId && kbId) {
      // The platform refuses to empty a knowledge base ("400 cannot delete the last
      // source, delete the knowledge base instead" — found by the D9 wizard run), so the
      // last synced source takes the base with it; the next add creates a fresh one
      // through the usual look-before-you-buy path.
      const others = await adminDb.knowledgeSource.count({ where: { agentId: row.agentId, id: { not: row.id }, retellSourceId: { not: null }, status: { not: 'deleting' } } });
      if (others === 0) {
        // …unless a sibling is on its way (the menu's replace flow: DELETE then POST in the
        // same second). Deleting the base now would race that sibling's sync — it finds
        // the base by name, adds to it, and the base vanishes under it, leaving the new
        // source `failed` on the real platform (25 Sep 2026). Wait for it instead.
        const arriving = await adminDb.knowledgeSource.count({ where: { agentId: row.agentId, id: { not: row.id }, status: { in: ['pending', 'syncing'] } } });
        const deferrals = data.poll ?? 0;
        if (arriving > 0 && deferrals < MAX_DELETE_DEFERRALS) {
          const queued = await this.queues.enqueueKnowledgeSync({ ...data, purpose: 'delete', poll: deferrals + 1 }, { delayMs: DELETE_DEFER_MS });
          if (queued === 'failed') throw new Error('could not queue the deferred delete');
          this.log.log(`knowledge ${row.id}: last synced source, ${arriving} sibling(s) still being read; deleting again in ${DELETE_DEFER_MS / 1000} s (${deferrals + 1}/${MAX_DELETE_DEFERRALS})`);
          return { outcome: 'deferred', reason: 'sibling syncing' };
        }
      }
      try {
        if (others === 0) {
          await this.retell.deleteKnowledgeBase(kbId);
          await adminDb.agent.updateMany({ where: { id: row.agentId, retellKbId: kbId }, data: { retellKbId: null } });
          this.log.log(`knowledge ${row.id} was the last source; KB ${kbId} deleted`);
        } else {
          await this.retell.deleteKnowledgeSource(kbId, row.retellSourceId);
        }
      } catch (error) {
        if (!isRetellNotFound(error)) throw error; // retried by BullMQ; the row stays `deleting`
        if (others === 0) await adminDb.agent.updateMany({ where: { id: row.agentId, retellKbId: kbId }, data: { retellKbId: null } });
      }
    }
    await adminDb.knowledgeSource.deleteMany({ where: { id: row.id, status: 'deleting' } });
    this.log.log(`knowledge ${row.id} removed from KB ${row.agent.retellKbId ?? '-'} and deleted`);
    return { outcome: 'deleted' };
  }

  /**
   * Put the agent's knowledge base on the phone: republish the live version (a new
   * platform version of the same one of ours). A throw leaves the `republish` mark, and
   * the job's retry lands in the `ready` branch of `run()`.
   */
  private async republish(row: SourceRow): Promise<void> {
    const agent = await adminDb.agent.findUnique({ where: { id: row.agentId }, select: { publishedVersion: true, deletedAt: true } });
    if (agent?.publishedVersion != null && !agent.deletedAt) {
      const userId = await this.actorFor(row);
      const result = await this.publishing.publish({ userId, workspaceId: row.tenantId, role: 'owner' }, row.agentId, agent.publishedVersion, { refresh: true });
      this.log.log(`agent ${row.agentId}: republished v${result.version_no} so the live agent reads its knowledge base`);
    }
    const current = await adminDb.knowledgeSource.findUnique({ where: { id: row.id }, select: { syncJson: true } });
    await adminDb.knowledgeSource.update({ where: { id: row.id }, data: { syncJson: merge(current?.syncJson, { republish: false, republished_at: new Date().toISOString() }) } });
  }

  /** The audit row's actor: whoever added the source, else the workspace owner. */
  private async actorFor(row: SourceRow): Promise<string> {
    const requested = (row.syncJson as { requested_by?: unknown } | null)?.requested_by;
    if (typeof requested === 'string' && requested) {
      const member = await adminDb.membership.findFirst({ where: { tenantId: row.tenantId, userId: requested }, select: { userId: true } });
      if (member) return member.userId;
    }
    const owner = await adminDb.membership.findFirstOrThrow({ where: { tenantId: row.tenantId, role: 'owner' }, select: { userId: true } });
    return owner.userId;
  }

  private async markReady(rowId: string, kbId: string, retellSourceId: string): Promise<void> {
    const row = await adminDb.knowledgeSource.findUnique({ where: { id: rowId }, select: { syncJson: true, sizeBytes: true, payload: true } });
    await adminDb.knowledgeSource.updateMany({
      where: { id: rowId, status: 'syncing' },
      data: {
        status: 'ready',
        retellSourceId,
        error: null,
        payload: null,
        sizeBytes: row?.sizeBytes ?? row?.payload?.length ?? null,
        syncedAt: new Date(),
        syncJson: merge(row?.syncJson, { kb_id: kbId, completed_at: new Date().toISOString() }),
      },
    });
  }

  private async fail(rowId: string, kind: string, customerReason: string, detail: string): Promise<void> {
    const row = await adminDb.knowledgeSource.findUnique({ where: { id: rowId }, select: { syncJson: true } });
    await adminDb.knowledgeSource.updateMany({
      where: { id: rowId, status: { in: ['pending', 'syncing'] } },
      data: {
        status: 'failed',
        error: customerReason,
        payload: null,
        syncJson: merge(row?.syncJson, { error_kind: kind, error_detail: detail.slice(0, 500), failed_at: new Date().toISOString() }),
      },
    });
  }

  private async sourceInput(row: SourceRow): Promise<KnowledgeSourcesInput> {
    switch (row.type) {
      case 'url':
        return { urls: [row.url!] };
      case 'text':
        return { texts: [{ title: sourceTitle(row), text: (row.payload ?? Buffer.alloc(0)).toString('utf8') }] };
      case 'file':
        return { files: [{ bytes: Buffer.from(row.payload ?? Buffer.alloc(0)), filename: sourceFilename(row), contentType: row.contentType ?? 'application/octet-stream' }] };
    }
  }
}

const AGENT_SELECT = { id: true, name: true, retellKbId: true, deletedAt: true, publishedVersion: true } as const;

type SourceRow = Prisma.KnowledgeSourceGetPayload<{
  include: { agent: { select: typeof AGENT_SELECT }; tenant: { select: { name: true } } };
}>;

function republishPending(syncJson: unknown): boolean {
  return Boolean(syncJson && typeof syncJson === 'object' && (syncJson as { republish?: unknown }).republish === true);
}

/**
 * Deterministic per agent: the retry's lookup key. The gateway adds the environment prefix.
 * Retell caps a knowledge base name at 40 characters (`400 knowledge base name too long`,
 * found on the D6 real run), so the id is its first 20 hex digits — 80 bits, unique for our
 * purposes, and `dev-kb-…` stays at 27.
 */
export function kbName(agentId: string): string {
  return `kb-${agentId.replace(/-/g, '').slice(0, 20)}`;
}

/** The row id rides in the title so the source can be found again after a lost write. */
export function sourceTitle(row: { id: string; name: string }): string {
  return `${row.name.slice(0, 80)} [${row.id.slice(0, 8)}]`;
}

const EXTENSIONS: Record<string, string> = {
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

export function sourceFilename(row: { id: string; name: string; contentType: string | null }): string {
  const base = row.name.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'file';
  const ext = EXTENSIONS[row.contentType ?? ''] ?? 'bin';
  return `${row.id.slice(0, 8)}-${base}.${ext}`;
}

/** Finds our source in a KB listing by the identity we gave it. Null when absent. */
export function findSource(kb: KnowledgeBaseFacts, row: { id: string; name: string; type: string; url: string | null; contentType: string | null }): string | null {
  for (const source of kb.knowledge_base_sources ?? []) {
    if (row.type === 'url' && source.type === 'url' && sameUrl(source.url, row.url)) return source.source_id;
    if (row.type === 'text' && source.type === 'text' && source.title === sourceTitle(row)) return source.source_id;
    if (row.type === 'file' && source.type === 'document' && source.filename === sourceFilename(row)) return source.source_id;
  }
  return null;
}

function sameUrl(a: string | undefined, b: string | null): boolean {
  if (!a || !b) return false;
  const norm = (u: string) => u.trim().replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

function merge(current: unknown, patch: Record<string, unknown>): Prisma.InputJsonValue {
  const base = current && typeof current === 'object' ? (current as Record<string, unknown>) : {};
  return { ...base, ...patch } as Prisma.InputJsonValue;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
