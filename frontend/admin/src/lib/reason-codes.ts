import { reasonCode, type ReasonCode } from '@portal/schemas';

/** Admin Appendix B — the fourteen reason codes with their human labels, in enum order. */
export const REASON_LABELS: Record<ReasonCode, string> = {
  goodwill: 'Goodwill',
  service_issue: 'Service issue',
  billing_error: 'Billing error',
  promo: 'Promotion',
  partner_deal: 'Partner deal',
  fraud_suspected: 'Fraud suspected',
  abuse_policy: 'Abuse / policy',
  customer_request: 'Customer request',
  chargeback: 'Chargeback',
  expiry_extension: 'Expiry extension',
  testing_internal: 'Internal testing',
  support_investigation: 'Support investigation',
  legal_request: 'Legal request',
  other: 'Other (note required)',
};

export const REASON_CODES: ReasonCode[] = reasonCode.options;

export function reasonLabel(code: ReasonCode | null | undefined): string {
  return code ? REASON_LABELS[code] : '–';
}
