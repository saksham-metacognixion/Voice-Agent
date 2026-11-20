/** One line of the W5 live transcript. */
export interface TranscriptLine {
  role: 'agent' | 'user';
  content: string;
}

/**
 * Folds an `update` frame's transcript into what is already on screen.
 *
 * The data channel sends the conversation so far, but it may be a trailing window
 * rather than the whole call, and the last utterance keeps growing while it is spoken.
 * So: a frame at least as long as what we hold replaces it; a shorter one is aligned on
 * its first line and replaces the tail from there. Anything that is not an agent or
 * caller line (tool calls, node transitions) is dropped — the customer never sees them.
 */
export function mergeTranscript(prev: TranscriptLine[], incoming: ReadonlyArray<{ role: string; content?: unknown }>): TranscriptLine[] {
  const next = incoming
    .filter((u): u is { role: 'agent' | 'user'; content: string } => (u.role === 'agent' || u.role === 'user') && typeof u.content === 'string')
    .map((u) => ({ role: u.role, content: u.content }));
  if (next.length === 0) return prev;
  if (next.length >= prev.length) return next;

  const head = next[0]!;
  for (let i = prev.length - 1; i >= 0; i -= 1) {
    const line = prev[i]!;
    if (line.role === head.role && (head.content.startsWith(line.content) || line.content.startsWith(head.content))) {
      return [...prev.slice(0, i), ...next];
    }
  }
  return [...prev, ...next];
}
