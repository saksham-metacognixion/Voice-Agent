import { z } from 'zod';
import { isoDateTime, uuid } from './common.js';

/*
 * Knowledge sources (W4, §13.1 `knowledge`, §15 `knowledge_sources`).
 *
 * "What your agent knows" on the wire — never "knowledge base" (CLAUDE.md, Retell
 * isolation). One knowledge base per agent on the voice platform (ADR 0003 §8); the
 * customer only ever sees sources.
 */

export const knowledgeType = z.enum(['url', 'file', 'text']);
export type KnowledgeType = z.infer<typeof knowledgeType>;

/**
 * Lifecycle of one source. The API creates `pending`; the sync job moves it through
 * `syncing` to `ready` or `failed`; a delete parks it in `deleting` until the platform
 * has dropped it and the row is removed.
 */
export const knowledgeStatus = z.enum(['pending', 'syncing', 'ready', 'failed', 'deleting']);
export type KnowledgeStatus = z.infer<typeof knowledgeStatus>;

/**
 * What a source *is for*, beyond its bytes. A plain source has no role. `menu` is the
 * restaurant's menu: one per agent (replacing it deletes the previous one), shown in its
 * own section of W4 and the D3 Knowledge tab, and named in the generated prompt so the
 * agent answers dish, price and availability questions from it and says when something
 * is not on it. Only a restaurant agent (`template_id` or `industry` = `restaurant`)
 * may hold one.
 */
export const knowledgeRole = z.enum(['menu']);
export type KnowledgeRole = z.infer<typeof knowledgeRole>;

/** A restaurant agent: the Restaurant template, or any template tagged `restaurant` on W1. */
export function isRestaurantAgent(agent: { template_id: string | null; industry: string | null }): boolean {
  return agent.template_id === 'restaurant' || (agent.industry ?? '').trim().toLowerCase() === 'restaurant';
}

/**
 * The roles an agent may hold — what the API accepts and what the portal shows a section
 * for. One function so the two cannot disagree on which agent gets a Menu section.
 */
export function knowledgeRolesFor(agent: { template_id: string | null; industry: string | null }): KnowledgeRole[] {
  return isRestaurantAgent(agent) ? ['menu'] : [];
}

/** ADR 0003 §8: files ≤ 20 MB, ≤ 20 sources per agent, URLs as single pages. */
export const KNOWLEDGE_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const KNOWLEDGE_MAX_TEXT_CHARS = 200_000;
export const KNOWLEDGE_MAX_SOURCES_PER_AGENT = 20;

export const KNOWLEDGE_FILE_TYPES = [
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;
export const knowledgeFileType = z.enum(KNOWLEDGE_FILE_TYPES);

const name = z.string().trim().min(1).max(120);

/** A public http(s) URL. Private hosts are refused by the API, not here (zod cannot resolve DNS). */
export const knowledgeUrl = z
  .string()
  .trim()
  .url()
  .max(2_000)
  .refine((value) => /^https?:\/\//i.test(value), 'Only http(s) URLs can be read');

/**
 * POST /agents/:id/knowledge and POST /knowledge (`agent_id` in the body). A file
 * travels as base64 in JSON — the portal is a static export with no upload service of
 * its own, and the bytes are held only until the platform has ingested them.
 */
const role = knowledgeRole.optional();

export const createKnowledgeSourceRequest = z.discriminatedUnion('type', [
  z.object({ type: z.literal('url'), name: name.optional(), url: knowledgeUrl, role }),
  z.object({ type: z.literal('text'), name, text: z.string().min(1).max(KNOWLEDGE_MAX_TEXT_CHARS), role }),
  z.object({
    type: z.literal('file'),
    name,
    content_type: knowledgeFileType,
    /** Standard base64, no data: prefix. Size is checked after decoding. */
    content_base64: z.string().min(1).regex(/^[A-Za-z0-9+/=\r\n]+$/, 'Not base64'),
    role,
  }),
]);
export type CreateKnowledgeSourceRequest = z.infer<typeof createKnowledgeSourceRequest>;

export const createKnowledgeRequest = z.intersection(createKnowledgeSourceRequest, z.object({ agent_id: uuid }));
export type CreateKnowledgeRequest = z.infer<typeof createKnowledgeRequest>;

/** One source as the customer sees it. No platform identifiers, no error detail beyond one sentence. */
export const knowledgeSourceResponse = z.object({
  id: uuid,
  agent_id: uuid,
  type: knowledgeType,
  /** `menu` for the restaurant's menu, else null. */
  role: knowledgeRole.nullable(),
  name: z.string(),
  url: z.string().nullable(),
  content_type: z.string().nullable(),
  status: knowledgeStatus,
  size_bytes: z.number().int().nullable(),
  /** Customer-safe reason when `status = failed`. */
  error: z.string().nullable(),
  synced_at: isoDateTime.nullable(),
  created_at: isoDateTime,
  updated_at: isoDateTime,
});
export type KnowledgeSourceResponse = z.infer<typeof knowledgeSourceResponse>;

/** POST answers 202: the row exists, the sync is queued. */
export const knowledgeAccepted = z.object({ source: knowledgeSourceResponse, job_id: uuid.nullable() });
export type KnowledgeAccepted = z.infer<typeof knowledgeAccepted>;

export const knowledgeQuery = z.object({ agent_id: uuid.optional() });
export type KnowledgeQuery = z.infer<typeof knowledgeQuery>;

/** D16 `GET /agents/:id/knowledge/stats?days=` — the window, in whole days back from now. */
export const knowledgeStatsQuery = z.object({
  days: z.coerce.number().int().refine((d) => d === 7 || d === 30 || d === 90, '7, 30 or 90').default(30),
});
export type KnowledgeStatsQuery = z.infer<typeof knowledgeStatsQuery>;

/**
 * D16: how often the agent used what it knows, over real callers' calls (browser test
 * calls are left out, so testing does not inflate it). A look-up is one consultation; a
 * hit is a look-up that found something. Every current source is listed, unused ones
 * at zero; hits that cannot be tied to a current source (a website page among several,
 * a source deleted since) are `other_hits`.
 */
export const knowledgeSourceStats = z.object({
  source_id: uuid,
  name: z.string(),
  type: knowledgeType,
  hits: z.number().int(),
  /** Calls in which this source answered at least once. */
  calls: z.number().int(),
});
export type KnowledgeSourceStats = z.infer<typeof knowledgeSourceStats>;

export const knowledgeStatsResponse = z.object({
  days: z.number().int(),
  from: isoDateTime,
  /** Answered calls of this agent in the window. */
  calls: z.number().int(),
  /** Of those, calls that consulted what the agent knows at least once. */
  calls_with_lookups: z.number().int(),
  /** Of those, calls where at least one look-up found something. */
  calls_with_hits: z.number().int(),
  lookups: z.number().int(),
  hits: z.number().int(),
  sources: z.array(knowledgeSourceStats),
  other_hits: z.number().int(),
});
export type KnowledgeStatsResponse = z.infer<typeof knowledgeStatsResponse>;
