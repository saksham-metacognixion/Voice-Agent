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
 * Not in §9.4. Agents said "Thank you for calling …" straight after a reservation
 * read-back or an answer about parking while the caller still had questions (26 Oct):
 * every template ended "confirm the details → close politely", the skeleton's `## Ending`
 * was a bare `{closing_line}`, and §9.4's sixth rule puts "confirm" and "end the call" side
 * by side. Fixed rather than a stack-row bullet, so it reaches an agent whose stored
 * script still carries the old ending at its next sync — no regenerate, no new stack
 * version (staging serves v1).
 *
 * It does not name the `end_call` tool. Doing so raised hang-ups on a real goodbye from
 * ~60 % to 15/16 in text conversations on the dev platform, but an agent still running an
 * old script then called it mid-booking — 5 of 24 conversations hung up on the caller
 * (ADR 0012, "The closing line").
 */
export const CLOSING_RULE =
  'Say goodbye only when the caller is done. After you answer a question or confirm a request, ask whether there is anything else. A pause or a short reply such as "okay" is not a goodbye: ask once more. Once the caller says there is nothing else or says goodbye, thank them for calling and end the call in the same turn.';

/**
 * Not in §9.4. An agent read the restaurant manager's mobile number aloud when it offered
 * a transfer, and again when the transfer was retried (BUG-005, 26 Oct). The number no
 * longer reaches the model at all (`staff-transfer.ts`); this says what to do instead,
 * and what to say when the transfer cannot happen — a browser test call, nobody answering.
 * Conditional on a hand-off rule, so an agent with no transfer never offers one.
 */
export const TRANSFER_RULE =
  'Never say a phone number you would transfer a caller to. When a hand-off rule says to transfer, ask "Would you like me to transfer you to our staff?" and transfer only once the caller agrees. If the transfer is not available or does not go through, say the team cannot take the call right now and offer to take a message.';

/**
 * Not in §9.4. Asked for vegetarian dishes, an agent read every menu item with its price,
 * drinks included (BUG-007, 26 Oct). On the phone a long list is noise. Fixed, like
 * `CLOSING_RULE`, so it reaches an agent generated before the menu prompt rules changed.
 */
export const LIST_RULE =
  'When the caller asks what is available in a category, name at most three or four items that fit what they asked for, then ask whether they would like to hear more. Read a full list only when the caller asks for all of it. Do not mix in other categories, such as drinks with food, unless the caller asks. Say a price only when the caller asks or it helps them choose, exactly as written.';

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

/**
 * Rules the platform's own checks depend on, so no stack row can word them away: SA6
 * replaces the §9.4 bullets above, and these are appended after whatever it chose (once —
 * a row that already carries one word for word is not given a second copy).
 *
 * Phone numbers, since 26 Oct: a caller who said nine digits twice heard ten read back,
 * and the invented number was captured for staff to ring. `captured-phones.ts` flags a
 * number the caller never said; this is what stops the agent saying one. Measured on dev
 * (gpt-5-mini, text chats, 16 runs per case): this wording never padded a number and
 * never rejected a valid one, and a nine-digit number was read back as said, so the
 * caller's correction caught it every time. **Do not make the rule branch on the digit
 * count.** A length-gated variant ("count its digits; if not 10, do not read it back")
 * miscounted "eight seven six, five four three, two one zero zero" as 11 and re-asked a
 * valid number 15/16 times, and the bookings behind it dead-ended; a stated length as a
 * separate bullet had no effect. Counting is the code's job, after the call.
 *
 * The closing line, since 26 Oct (ADR 0012, "The closing line"): see `CLOSING_RULE`.
 * Transfers and lists, since 26 Oct (BUG-005, BUG-007): see `TRANSFER_RULE`, `LIST_RULE`.
 */
export const FIXED_PLATFORM_GUARDRAILS: readonly string[] = [
  CLOSING_RULE,
  TRANSFER_RULE,
  LIST_RULE,
  'Phone numbers: callers often say digits in groups ("eight seven six, five four three") and every digit said counts, whatever the grouping. Read back exactly the digits the caller said, in their order, one at a time. Never add, drop, repeat or change a digit to make a number look complete, and never guess a digit you did not hear clearly or treat a pause as zero. Ask again only when a number sounds too short, too long or unclear: say so and ask for the whole number again, slowly. It is confirmed only when the caller says your read-back is right. After two unclear tries, stop asking, say the team will confirm the number, and carry on with the request.',
];

/** A stack row stores the bullets as one newline-separated string; both forms are accepted. */
export function guardrailLines(source: string | readonly string[] | null | undefined): string[] {
  const lines = (typeof source === 'string' ? source.split('\n') : (source ?? []))
    .map((line) => line.replace(/^\s*[-*•]\s*/, '').trim())
    .filter(Boolean);
  const base = lines.length > 0 ? lines : [...DEFAULT_PLATFORM_GUARDRAILS];
  return [...base, ...FIXED_PLATFORM_GUARDRAILS.filter((rule) => !base.includes(rule))];
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
