import type { PhoneNumberResponse, PhonePlanResponse, TransferTarget } from '@portal/schemas';
import { businessHours, transferTarget } from '@portal/schemas';
import { SipCredentialsCipher } from '../crypto';

type NumberRow = {
  id: string;
  agentId: string | null;
  e164: string | null;
  nickname: string | null;
  type: string;
  country: string | null;
  areaCode: string | null;
  tollFree: boolean;
  status: string;
  pausedAt: Date | null;
  hoursMode: string;
  hoursOverrideJson: unknown;
  transferTargetsJson: unknown;
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
};

/** Row → wire. No `type` (it names the telephony vendor), no platform metadata, no token. */
export function toNumberResponse(row: NumberRow): PhoneNumberResponse {
  return {
    id: row.id,
    agent_id: row.agentId,
    e164: row.e164,
    nickname: row.nickname,
    kind: row.type === 'custom_sip' ? 'sip' : 'bought',
    country: row.country,
    area_code: row.areaCode,
    toll_free: row.tollFree,
    status: row.status as PhoneNumberResponse['status'],
    paused: row.pausedAt !== null || row.status === 'paused',
    hours_mode: row.hoursMode as PhoneNumberResponse['hours_mode'],
    hours_override: parseHours(row.hoursOverrideJson),
    transfer_targets: parseTargets(row.transferTargetsJson),
    allowed_countries: row.allowedCountries,
    blocklist: row.blocklist,
    forwarding: row.forwardingFrom
      ? {
          from: row.forwardingFrom,
          status: (row.forwardingStatus ?? 'waiting_for_customer') as NonNullable<PhoneNumberResponse['forwarding']>['status'],
          carrier: (row.carrier as NonNullable<PhoneNumberResponse['forwarding']>['carrier']) ?? null,
        }
      : null,
    rental_credits: row.rentalCredits,
    next_rental_at: row.nextRentalAt?.toISOString() ?? null,
    error: row.status === 'failed' ? row.error : null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
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
