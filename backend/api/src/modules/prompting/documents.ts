import type { Brief, BriefDocument } from '@portal/schemas';
import { applyGuardrails } from './guardrails';

/**
 * W2 documents in the prompt the platform runs (ADR 0023).
 *
 * The generated script never carries a document's text: the model is told what is
 * attached and writes the rules for using it, and the text itself is appended here,
 * verbatim, in code — the same way the §9.4 guardrails are, and for the same reason. A
 * price the business wrote is then a price the agent reads, not one a model retyped, and
 * a re-upload changes what the phone hears at the next sync without a regenerate.
 *
 * The block sits between the editable body and the platform rules, so `stripGuardrails`
 * (which stops at the first heading after the guardrail block) never sees it and the
 * Advanced editor shows the script alone; the documents are edited on W2 and the Brief
 * tab, where they live. `runtimePrompt` is called at the one platform boundary,
 * `AgentRetellService.llmSpec`, by publish and by the draft sync alike.
 */
export const DOCUMENTS_HEADING = '## Business documents (attached)';

export function documentsBlock(documents: readonly BriefDocument[]): string {
  if (documents.length === 0) return '';
  const lines = [
    DOCUMENTS_HEADING,
    'The business uploaded these. Answer from them word for word: quote a price, an item or a detail only as it is written here, and say when something is not in them.',
  ];
  for (const doc of documents) {
    lines.push('', `### ${doc.name}`, doc.text.trim());
    if (doc.truncated)
      lines.push(
        '(The document continues beyond what is included here; for anything after this point, say you do not have that information.)',
      );
  }
  return lines.join('\n');
}

/** The prompt exactly as the platform runs it: script, documents, then the fixed rules. */
export function runtimePrompt(
  promptText: string,
  brief: Pick<Brief, 'documents'>,
  guardrails?: string | readonly string[] | null,
): string {
  const block = documentsBlock(brief.documents ?? []);
  return block
    ? applyGuardrails(`${stripDocuments(promptText)}\n\n${block}`, guardrails)
    : applyGuardrails(promptText, guardrails);
}

/** Everything but a documents block — idempotency for a prompt that came back through here. */
export function stripDocuments(prompt: string): string {
  const lines = prompt.split('\n');
  const kept: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (line.trim().toLowerCase() === DOCUMENTS_HEADING.toLowerCase()) {
      inside = true;
      continue;
    }
    if (inside && /^##\s+\S/.test(line)) inside = false;
    if (!inside) kept.push(line);
  }
  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}
