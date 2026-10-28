import type { Brief } from '@portal/schemas';
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { cleanTransferFailMessage, transferFailVariables } from './transfer-fail-message';

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

/**
 * QA-083: a number's "message if the transfer fails" as the call will read it, or null for
 * none. Every number the call can transfer to is redacted out of it like the script — a
 * staff transfer number never reaches what the model reads — while any other number the
 * customer typed (a callback line, say) is theirs to have read out. Written into
 * `num:{e164}` by the runtime cache and passed by "Call my phone" and the callback.
 */
export function spokenTransferFailMessage(
  message: string | null | undefined,
  targets: readonly string[],
): string | null {
  const clean = cleanTransferFailMessage(message);
  return clean ? redactTransferNumbers(clean, targets) : null;
}

/**
 * A number's `transfer_targets_json` as the numbers it transfers to: `{number}` entries and
 * the plain strings an older row may hold. The one reader, so the runtime cache, "Call my
 * phone" and the callback agree on what a number transfers to.
 */
export function numberTransferTargets(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') out.push(item);
    else if (
      typeof item === 'object' &&
      item !== null &&
      typeof (item as { number?: unknown }).number === 'string'
    ) {
      out.push((item as { number: string }).number);
    }
  }
  return out;
}

/**
 * The transfer numbers a stored `brief_json` names (`transferTargets`), read leniently: they
 * are the agent's `transfer_number_N` defaults, which a call keeps for every N its number
 * does not set — so they can be dialled, and must be redacted, on any call.
 */
export function briefTransferNumbers(briefJson: unknown): string[] {
  const rules =
    typeof briefJson === 'object' && briefJson !== null
      ? (briefJson as { handoff_rules?: unknown }).handoff_rules
      : undefined;
  if (!Array.isArray(rules)) return [];
  const numbers = rules.flatMap((rule) => {
    const r = (typeof rule === 'object' && rule !== null ? rule : {}) as {
      action?: unknown;
      transfer_number?: unknown;
    };
    return r.action === 'transfer' && typeof r.transfer_number === 'string' && r.transfer_number
      ? [r.transfer_number]
      : [];
  });
  return [...new Set(numbers)];
}

/**
 * The per-call variables for a call on one of our numbers, as the inbound allow builds them
 * from `num:{e164}`: the number's transfer targets as `transfer_number_N` and its fail
 * message, with every number the call can reach — the number's and the brief's defaults —
 * redacted out of the message.
 */
export function numberTransferVariables(
  line: { transferTargetsJson: unknown; transferFailMessage: string | null },
  briefJson: unknown,
): Record<string, string> {
  const targets = numberTransferTargets(line.transferTargetsJson);
  const variables = transferFailVariables(
    spokenTransferFailMessage(line.transferFailMessage, [
      ...targets,
      ...briefTransferNumbers(briefJson),
    ]),
  );
  targets.forEach((number, i) => {
    variables[`transfer_number_${i + 1}`] = number;
  });
  return variables;
}
