import { isDialableE164, nationalReading, toBlockedCaller, type PhoneNumberResponse } from '@portal/schemas';

/** D4 "type": New / Forward target / SIP (spec p. 36). */
export type NumberType = 'new' | 'forward' | 'sip';

export function numberType(n: Pick<PhoneNumberResponse, 'kind' | 'forwarding'>): NumberType {
  if (n.kind === 'sip') return 'sip';
  return n.forwarding ? 'forward' : 'new';
}

/**
 * The area code asked for and the one bought, when they differ: W6 / D4's code had no
 * stock and the closest available was bought (`purchase-attempts.ts`). Null when there is
 * nothing to say — SIP, toll-free, no code asked for, not bought yet, or the same code (QA-076).
 */
export function areaCodeSubstitute(
  n: Pick<PhoneNumberResponse, 'kind' | 'toll_free' | 'e164' | 'area_code' | 'requested_area_code'>,
): { requested: string; bought: string } | null {
  if (n.kind === 'sip' || n.toll_free || !n.e164 || !n.requested_area_code || !n.area_code) return null;
  return n.requested_area_code === n.area_code ? null : { requested: n.requested_area_code, bought: n.area_code };
}

/** A released (or releasing) number is history: listed, never edited. */
export function isNumberEditable(n: Pick<PhoneNumberResponse, 'status'>): boolean {
  return n.status !== 'released' && n.status !== 'releasing';
}

/** Live numbers first, then provisioning, then everything that no longer answers. */
export function sortNumbers(list: PhoneNumberResponse[]): PhoneNumberResponse[] {
  const rank: Record<PhoneNumberResponse['status'], number> = { active: 0, paused: 1, provisioning: 2, failed: 3, releasing: 4, released: 5 };
  return [...list].sort((a, b) => rank[a.status] - rank[b.status] || a.created_at.localeCompare(b.created_at));
}

/** `updateNumberRequest.blocklist` holds at most 200 (spec p. 37 says 100; the schema is the contract). */
export const MAX_BLOCKLIST = 200;

/**
 * Block-list entries as typed ("+1 (514) 555-0666", "001 514 555 0666") → `+<digits>`, split
 * into what the API will take and what it will not, duplicates dropped. The API's own rule
 * (`toBlockedCaller`, QA-106): the country code must be typed — `5145550123` given a `+`
 * is a Peruvian number, saved, and never matched the Montreal caller it was meant to stop —
 * but the number need not be a real one: a spoofed caller ID can be blocked.
 */
export function parseBlocklist(entries: string[]): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const raw of entries) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const entry = toBlockedCaller(trimmed);
    if (entry) {
      if (!valid.includes(entry)) valid.push(entry);
    } else invalid.push(trimmed);
  }
  return { valid, invalid };
}

/** Whether one block-list chip would be refused: the chip is marked as soon as it is added. */
export function isBlocklistEntryInvalid(entry: string): boolean {
  return entry.trim() !== '' && toBlockedCaller(entry) === null;
}

/** A saved entry and the number it was probably meant to be. */
export interface MisreadEntry {
  entry: string;
  suggestion: string;
}

/**
 * Block-list entries saved before QA-106 the way the portal used to write them — a `+` in
 * front of a national number (`+5145550123` for a Montreal caller) — with the number each
 * was meant to be (`nationalReading`, read in `country`). Such an entry blocks nobody.
 */
export function misreadBlocklist(entries: ReadonlyArray<string>, country: string | null | undefined): MisreadEntry[] {
  const out: MisreadEntry[] = [];
  for (const entry of entries) {
    const suggestion = nationalReading(entry.trim(), country);
    if (suggestion) out.push({ entry: entry.trim(), suggestion });
  }
  return out;
}

/** The entries with each misread one replaced by its suggestion, duplicates dropped. */
export function applyMisreadFixes(entries: ReadonlyArray<string>, fixes: ReadonlyArray<MisreadEntry>): string[] {
  const out: string[] = [];
  for (const raw of entries) {
    const next = fixes.find((f) => f.entry === raw.trim())?.suggestion ?? raw;
    if (!out.includes(next)) out.push(next);
  }
  return out;
}

