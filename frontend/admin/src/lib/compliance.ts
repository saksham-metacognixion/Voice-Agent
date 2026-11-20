import type { AdminKycResponse, AdminNumberResponse, KycStatus } from '@portal/schemas';
import type { BadgeProps } from '@portal/ui';

type Variant = NonNullable<BadgeProps['variant']>;

/**
 * Outbound calling compliance (ADR 0031 §1) as the console offers it. Pure, so the card,
 * the tables and the sheet agree with each other and with what the API accepts.
 */

export const KYC_STATUS_LABELS: Record<KycStatus, string> = {
  none: 'Not submitted',
  pending: 'Awaiting review',
  verified: 'Verified',
  rejected: 'Rejected',
};

export function kycStatusVariant(status: KycStatus): Variant {
  switch (status) {
    case 'verified':
      return 'success';
    case 'pending':
      return 'warning';
    case 'rejected':
      return 'danger';
    default:
      return 'outline';
  }
}

/**
 * Which verdicts the console offers for a business verification. Approving needs details
 * to approve (the API answers 409 otherwise), so it is offered for a pending submission or
 * a rejected one that still has its details. Rejecting a pending submission is a
 * rejection; rejecting a verified business is withdrawing it, which stops outbound at once.
 */
export interface KycActions {
  approve: boolean;
  reject: 'reject' | 'withdraw' | null;
}

export function kycActions(kyc: Pick<AdminKycResponse, 'status' | 'details'>): KycActions {
  const hasDetails = kyc.details !== null;
  return {
    approve: hasDetails && (kyc.status === 'pending' || kyc.status === 'rejected'),
    reject: kyc.status === 'pending' ? 'reject' : kyc.status === 'verified' ? 'withdraw' : null,
  };
}

/** The limit the API puts on the sentence the customer reads with a rejection. */
export const KYC_CUSTOMER_REASON_MAX = 300;

export function customerReasonValid(text: string): boolean {
  const t = text.trim();
  return t.length >= 1 && t.length <= KYC_CUSTOMER_REASON_MAX;
}

type CallerIdFields = Pick<AdminNumberResponse, 'caller_id_verified' | 'caller_id_verified_via'>;

export function callerIdLabel(n: CallerIdFields): string {
  if (!n.caller_id_verified) return 'Not verified';
  if (n.caller_id_verified_via === 'purchase') return 'Verified (bought)';
  if (n.caller_id_verified_via === 'staff') return 'Verified (staff)';
  return 'Verified';
}

export function callerIdVariant(n: CallerIdFields): Variant {
  return n.caller_id_verified ? 'success' : 'outline';
}

/**
 * The caller ID action a number row offers. Revoking works for any verified number;
 * verifying only for a live one (it has an E.164 and is active or paused) — the API
 * answers 409 for anything else.
 */
export function callerIdAction(n: CallerIdFields & Pick<AdminNumberResponse, 'e164' | 'status'>): 'verify' | 'revoke' | null {
  if (n.caller_id_verified) return 'revoke';
  if (n.e164 && (n.status === 'active' || n.status === 'paused')) return 'verify';
  return null;
}
