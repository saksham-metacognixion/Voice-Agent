import { describe, expect, it } from 'vitest';
import { type OutboundFacts, decideOutbound } from './outbound.decide';
import { maskNumber, readDestination } from './destination';
import { pickCallerId, voicemailAction } from './outbound.service';
import { voicemailOption } from '../retell';

/** A callback every gate allows. Each case below breaks exactly one fact. */
const ALLOWED: OutboundFacts = {
  enabled: true,
  workspacePaused: false,
  kyc: 'verified',
  configured: true,
  callerId: 'ok',
  agentLive: true,
  destinationValid: true,
  countryRuled: true,
  destinationIsAgent: false,
  dncListed: false,
  priorContact: true,
  windowOpen: true,
  paid: true,
  balance: 40,
  usedToday: 3,
  dailyCap: 20,
};

describe('decideOutbound — the D18 gates', () => {
  it('allows a callback that passes every gate', () => {
    expect(decideOutbound(ALLOWED)).toEqual({ ok: true });
  });

  it('D18 exit check: a workspace with neither verification nor a verified caller ID is refused on verification first', () => {
    expect(decideOutbound({ ...ALLOWED, kyc: 'none', callerId: 'none' })).toEqual({ ok: false, reason: 'KYC_REQUIRED' });
    expect(decideOutbound({ ...ALLOWED, callerId: 'none' })).toEqual({ ok: false, reason: 'CALLER_ID_REQUIRED' });
  });

  it.each([
    [{ enabled: false }, 'OUTBOUND_DISABLED'],
    [{ workspacePaused: true }, 'WORKSPACE_PAUSED'],
    [{ kyc: 'none' }, 'KYC_REQUIRED'],
    [{ kyc: 'pending' }, 'KYC_PENDING'],
    [{ kyc: 'rejected' }, 'KYC_REJECTED'],
    [{ configured: false }, 'OUTBOUND_NOT_CONFIGURED'],
    [{ callerId: 'none' }, 'CALLER_ID_REQUIRED'],
    [{ callerId: 'unverified' }, 'CALLER_ID_UNVERIFIED'],
    [{ agentLive: false }, 'AGENT_NOT_PUBLISHED'],
    [{ destinationValid: false }, 'DESTINATION_INVALID'],
    [{ countryRuled: false }, 'DESTINATION_COUNTRY'],
    [{ destinationIsAgent: true }, 'DESTINATION_IS_AGENT'],
    [{ dncListed: true }, 'DNC_LISTED'],
    [{ priorContact: false }, 'NO_PRIOR_CONTACT'],
    [{ windowOpen: false }, 'OUTSIDE_CALLING_WINDOW'],
    [{ paid: false }, 'PURCHASE_REQUIRED'],
    [{ balance: 0 }, 'NO_CREDITS'],
    [{ usedToday: 20 }, 'OUTBOUND_DAILY_CAP'],
    [{ dailyCap: 0, usedToday: 0 }, 'OUTBOUND_DAILY_CAP'],
  ] as Array<[Partial<OutboundFacts>, string]>)('refuses %o with %s', (broken, reason) => {
    expect(decideOutbound({ ...ALLOWED, ...broken })).toEqual({ ok: false, reason });
  });

  it('answers who may call before whom, and whom before when', () => {
    expect(decideOutbound({ ...ALLOWED, kyc: 'pending', dncListed: true, windowOpen: false })).toEqual({ ok: false, reason: 'KYC_PENDING' });
    expect(decideOutbound({ ...ALLOWED, dncListed: true, windowOpen: false, usedToday: 99 })).toEqual({ ok: false, reason: 'DNC_LISTED' });
    expect(decideOutbound({ ...ALLOWED, windowOpen: false, balance: 0 })).toEqual({ ok: false, reason: 'OUTSIDE_CALLING_WINDOW' });
  });
});

describe('readDestination — the number a callback rings', () => {
  it('reads a real number and its country', () => {
    expect(readDestination('+14165550123')).toEqual({ ok: true, e164: '+14165550123', country: 'CA' });
    expect(readDestination('+12125550199')).toEqual({ ok: true, e164: '+12125550199', country: 'US' });
  });

  it.each([null, '', 'anonymous', '4165550123', '+11234567890', '+19005551234'])('refuses %s (withheld, not E.164, not real, premium-rate)', (raw) => {
    expect(readDestination(raw)).toEqual({ ok: false });
  });

  it('masks a number for an audit row: the country code and the last two digits', () => {
    expect(maskNumber('+14165550123')).toBe('+1••••••••23');
    expect(maskNumber(null)).toBeNull();
  });
});

describe('pickCallerId', () => {
  const at = new Date('2026-10-01T00:00:00Z');
  const numbers = [
    { id: 'n-sip', e164: '+14165550001', agentId: 'a1', callerIdVerifiedAt: null },
    { id: 'n-agent', e164: '+14165550002', agentId: 'a1', callerIdVerifiedAt: at },
    { id: 'n-source', e164: '+14165550003', agentId: 'a2', callerIdVerifiedAt: at },
  ];

  it('prefers the number the call came in on, then the agent’s, then any — verified ones only', () => {
    expect(pickCallerId(numbers, { sourceNumberId: 'n-source', agentId: 'a1' })).toEqual({ kind: 'ok', number: { id: 'n-source', e164: '+14165550003' } });
    expect(pickCallerId(numbers, { sourceNumberId: 'n-sip', agentId: 'a1' })).toEqual({ kind: 'ok', number: { id: 'n-agent', e164: '+14165550002' } });
    expect(pickCallerId(numbers, { sourceNumberId: null, agentId: null })).toEqual({ kind: 'ok', number: { id: 'n-agent', e164: '+14165550002' } });
  });

  it('refuses a number asked for that is unverified or not the workspace’s, and says when there is none at all', () => {
    expect(pickCallerId(numbers, { requested: 'n-sip', sourceNumberId: null, agentId: null })).toEqual({ kind: 'unverified' });
    expect(pickCallerId(numbers, { requested: 'someone-elses', sourceNumberId: null, agentId: null })).toEqual({ kind: 'unverified' });
    expect(pickCallerId([numbers[0]!], { sourceNumberId: 'n-sip', agentId: 'a1' })).toEqual({ kind: 'none' });
  });
});

describe('the voicemail setting, as the platform option', () => {
  it('hangs up by default, leaves the message when asked, and turns detection off for off', () => {
    expect(voicemailOption(voicemailAction({ voicemail_detection: 'hang_up', voicemail_message: null }))).toEqual({ action: { type: 'hangup' } });
    expect(voicemailOption(voicemailAction({ voicemail_detection: 'leave_message', voicemail_message: 'Sorry we missed you.' }))).toEqual({
      action: { type: 'static_text', text: 'Sorry we missed you.' },
    });
    expect(voicemailOption(voicemailAction({ voicemail_detection: 'off', voicemail_message: null }))).toBeNull();
  });
});
