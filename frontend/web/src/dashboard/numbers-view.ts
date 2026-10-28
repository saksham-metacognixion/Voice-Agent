import { e164, type PhoneNumberResponse } from '@portal/schemas';

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
 * Block-list entries as typed ("+1 (514) 555-0666", "15145550666") → E.164, split into
 * what the API will take and what it will not, duplicates dropped.
 */
export function parseBlocklist(entries: string[]): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const raw of entries) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const digits = trimmed.replace(/[^\d]/g, '');
    const candidate = digits ? `+${digits}` : trimmed;
    if (e164.safeParse(candidate).success) {
      if (!valid.includes(candidate)) valid.push(candidate);
    } else invalid.push(trimmed);
  }
  return { valid, invalid };
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
