import { describe, expect, it } from 'vitest';
import { type OutboundFacts, decideOutbound } from './outbound.decide';
import { pickCallerId } from './caller-ids';
import { maskNumber, readDestination } from './destination';
import { asPlacementError, voicemailAction } from './outbound.service';
import { voicemailOption } from '../retell';

/** A callback every gate allows. Each case below breaks exactly one fact. */
const ALLOWED: OutboundFacts = {
  enabled: true,
  workspacePaused: false,
  kyc: 'verified',
  timezoneValid: true,
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
  inProgress: false,
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
    [{ timezoneValid: false }, 'WORKSPACE_TIMEZONE_INVALID'],
    [{ configured: false }, 'OUTBOUND_NOT_CONFIGURED'],
    [{ callerId: 'none' }, 'CALLER_ID_REQUIRED'],
    [{ callerId: 'unverified' }, 'CALLER_ID_UNVERIFIED'],
    [{ callerId: 'paused' }, 'NUMBER_PAUSED'],
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

  it('refuses a person a callback is already ringing or talking to, after every other gate', () => {
    expect(decideOutbound({ ...ALLOWED, inProgress: true })).toEqual({ ok: false, reason: 'OUTBOUND_IN_PROGRESS' });
    expect(decideOutbound({ ...ALLOWED, inProgress: true, usedToday: 20 })).toEqual({ ok: false, reason: 'OUTBOUND_DAILY_CAP' });
  });

  it('answers who may call before whom, and whom before when', () => {
    expect(decideOutbound({ ...ALLOWED, kyc: 'pending', dncListed: true, windowOpen: false })).toEqual({ ok: false, reason: 'KYC_PENDING' });
    expect(decideOutbound({ ...ALLOWED, dncListed: true, windowOpen: false, usedToday: 99 })).toEqual({ ok: false, reason: 'DNC_LISTED' });
    expect(decideOutbound({ ...ALLOWED, windowOpen: false, balance: 0 })).toEqual({ ok: false, reason: 'OUTSIDE_CALLING_WINDOW' });
  });

  it('QA-087: a time zone the runtime does not know is its own refusal, before the outbound settings', () => {
    expect(decideOutbound({ ...ALLOWED, timezoneValid: false, configured: false })).toEqual({ ok: false, reason: 'WORKSPACE_TIMEZONE_INVALID' });
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
  const active = { status: 'active', pausedAt: null };
  const numbers = [
    { id: 'n-sip', e164: '+14165550001', agentId: 'a1', callerIdVerifiedAt: null, ...active },
    { id: 'n-agent', e164: '+14165550002', agentId: 'a1', callerIdVerifiedAt: at, ...active },
    { id: 'n-source', e164: '+14165550003', agentId: 'a2', callerIdVerifiedAt: at, ...active },
  ];
  const paused = { id: 'n-paused', e164: '+14165550004', agentId: 'a1', callerIdVerifiedAt: at, status: 'paused', pausedAt: at };

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

  it('QA-085: never picks a paused number, and says so when it was asked for or is the only verified one', () => {
    // The call came in on the paused number: the pick moves on to the agent's.
    expect(pickCallerId([...numbers, paused], { sourceNumberId: 'n-paused', agentId: 'a1' })).toEqual({ kind: 'ok', number: { id: 'n-agent', e164: '+14165550002' } });
    expect(pickCallerId([...numbers, paused], { requested: 'n-paused', sourceNumberId: null, agentId: null })).toEqual({ kind: 'paused' });
    expect(pickCallerId([numbers[0]!, paused], { sourceNumberId: null, agentId: 'a1' })).toEqual({ kind: 'paused' });
    // A pause recorded on the row but not yet in its status counts the same.
    expect(pickCallerId([{ ...paused, status: 'active' }], { requested: 'n-paused', sourceNumberId: null, agentId: null })).toEqual({ kind: 'paused' });
    // An unverified number that is paused is still "unverified": verification comes first.
    expect(pickCallerId([{ ...paused, callerIdVerifiedAt: null }], { requested: 'n-paused', sourceNumberId: null, agentId: null })).toEqual({ kind: 'unverified' });
    expect(pickCallerId([{ ...paused, callerIdVerifiedAt: null }], { sourceNumberId: null, agentId: null })).toEqual({ kind: 'none' });
  });
});

describe('asPlacementError — what the platform not placing the call answers (QA-084)', () => {
  it('keeps a 4xx permanent: the platform refused what we sent and will again', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const error = asPlacementError(status);
      expect(error.code).toBe('BAD_REQUEST');
      expect(error.getStatus()).toBe(400);
      expect(error.message).not.toMatch(/try again/i);
    }
  });

  it('answers 503 for a timeout, a 5xx, no status at all, and the 4xx that are not refusals of the request', () => {
    for (const status of [undefined, 408, 409, 429, 500, 502, 503]) {
      const error = asPlacementError(status);
      expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
      expect(error.getStatus()).toBe(503);
    }
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
