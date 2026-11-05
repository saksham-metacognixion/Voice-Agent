import type { FaqPair } from '@portal/schemas';

/**
 * W2 #7: the FAQ pairs as one searchable `text` knowledge source (ADR 0039 §5) — a
 * question, its answer, a blank line between pairs. A pair missing either half is left
 * out, so a row still being typed never reaches what the agent knows.
 */
export function faqsAsText(faqs: readonly FaqPair[]): string {
  return completeFaqs(faqs)
    .map((pair) => `Q: ${pair.question.trim()}\nA: ${pair.answer.trim()}`)
    .join('\n\n');
}

/** The pairs with both a question and an answer: what "Move" offers to move. */
export function completeFaqs(faqs: readonly FaqPair[]): FaqPair[] {
  return faqs.filter((pair) => pair.question.trim() && pair.answer.trim());
}
