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
export const createKnowledgeSourceRequest = z.discriminatedUnion('type', [
  z.object({ type: z.literal('url'), name: name.optional(), url: knowledgeUrl }),
  z.object({ type: z.literal('text'), name, text: z.string().min(1).max(KNOWLEDGE_MAX_TEXT_CHARS) }),
  z.object({
    type: z.literal('file'),
    name,
    content_type: knowledgeFileType,
    /** Standard base64, no data: prefix. Size is checked after decoding. */
    content_base64: z.string().min(1).regex(/^[A-Za-z0-9+/=\r\n]+$/, 'Not base64'),
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
