/**
 * Is the draft's script written in another language than the agent's main one? (ADR 0027)
 *
 * The wizard writes the script on W2 and the language is chosen on W3, so an agent set to
 * Arabic after generation still greets callers in English (26 Oct, staging): the runtime
 * language block steers the conversation, but the greeting is the script's own words.
 *
 * Read from the greeting — one sentence, always in the language it was written for
 * (`DEFAULT_SYSTEM_PROMPT`) — and only where the writing system settles it: Arabic text
 * is in Arabic script, and a greeting in Arabic script is not for an English agent. Two
 * Latin-script languages are left alone rather than guessed at.
 */
const SCRIPTS: Record<string, RegExp> = { ar: /[؀-ۿ]/ };

export function scriptNeedsRewrite(greeting: string | null | undefined, primary: string): boolean {
  if (!greeting?.trim()) return false;
  const base = primary.toLowerCase().split('-')[0] ?? '';
  const own = SCRIPTS[base];
  if (own) return !own.test(greeting);
  return Object.values(SCRIPTS).some((script) => script.test(greeting));
}
