import type { ForwardingTest, PhoneNumberResponse, PhonePlanResponse, SipVerification, TransferTarget } from '@portal/schemas';
import { businessHours, forwardingTest, sipVerification, transferTarget } from '@portal/schemas';
import { FORWARDING_TEST_RING_MS } from '../calls/forwarding-test';
import { SipCredentialsCipher } from '../crypto';

type NumberRow = {
  id: string;
  agentId: string | null;
  e164: string | null;
  nickname: string | null;
  type: string;
  country: string | null;
  areaCode: string | null;
  requestedAreaCode?: string | null;
  tollFree: boolean;
  status: string;
  pausedAt: Date | null;
  hoursMode: string;
  hoursOverrideJson: unknown;
  transferTargetsJson: unknown;
  transferFailMessage?: string | null;
  allowedCountries: string[];
  blocklist: string[];
  forwardingFrom: string | null;
  forwardingStatus: string | null;
  carrier: string | null;
  rentalCredits: number;
  nextRentalAt: Date | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  sipVerificationJson?: unknown;
  sipVerifyStartedAt?: Date | null;
  forwardingTestJson?: unknown;
};

/** How long a re-verify may hold its lease (`phone_numbers.sip_verify_started_at`) before another may start. */
export const SIP_VERIFY_LEASE_MS = 90_000;

/** What the row alone cannot say: the plan's SIP credentials (redacted) and the D4 seven-day call count. */
export interface NumberExtras {
  plan?: { sipJson: unknown } | null;
  calls7d?: number;
}

/** Row → wire. No `type` (it names the telephony vendor), no platform metadata, no token. */
export function toNumberResponse(row: NumberRow & NumberExtras, calls7d = row.calls7d ?? 0): PhoneNumberResponse {
  const sip = row.type === 'custom_sip' ? SipCredentialsCipher.redact(row.plan?.sipJson) : null;
  return {
    id: row.id,
    agent_id: row.agentId,
    e164: row.e164,
    nickname: row.nickname,
    kind: row.type === 'custom_sip' ? 'sip' : 'bought',
    country: row.country,
    area_code: row.areaCode,
    requested_area_code: row.requestedAreaCode ?? null,
    toll_free: row.tollFree,
    status: row.status as PhoneNumberResponse['status'],
    paused: row.pausedAt !== null || row.status === 'paused',
    hours_mode: row.hoursMode as PhoneNumberResponse['hours_mode'],
    hours_override: parseHours(row.hoursOverrideJson),
    transfer_targets: parseTargets(row.transferTargetsJson),
    transfer_fail_message: row.transferFailMessage ?? null,
    allowed_countries: row.allowedCountries,
    blocklist: row.blocklist,
    forwarding: row.forwardingFrom
      ? {
          from: row.forwardingFrom,
          status: (row.forwardingStatus ?? 'waiting_for_customer') as NonNullable<PhoneNumberResponse['forwarding']>['status'],
          carrier: (row.carrier as NonNullable<PhoneNumberResponse['forwarding']>['carrier']) ?? null,
          test: forwardingTestOf(row),
        }
      : null,
    sip: sip ? { host: sip.host, username: sip.username, has_password: sip.has_password, verification: verificationOf(row) } : null,
    calls_7d: calls7d,
    rental_credits: row.rentalCredits,
    next_rental_at: row.nextRentalAt?.toISOString() ?? null,
    error: row.status === 'failed' ? row.error : null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/** The last re-verify as stored, `pending` while a live lease is held. Unreadable JSON reads as never checked. */
export function verificationOf(row: { sipVerificationJson?: unknown; sipVerifyStartedAt?: Date | null }, now = Date.now()): SipVerification | null {
  const held = row.sipVerifyStartedAt && now - row.sipVerifyStartedAt.getTime() < SIP_VERIFY_LEASE_MS;
  const parsed = sipVerification.safeParse(row.sipVerificationJson);
  const last = parsed.success ? parsed.data : null;
  if (held) return { status: 'pending', checked_at: last?.checked_at ?? null, reason: null, checks: null, credentials_updated: false };
  return last;
}

/** How long past its ring window a `calling` test may sit before it reads as over (its expire job was lost). */
const FORWARDING_TEST_GRACE_MS = 60_000;

/**
 * D17: the last forwarding test as stored. A test still `calling` well after its window
 * closed lost its expire job (a worker restart, Redis blinking); it reads as `not_landed`,
 * which is what that job would have written, so the button is not stuck on "Calling…".
 */
export function forwardingTestOf(row: { forwardingTestJson?: unknown }, now = Date.now()): ForwardingTest | null {
  const parsed = forwardingTest.safeParse(row.forwardingTestJson);
  if (!parsed.success) return null;
  const test = parsed.data;
  if (test.status === 'calling' && now - Date.parse(test.started_at) > FORWARDING_TEST_RING_MS + FORWARDING_TEST_GRACE_MS) {
    return { ...test, status: 'not_landed', finished_at: new Date(Date.parse(test.started_at) + FORWARDING_TEST_RING_MS).toISOString() };
  }
  return test;
}

type PlanRow = {
  id: string;
  agentId: string;
  option: string;
  country: string | null;
  areaCode: string | null;
  tollFree: boolean;
  existingNumber: string | null;
  carrier: string | null;
  sipJson: unknown;
  hoursMode: string;
  transferTargetsJson: unknown;
  allowedCountries: string[];
  status: string;
  createdAt: Date;
  updatedAt: Date;
  number?: { id: string } | null;
};

/** Row → wire. The SIP password never leaves the row, in any form. */
export function toPlanResponse(row: PlanRow): PhonePlanResponse {
  return {
    id: row.id,
    agent_id: row.agentId,
    option: row.option as PhonePlanResponse['option'],
    country: row.country,
    area_code: row.areaCode,
    toll_free: row.tollFree,
    existing_number: row.existingNumber,
    carrier: (row.carrier as PhonePlanResponse['carrier']) ?? null,
    sip: SipCredentialsCipher.redact(row.sipJson),
    hours_mode: row.hoursMode as PhonePlanResponse['hours_mode'],
    transfer_targets: parseTargets(row.transferTargetsJson),
    allowed_countries: row.allowedCountries,
    status: row.status as PhonePlanResponse['status'],
    number_id: row.number?.id ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export function parseTargets(value: unknown): TransferTarget[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => transferTarget.safeParse(item)).filter((r) => r.success).map((r) => r.data);
}

function parseHours(value: unknown) {
  if (!value) return null;
  const parsed = businessHours.safeParse(value);
  return parsed.success ? parsed.data : null;
}