/** One number with entries saved without their country code (QA-106). */
export interface NumberNeedingFix {
  number: PhoneNumberResponse;
  /** Hand-off targets the API would refuse today: dialled, so they go to the wrong country or nowhere. */
  handoff: number;
  /** Blocked callers that read as a national number given a `+`: they block nobody. */
  blocked: number;
}

/**
 * The numbers the "Some phone numbers need fixing" notice names: every number that still
 * answers with a hand-off target that is not a real number, or a blocked caller saved the
 * pre-QA-106 way. A number is read in its own country, else the workspace's.
 */
export function numbersNeedingFix(list: ReadonlyArray<PhoneNumberResponse> | undefined, workspaceCountry: string | null | undefined): NumberNeedingFix[] {
  const out: NumberNeedingFix[] = [];
  for (const number of list ?? []) {
    if (!isNumberEditable(number)) continue;
    const handoff = number.transfer_targets.filter((t) => !isDialableE164(t.number)).length;
    const blocked = misreadBlocklist(number.blocklist, number.country ?? workspaceCountry).length;
    if (handoff || blocked) out.push({ number, handoff, blocked });
  }
  return out;
}

/** What the notice's "Dismiss" remembers: these entries on these numbers. A new one shows the notice again. */
export function needingFixSignature(list: ReadonlyArray<NumberNeedingFix>): string {
  return list
    .map((n) => `${n.number.id}:${n.handoff}:${n.blocked}`)
    .sort()
    .join(',');
}

/** Masks a SIP username to its first and last two characters, `tr••••er`; the mask never says how long it is. */
export function maskSecretish(value: string | null | undefined): string {
  if (!value) return '–';
  if (value.length <= 4) return '••••';
  return `${value.slice(0, 2)}••••${value.slice(-2)}`;
}

/** Whether a number's calls should keep the list polling: provisioning resolves on its own. */
export function anyProvisioning(list: PhoneNumberResponse[] | undefined): boolean {
  return Boolean(list?.some((n) => n.status === 'provisioning' || n.status === 'releasing'));
}

/**
 * The D4 list a `422 VALIDATION_FAILED` from PATCH /numbers/:id names (`blocklist.2`,
 * `transfer_targets.0.number`), so the section says the number needs its country code
 * rather than "Some fields need attention." (QA-106). Null for anything else.
 */
export function rejectedNumberList(fields: ReadonlyArray<{ field: string }> | undefined): 'blocklist' | 'transfer_targets' | null {
  for (const { field } of fields ?? []) {
    const head = field.split('.')[0];
    if (head === 'blocklist' || head === 'transfer_targets') return head;
  }
  return null;
}

/** The rows the plan's number cap counts: the API's `assertUnderCap` statuses. */
const HELD_STATUSES: ReadonlySet<PhoneNumberResponse['status']> = new Set(['provisioning', 'active', 'paused']);

/**
 * Why D4 "Add number" cannot go ahead, judged before anything is sent (QA-108) with the
 * checks POST /numbers/buy and /numbers/import make, in their order:
 *
 *   purchase   no credit pack bought yet. Free trial credits are a balance, not a purchase
 *   limit      the plan includes `max` numbers (> 0) and that many are already held
 *
 * Null while the wallet, the flags or the list are still loading. The API stays the gate;
 * this is so the dialog explains the reason up front instead of after a refusal.
 */
export type AddNumberBlock = { kind: 'purchase' } | { kind: 'limit'; max: number } | null;

export function addNumberBlock(input: {
  lastPackCredits: number | null | undefined;
  maxNumbers: number | undefined;
  numbers: ReadonlyArray<Pick<PhoneNumberResponse, 'status'>> | undefined;
}): AddNumberBlock {
  if (input.lastPackCredits === null) return { kind: 'purchase' };
  if (input.lastPackCredits === undefined || input.maxNumbers === undefined || !input.numbers) return null;
  const held = input.numbers.filter((n) => HELD_STATUSES.has(n.status)).length;
  return input.maxNumbers > 0 && held >= input.maxNumbers ? { kind: 'limit', max: input.maxNumbers } : null;
}
