import type { CallKnowledgeUse } from '@portal/schemas';

/*
 * D16 knowledge-use statistics: what an agent looked up during one call, as pure functions.
 *
 * The platform gives two things after a call that consulted a knowledge base:
 *   - `latency.knowledge_base.num` — how many look-ups it made (one per agent response);
 *   - `knowledge_base_retrieved_contents_url` — a signed JSON file, one entry per look-up:
 *     `{response_id, kb_ids, language, contexts: string[], kb_config}`. An empty `contexts`
 *     is a look-up that found nothing above the score filter. Each context starts with a
 *     header naming where it came from (read from real dev calls, 27 Oct 2026):
 *       `{FileName: 0da459c1-Bright_Smile_Dental_FAQ.txt}`  a file (`sourceFilename`)
 *       `{Title: Opening hours [4fcadf44]}`                 a text  (`sourceTitle`)
 *       `{Site Title: Indian cuisine - Wikipedia}`          a URL — the page, not the URL
 *     Files and texts carry the first 8 hex digits of our `knowledge_sources.id`, because
 *     the sync names them that way (knowledge-sync.worker.ts); a URL can only be matched
 *     when the agent has exactly one.
 *
 * A "hit" is a look-up that returned at least one passage; a source's hits are the look-ups
 * it contributed to (counted once per look-up, however many of its passages came back).
 * Everything is recomputed from the file and written with SET, so a replay cannot count twice.
 */

export type KbSourceKind = 'file' | 'text' | 'url' | 'unknown';

/** One of the agent's sources, as attribution needs it. */
export interface KbSourceRef {
  id: string;
  type: 'file' | 'text' | 'url';
}

export interface StoredSourceUse {
  source_id: string | null;
  kind: KbSourceKind;
  hits: number;
}

/** `calls.kb_usage_json`. */
export interface StoredKbUsage {
  detail: 'complete' | 'count_only';
  sources: StoredSourceUse[];
}

export interface RetrievalSummary {
  lookups: number;
  hits: number;
  sources: StoredSourceUse[];
}

const HEADER = /^\s*\{([^:}]{1,40}):\s*([^}]*)\}/;

/** Summarises the platform's retrieval file, or null when it is not the shape we know. */
export function summariseRetrievals(file: unknown, sources: readonly KbSourceRef[]): RetrievalSummary | null {
  if (!Array.isArray(file)) return null;
  let hits = 0;
  const bySource = new Map<string, StoredSourceUse>();
  for (const entry of file) {
    if (typeof entry !== 'object' || entry === null) continue;
    const contexts = (entry as Record<string, unknown>).contexts;
    if (!Array.isArray(contexts)) continue;
    const passages = contexts.filter((c): c is string => typeof c === 'string' && c.trim() !== '');
    if (!passages.length) continue;
    hits += 1;
    // Once per look-up: three passages of one file are one hit for that file.
    const seen = new Set<string>();
    for (const passage of passages) {
      const { source_id, kind } = attribute(passage, sources);
      const key = source_id ?? `:${kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const row = bySource.get(key) ?? { source_id, kind, hits: 0 };
      row.hits += 1;
      bySource.set(key, row);
    }
  }
  const lookups = file.filter((e) => typeof e === 'object' && e !== null).length;
  return { lookups, hits, sources: [...bySource.values()].sort((a, b) => b.hits - a.hits) };
}

/** Which of the agent's sources a passage came from, by the header the platform put on it. */
export function attribute(passage: string, sources: readonly KbSourceRef[]): { source_id: string | null; kind: KbSourceKind } {
  const header = HEADER.exec(passage);
  if (!header) return { source_id: null, kind: 'unknown' };
  const label = header[1]!.trim().toLowerCase();
  const value = header[2]!.trim();

  const byPrefix = (prefix: string, type?: KbSourceRef['type']) => {
    const found = sources.filter((s) => s.id.replace(/-/g, '').toLowerCase().startsWith(prefix.toLowerCase()) && (!type || s.type === type));
    return found.length === 1 ? found[0]! : null;
  };

  const filePrefix = /^([0-9a-f]{8})-/i.exec(value)?.[1];
  if (label.includes('file') && filePrefix) {
    const hit = byPrefix(filePrefix, 'file');
    return { source_id: hit?.id ?? null, kind: 'file' };
  }
  const titleTag = /\[([0-9a-f]{8})\]\s*$/i.exec(value)?.[1];
  if (titleTag) {
    const hit = byPrefix(titleTag, 'text');
    return { source_id: hit?.id ?? null, kind: 'text' };
  }
  if (label.includes('site') || label.includes('url')) {
    const urls = sources.filter((s) => s.type === 'url');
    return { source_id: urls.length === 1 ? urls[0]!.id : null, kind: 'url' };
  }
  if (filePrefix) {
    const hit = byPrefix(filePrefix);
    if (hit) return { source_id: hit.id, kind: hit.type };
  }
  return { source_id: null, kind: 'unknown' };
}

/** The stored JSON, read defensively: anything malformed is "count only". */
export function parseStoredUsage(value: unknown): StoredKbUsage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { detail: 'count_only', sources: [] };
  const record = value as Record<string, unknown>;
  const sources = Array.isArray(record.sources)
    ? record.sources.flatMap((s): StoredSourceUse[] => {
        if (typeof s !== 'object' || s === null) return [];
        const r = s as Record<string, unknown>;
        const hits = typeof r.hits === 'number' && Number.isInteger(r.hits) && r.hits > 0 ? r.hits : 0;
        const kind: KbSourceKind = r.kind === 'file' || r.kind === 'text' || r.kind === 'url' ? r.kind : 'unknown';
        return hits ? [{ source_id: typeof r.source_id === 'string' ? r.source_id : null, kind, hits }] : [];
      })
    : [];
  return { detail: record.detail === 'complete' ? 'complete' : 'count_only', sources };
}

export function storedSourceIds(value: unknown): string[] {
  return [...new Set(parseStoredUsage(value).sources.flatMap((s) => (s.source_id ? [s.source_id] : [])))];
}

/**
 * The wire shape. Null when the call never consulted what the agent knows. A source
 * deleted since the call loses its id and name (it can no longer be opened) but keeps its
 * hits, so the per-call numbers still add up.
 */
export function knowledgeUseOf(
  retrievals: number | null,
  hits: number | null,
  usage: unknown,
  names: ReadonlyMap<string, string>,
): CallKnowledgeUse | null {
  if (retrievals === null) return null;
  const stored = parseStoredUsage(usage);
  return {
    lookups: retrievals,
    hits,
    detail: stored.detail,
    sources: stored.sources.map((s) => {
      const name = s.source_id ? (names.get(s.source_id) ?? null) : null;
      return { source_id: name ? s.source_id : null, name, kind: s.kind, hits: s.hits };
    }),
  };
}
