import type { Brief } from '@portal/schemas';
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

/**
 * Staff transfer numbers are for the phone system, never for the caller (BUG-005, 26 Oct:
 * an agent read the restaurant manager's mobile aloud when it offered the transfer, and
 * again when it retried). The number reached the model three ways — the brief handed to
 * the generator ("→ transfer to +1…"), the skeleton's `{transfer_targets}`, and the
 * `transfer_call` tool description — and the model did what it was shown.
 *
 * Now the number lives only where the platform dials it: the tool's
 * `transfer_destination` and the §9.7 `transfer_number_N` variables. Everything the
 * model reads names *who* the caller reaches, and `redactTransferNumbers` runs on the
 * script and the greeting at the one platform boundary (`AgentRetellService.llmSpec`),
 * so a script generated before this fix — or a number a customer typed into the
 * Advanced editor — reaches the phone without it, with no regenerate.
 */

/** Who the caller is told they will reach. Words, never digits. */
export const STAFF_LABEL = 'our staff';

/** One `transfer_call` tool per distinct number, with every condition that leads to it. */
export interface TransferRoute {
  number: string;
  conditions: string[];
}

/** The brief's transfer rules grouped by number, in first-seen order (the order of `transferTargets`). */
export function transferRoutes(brief: Pick<Brief, 'handoff_rules'>): TransferRoute[] {
  const routes = new Map<string, string[]>();
  for (const rule of brief.handoff_rules) {
    if (rule.action !== 'transfer' || !rule.transfer_number) continue;
    const conditions = routes.get(rule.transfer_number) ?? [];
    const condition = rule.condition.trim();
    if (condition && !conditions.includes(condition)) conditions.push(condition);
    routes.set(rule.transfer_number, conditions);
  }
  return [...routes].map(([number, conditions]) => ({ number, conditions }));
}

const SEPARATOR = '[\\s().\\-\\u00a0]*';

/**
 * A pattern for one number as a script might write it: `+14165551234`, `+1 (416) 555-1234`,
 * `416.555.1234`, `1-416-555-1234`, `020 7946 0018` for `+442079460018`. The national
 * digits are required in order with any separators between them; the country code (with
 * `+` or `00`) and a leading trunk `0` are optional. Digits either side end the match, so
 * a longer number that merely contains these digits is left alone.
 */
function numberPattern(e164: string): string | null {
  const parsed = parsePhoneNumberFromString(e164);
  const national = parsed?.nationalNumber ?? e164.replace(/\D/g, '');
  if (national.length < 6) return null;
  const digits = national.split('').join(SEPARATOR);
  const country = parsed?.countryCallingCode
    ? `(?:(?:(?:\\+|00)${SEPARATOR})?${parsed.countryCallingCode.split('').join(SEPARATOR)}${SEPARATOR})?`
    : '';
  return `(?<!\\d)${country}\\(?(?:0${SEPARATOR})?${digits}(?!\\d)`;
}

/**
 * The text with every transfer number — and every `{{transfer_number_N}}` variable,
 * which the platform would fill with one — replaced by `STAFF_LABEL`. Idempotent; text
 * without a transfer number comes back unchanged.
 */
export function redactTransferNumbers(text: string, numbers: readonly string[]): string {
  let out = text.replace(/\{\{\s*transfer_number_\d+\s*\}\}/g, STAFF_LABEL);
  for (const number of numbers) {
    const pattern = numberPattern(number);
    if (pattern) out = out.replace(new RegExp(pattern, 'g'), STAFF_LABEL);
  }
  return out;
}
