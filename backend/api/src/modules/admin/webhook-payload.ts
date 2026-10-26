/**
 * What a stored webhook body carries that only `can_listen_recordings` may see (QA-033).
 *
 * A voice-platform `call_ended` / `call_analyzed` / `transfer_*` body is the whole call:
 * signed recording links, the public call log, the transcript in three shapes and the
 * analysis summary of what was said. SA8 shows none of that (recording access is the
 * logged, reason-coded `can_listen_recordings` action, admin §10), so SA12's payload view
 * must not be the way round it. Matched on field names at any depth, normalised (case,
 * `_`, `-`), so `recording_url`, `scrubbed_recording_multi_channel_url`, `transcriptObject`
 * and a future `*_recording_url` are all caught. Everything else — ids, timestamps,
 * statuses, costs, latency, disconnection reasons, metadata — is left as stored: it is
 * what an operator reads the payload for.
 */
export const REDACTED = '[redacted: requires can_listen_recordings]';

function sensitive(key: string, value: unknown): boolean {
  // A count, a flag or a timestamp says nothing anyone said (`recording_enabled`, a
  // `transcript_count`); only text, lists and objects can carry it.
  if (value === null || value === undefined || value === '') return false;
  if (typeof value !== 'string' && typeof value !== 'object') return false;
  const k = key.toLowerCase().replace(/[_-]/g, '');
  if (k.includes('transcript')) return true;
  if (k.includes('recording') && (k.includes('url') || k === 'recording' || k === 'recordings')) return true;
  // The platform's call log page replays the conversation; the summary retells it; the
  // retrieved-contents link is what the agent read out against what the caller asked.
  return k === 'publiclogurl' || k === 'callsummary' || k === 'knowledgebaseretrievedcontentsurl';
}

export interface RedactedPayload {
  payload: unknown;
  /** Field paths that were blanked, e.g. `call.recording_url`. Never their values. */
  redacted: string[];
}

export function redactWebhookPayload(payload: unknown): RedactedPayload {
  const redacted: string[] = [];
  const walk = (value: unknown, path: string, depth: number): unknown => {
    // Stored bodies are shallow; the bound only guards against a pathological one.
    if (depth > 32 || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((v, i) => walk(v, `${path}[${i}]`, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const at = path ? `${path}.${key}` : key;
      if (sensitive(key, v)) {
        out[key] = REDACTED;
        redacted.push(at);
      } else {
        out[key] = walk(v, at, depth + 1);
      }
    }
    return out;
  };
  return { payload: walk(payload, '', 0), redacted };
}
