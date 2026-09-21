/**
 * §9.4 — platform guardrails: appended to every prompt, removable by nobody.
 *
 * The mechanism is deliberately dull, because the interesting version is the one that
 * breaks. Three properties hold, and each is a line of code rather than a promise:
 *
 *   1. **The model never carries them.** Generation returns the *business* prompt; this
 *      file appends the block afterwards, after the zod parse (ADR 0009, and the reason
 *      the smaller model is enough). A model that forgets the guardrails, paraphrases
 *      them, or is talked out of them changes nothing.
 *   2. **No request can remove them.** `promptUpdate` — the Advanced editor's body — has
 *      no field for them; whatever block the submitted text contains is stripped and the
 *      canonical one is appended. Sending the guardrails back deleted, reworded or
 *      inverted all produce the same stored prompt.
 *   3. **They are re-applied on the way out.** Publishing rebuilds the Retell prompt
 *      through `applyGuardrails` again, so a row written by an older version of this code
 *      — or by anything that ever bypassed it — still reaches Retell with them attached.
 *
 * `applyGuardrails` is idempotent: applying it to its own output is a no-op, which is
 * what makes step 3 free.
 */

/**
 * The block's heading. Matching is by heading, not by text, so editing a bullet inside
 * the block still strips the whole thing rather than leaving half of it behind.
 */
export const GUARDRAIL_HEADING = '## Platform rules (fixed)';

/**
 * The §9.4 bullets, verbatim from the spec.
 *
 * This copy is the guarantee. `agent_stack_configs.guardrails_text` (SA6) may replace the
 * wording — for a locale, or a new rule — but an environment whose stack table is empty,
 * or whose row fails to parse, still gets these. There is no code path that appends
 * nothing.
 */
export const DEFAULT_PLATFORM_GUARDRAILS: readonly string[] = [
  'Never claim to be human. If asked, say you are an AI assistant for the business.',
  'Never provide medical, legal or financial advice beyond the facts in the brief or what you know; recommend speaking to the business.',
  'Never invent prices, availability, policies or names. If you do not know, say "I don\'t have that information, but I can take a message."',
  'Never collect payment card numbers, SSN/SIN, passwords or full health details; ask for a callback instead.',
  'No profanity and no political or religious opinions. De-escalate abuse once, then end the call politely.',
  'Keep turns to two sentences or fewer. Confirm captured details back to the caller. End the call when the caller is done.',
  'Respect business hours: when the business is closed, say so and follow the after-hours rules.',
];

/** A stack row stores the bullets as one newline-separated string; both forms are accepted. */
export function guardrailLines(source: string | readonly string[] | null | undefined): string[] {
  const lines = (typeof source === 'string' ? source.split('\n') : (source ?? []))
    .map((line) => line.replace(/^\s*[-*•]\s*/, '').trim())
    .filter(Boolean);
  return lines.length > 0 ? lines : [...DEFAULT_PLATFORM_GUARDRAILS];
}

/** The canonical block, exactly as it appears at the end of every prompt. */
export function guardrailBlock(source?: string | readonly string[] | null): string {
  return [GUARDRAIL_HEADING, ...guardrailLines(source).map((line) => `- ${line}`)].join('\n');
}

/**
 * Everything the customer may edit: the prompt with the guardrail block taken out.
 *
 * A heading is matched case-insensitively and with loose whitespace, so a copy-paste that
 * changed the spacing is still recognised as the block rather than left in place as prose.
 * Every occurrence goes, not just the last one — a prompt with the heading in the middle
 * would otherwise keep a stale copy that contradicts the real one.
 */
export function stripGuardrails(prompt: string): string {
  const lines = prompt.split('\n');
  const kept: string[] = [];
  let inside = false;

  for (const line of lines) {
    if (isGuardrailHeading(line)) {
      inside = true;
      continue;
    }
    // Any other top-level heading ends the block: the guardrails are last in Appendix B,
    // but a hand-edited prompt need not respect that.
    if (inside && /^##\s+\S/.test(line)) inside = false;
    if (!inside) kept.push(line);
  }

  return kept.join('\n').replace(/\n{3,}$/, '\n').trimEnd();
}

/**
 * The prompt as Retell runs it: the editable body, then the canonical block.
 *
 * Idempotent — `applyGuardrails(applyGuardrails(x)) === applyGuardrails(x)` — because it
 * strips before it appends.
 */
export function applyGuardrails(prompt: string, source?: string | readonly string[] | null): string {
  const body = stripGuardrails(prompt);
  return `${body}\n\n${guardrailBlock(source)}\n`;
}

/** True when the prompt ends with the canonical block. The §9.5 `guardrails_missing` rule. */
export function hasGuardrails(prompt: string, source?: string | readonly string[] | null): boolean {
  return normalise(prompt).includes(normalise(guardrailBlock(source)));
}

function isGuardrailHeading(line: string): boolean {
  return normaliseHeading(line) === normaliseHeading(GUARDRAIL_HEADING);
}

function normaliseHeading(line: string): string {
  return line.trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalise(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
}
