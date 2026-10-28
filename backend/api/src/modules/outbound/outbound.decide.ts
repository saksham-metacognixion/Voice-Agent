import type { KycStatus, OutboundRefusal } from '@portal/schemas';

/**
 * Everything one outbound callback is judged on, already read (ADR 0031 §2). Facts that
 * depend on an earlier one (the do-not-call lookup needs a valid destination) are simply
 * false when that one failed — the order below reaches the earlier refusal first.
 */
export interface OutboundFacts {
  /** The `outbound_calls` feature flag for the workspace. */
  enabled: boolean;
  workspacePaused: boolean;
  kyc: KycStatus;
  /** The workspace's stored outbound settings and time zone are usable. */
  configured: boolean;
  /** `none` = no verified number at all; `unverified` = the one asked for is not a verified number of this workspace. */
  callerId: 'ok' | 'none' | 'unverified';
  /** The call's agent is live, published and on the platform. */
  agentLive: boolean;
  destinationValid: boolean;
  /** The destination's country has calling rules in the published policy. */
  countryRuled: boolean;
  destinationIsAgent: boolean;
  dncListed: boolean;
  /** The destination called this workspace within the prior-contact window. */
  priorContact: boolean;
  windowOpen: boolean;
  paid: boolean;
  balance: number;
  usedToday: number;
  dailyCap: number;
}

export type OutboundDecision = { ok: true } | { ok: false; reason: OutboundRefusal };

/**
 * The D18 compliance gates, in the order they are answered. Pure, like the inbound
 * `decide()`: `GET /calls/:id/callback` shows the verdict, `POST` acts on it, and both read
 * it from here. The daily cap is checked once more under a lock when the attempt is
 * recorded, and the plan's line by `MintSlot` — this is the read, those are the writes.
 *
 * The order is "who may call" before "whom" before "when" before "how much": a workspace
 * without verification learns that first, whatever the number.
 */
export function decideOutbound(f: OutboundFacts): OutboundDecision {
  const refuse = (reason: OutboundRefusal): OutboundDecision => ({ ok: false, reason });
  if (!f.enabled) return refuse('OUTBOUND_DISABLED');
  if (f.workspacePaused) return refuse('WORKSPACE_PAUSED');
  if (f.kyc === 'pending') return refuse('KYC_PENDING');
  if (f.kyc === 'rejected') return refuse('KYC_REJECTED');
  if (f.kyc !== 'verified') return refuse('KYC_REQUIRED');
  if (!f.configured) return refuse('OUTBOUND_NOT_CONFIGURED');
  if (f.callerId === 'none') return refuse('CALLER_ID_REQUIRED');
  if (f.callerId === 'unverified') return refuse('CALLER_ID_UNVERIFIED');
  if (!f.agentLive) return refuse('AGENT_NOT_PUBLISHED');
  if (!f.destinationValid) return refuse('DESTINATION_INVALID');
  if (!f.countryRuled) return refuse('DESTINATION_COUNTRY');
  if (f.destinationIsAgent) return refuse('DESTINATION_IS_AGENT');
  if (f.dncListed) return refuse('DNC_LISTED');
  if (!f.priorContact) return refuse('NO_PRIOR_CONTACT');
  if (!f.windowOpen) return refuse('OUTSIDE_CALLING_WINDOW');
  if (!f.paid) return refuse('PURCHASE_REQUIRED');
  if (!(f.balance > 0)) return refuse('NO_CREDITS');
  if (f.usedToday >= f.dailyCap) return refuse('OUTBOUND_DAILY_CAP');
  return { ok: true };
}

/** The sentence the API answers each refusal with. The portal shows its own copy per code. */
export const REFUSAL_MESSAGES: Record<OutboundRefusal, string> = {
  OUTBOUND_DISABLED: 'Outbound calling is not available for this workspace yet.',
  WORKSPACE_PAUSED: 'This workspace is paused. Contact support to resume it.',
  KYC_REQUIRED: 'Verify your business before calling out. Submit your details in Settings → Outbound calling.',
  KYC_PENDING: 'Your business verification is being reviewed. Outbound calling opens once it is approved.',
  KYC_REJECTED: 'Your business verification was not approved. See Settings → Outbound calling, or contact support.',
  OUTBOUND_NOT_CONFIGURED: 'Your outbound settings need attention. Review them in Settings → Outbound calling.',
  CALLER_ID_REQUIRED: 'You need a verified number to call from. Numbers you bought from us are verified automatically.',
  CALLER_ID_UNVERIFIED: 'That number is not a verified caller ID of this workspace.',
  AGENT_NOT_PUBLISHED: 'The agent on this call is not live. Publish it before calling back.',
  DESTINATION_INVALID: 'This call has no phone number we can call back (withheld, a browser call, or not a real number).',
  DESTINATION_COUNTRY: 'Calls to that country are not available.',
  DESTINATION_IS_AGENT: 'That number is answered by an agent. It cannot be called back.',
  DNC_LISTED: 'This number is on a do-not-call list and cannot be called.',
  NO_PRIOR_CONTACT: 'You can call back people who called you recently. This number has not.',
  OUTSIDE_CALLING_WINDOW: 'It is outside the hours this number may be called.',
  PURCHASE_REQUIRED: 'Calling out opens once you have bought a pack.',
  NO_CREDITS: 'You are out of credits. Buy a pack to call out.',
  OUTBOUND_DAILY_CAP: 'You have placed as many outbound calls today as your plan allows.',
};
