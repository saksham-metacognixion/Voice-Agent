import { z } from 'zod';

/**
 * What `call_analyzed` stores in `calls.analysis_json` — the platform's post-call
 * analysis, read leniently: every field is optional and anything unexpected is ignored,
 * so a missing or oddly-typed field costs one line of a card, never the card. Shared by
 * the W5 after-call card and the D2 detail drawer.
 */
export const callAnalysis = z
  .object({
    call_summary: z.string().optional().catch(undefined),
    user_sentiment: z.string().optional().catch(undefined),
    call_successful: z.boolean().optional().catch(undefined),
    in_voicemail: z.boolean().optional().catch(undefined),
    custom_analysis_data: z.record(z.unknown()).optional().catch(undefined),
  })
  .passthrough();
export type CallAnalysis = z.infer<typeof callAnalysis>;

export function parseAnalysis(value: unknown): CallAnalysis | null {
  if (!value || typeof value !== 'object') return null;
  const parsed = callAnalysis.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The captured fields (§9.8), minus empties, as `[name, value]` pairs in stored order. */
export function capturedFields(analysis: CallAnalysis | null): Array<[string, unknown]> {
  return Object.entries(analysis?.custom_analysis_data ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== '');
}

export type Sentiment = 'positive' | 'neutral' | 'negative' | 'unknown';

/** `user_sentiment` as the platform writes it (`Positive`, `Neutral`, `Negative`, `Unknown`) → ours. */
export function sentimentOf(value: string | null | undefined): Sentiment | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v.startsWith('pos')) return 'positive';
  if (v.startsWith('neg')) return 'negative';
  if (v.startsWith('neu')) return 'neutral';
  return 'unknown';
}

export interface TranscriptTurn {
  role: 'agent' | 'user';
  content: string;
}

/**
 * The transcript as speaker turns. `transcript_json` is the platform's
 * `transcript_object` (`{role, content, words}` per utterance); anything that is not an
 * agent or caller line (tool calls, node transitions) is dropped. When only the plain
 * text exists it is split on the `Agent:` / `User:` prefixes the platform writes, and a
 * line without a prefix continues the previous turn.
 */
export function transcriptTurns(json: unknown, text: string | null | undefined): TranscriptTurn[] {
  if (Array.isArray(json)) {
    const turns = json
      .map((u) => (u && typeof u === 'object' ? (u as { role?: unknown; content?: unknown }) : null))
      .filter((u): u is { role: 'agent' | 'user'; content: string } => Boolean(u) && (u!.role === 'agent' || u!.role === 'user') && typeof u!.content === 'string' && u!.content.trim().length > 0)
      .map((u) => ({ role: u.role, content: u.content.trim() }));
    if (turns.length) return turns;
  }
  if (!text?.trim()) return [];
  const turns: TranscriptTurn[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(agent|user|assistant|caller|customer)\s*:\s*(.*)$/i.exec(line);
    if (m) {
      const who = m[1]!.toLowerCase();
      turns.push({ role: who === 'agent' || who === 'assistant' ? 'agent' : 'user', content: m[2] ?? '' });
    } else if (turns.length) {
      turns[turns.length - 1]!.content = `${turns[turns.length - 1]!.content} ${line}`.trim();
    } else {
      turns.push({ role: 'agent', content: line });
    }
  }
  return turns;
}

/** `snake_case_name` → `Snake case name`. */
export function humanise(name: string): string {
  const s = name.replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
