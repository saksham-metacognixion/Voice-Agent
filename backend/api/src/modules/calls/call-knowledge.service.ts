import { Injectable, Logger } from '@nestjs/common';
import { Prisma, adminDb } from '@portal/db';
import { EventsService } from '../events';
import { RetellGateway } from '../retell';
import { type KbSourceRef, type StoredKbUsage, parseStoredUsage, summariseRetrievals } from './kb-usage';

export type CallKnowledgeOutcome =
  | { outcome: 'none'; callId: string }
  | { outcome: 'count_only'; callId: string; lookups: number | null }
  | { outcome: 'complete'; callId: string; lookups: number; hits: number };

/**
 * D16 `call-knowledge` (queue `calls`, `jobId = kb-<call_id>`): records what the agent
 * looked up during one call. Queued by `call_ended` / `call_analyzed` when the payload
 * says the call consulted a knowledge base; never on the money path, and never able to
 * fail it — this job owns no credits.
 *
 * The signed file URL is read back from the stored webhook rather than carried in the
 * job: it opens a copy of the customer's business documents for a day, and a job payload
 * sits in Redis. The count is written first, so a file the CDN will not serve still
 * leaves "looked it up N times"; a later read that gets the file upgrades it to the full
 * per-source picture, and nothing ever downgrades a complete row.
 */
@Injectable()
export class CallKnowledgeService {
  private readonly log = new Logger(CallKnowledgeService.name);

  constructor(
    private readonly retell: RetellGateway,
    private readonly events: EventsService,
  ) {}

  async record(callId: string): Promise<CallKnowledgeOutcome> {
    const row = await adminDb.call.findUnique({ where: { id: callId }, select: { id: true, tenantId: true, agentId: true, kbRetrievals: true, kbHits: true, kbUsageJson: true } });
    if (!row) return { outcome: 'none', callId };

    const { lookups, url } = await this.knowledgeFacts(callId);
    if (lookups === null && !url) return { outcome: 'none', callId };

    const stored = parseStoredUsage(row.kbUsageJson);
    const complete = row.kbRetrievals !== null && stored.detail === 'complete';
    if (complete) return { outcome: 'complete', callId, lookups: row.kbRetrievals!, hits: row.kbHits ?? 0 };

    if (lookups === 0) {
      // The platform counted the look-ups and there were none: that is a complete answer.
      await this.write(callId, 0, 0, { detail: 'complete', sources: [] });
      return { outcome: 'complete', callId, lookups: 0, hits: 0 };
    }
    if (lookups !== null) await this.write(callId, lookups, null, { detail: 'count_only', sources: [] });
    if (!url) return { outcome: 'count_only', callId, lookups };

    // Throws on a network or CDN failure: the job retries, and the count above stands if
    // every attempt fails.
    const file = await this.retell.fetchKnowledgeRetrievals(url);
    const sources: KbSourceRef[] = row.agentId
      ? await adminDb.knowledgeSource.findMany({ where: { agentId: row.agentId, tenantId: row.tenantId }, select: { id: true, type: true } })
      : [];
    const summary = summariseRetrievals(file, sources);
    if (!summary) {
      this.log.warn(`call-knowledge ${callId}: the retrieval file is not in a shape we know; keeping the count`);
      return { outcome: 'count_only', callId, lookups };
    }
    await this.write(callId, summary.lookups, summary.hits, { detail: 'complete', sources: summary.sources });
    await this.events
      .publish(row.tenantId, `call:${callId}`, 'knowledge', { call_id: callId, lookups: summary.lookups, hits: summary.hits })
      .catch(() => null);
    return { outcome: 'complete', callId, lookups: summary.lookups, hits: summary.hits };
  }

  /**
   * The look-up count and the file link from the call's stored lifecycle events — the
   * largest count any of them reported, and the newest link (a later `get-call` from
   * call-recovery carries a fresh signature).
   */
  private async knowledgeFacts(callId: string): Promise<{ lookups: number | null; url: string | null }> {
    const rows = await adminDb.webhookEvent.findMany({
      where: { provider: 'retell', externalId: callId, eventType: { in: ['call_ended', 'call_analyzed'] } },
      orderBy: { receivedAt: 'desc' },
      select: { payloadJson: true },
    });
    let lookups: number | null = null;
    let url: string | null = null;
    for (const r of rows) {
      const facts = knowledgeFactsOf(r.payloadJson);
      if (facts.lookups !== null) lookups = Math.max(lookups ?? 0, facts.lookups);
      url ??= facts.url;
    }
    return { lookups, url };
  }

  private write(callId: string, lookups: number, hits: number | null, usage: StoredKbUsage) {
    return adminDb.call.update({
      where: { id: callId },
      data: { kbRetrievals: lookups, kbHits: hits, kbUsageJson: usage as unknown as Prisma.InputJsonValue },
    });
  }
}

/** `latency.knowledge_base.num` and `knowledge_base_retrieved_contents_url` from one stored payload. */
export function knowledgeFactsOf(payload: unknown): { lookups: number | null; url: string | null } {
  const call = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>).call : null;
  if (typeof call !== 'object' || call === null) return { lookups: null, url: null };
  const record = call as Record<string, unknown>;
  const latency = record.latency as Record<string, unknown> | null | undefined;
  const kb = latency && typeof latency === 'object' ? (latency.knowledge_base as Record<string, unknown> | null | undefined) : null;
  const num = kb && typeof kb === 'object' ? kb.num : null;
  const url = record.knowledge_base_retrieved_contents_url;
  return {
    lookups: typeof num === 'number' && Number.isInteger(num) && num >= 0 ? num : null,
    url: typeof url === 'string' && url.startsWith('https://') ? url : null,
  };
}

/** True when a lifecycle payload says the call consulted a knowledge base. */
export function usedKnowledge(call: { latency?: unknown; knowledge_base_retrieved_contents_url?: string | null }): boolean {
  const facts = knowledgeFactsOf({ call });
  return facts.lookups !== null || facts.url !== null;
}
