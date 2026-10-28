import { ApiError } from '@portal/api-client';
import { describe, expect, it } from 'vitest';
import { callbackFix, callbackView, callerIdNote, canListDnc, keepIdempotencyKey, showCallbackPanel } from './callback-view';

const allowed = { allowed: true, reason: null, next_allowed_at: null };

describe('showCallbackPanel', () => {
  it('is offered for a phone call when the workspace has outbound calling', () => {
    expect(showCallbackPanel({ channel: 'phone' }, true)).toBe(true);
    expect(showCallbackPanel({ channel: 'phone' }, false)).toBe(false);
    expect(showCallbackPanel({ channel: 'web' }, true)).toBe(false);
  });
});

describe('callbackView', () => {
  it('lets an editor and up place an allowed callback, and shows it to a viewer without the button', () => {
    expect(callbackView(allowed, 'editor')).toEqual({ kind: 'ready', canPlace: true });
    expect(callbackView(allowed, 'owner')).toEqual({ kind: 'ready', canPlace: true });
    expect(callbackView(allowed, 'viewer')).toEqual({ kind: 'ready', canPlace: false });
  });

  it('carries the next allowed time only for the calling window', () => {
    const at = '2026-10-29T13:00:00.000Z';
    expect(callbackView({ allowed: false, reason: 'OUTSIDE_CALLING_WINDOW', next_allowed_at: at }, 'editor')).toEqual({ kind: 'blocked', reason: 'OUTSIDE_CALLING_WINDOW', fix: null, nextAllowedAt: at });
    expect(callbackView({ allowed: false, reason: 'DNC_LISTED', next_allowed_at: at }, 'editor')).toEqual({ kind: 'blocked', reason: 'DNC_LISTED', fix: null, nextAllowedAt: null });
  });

  it('points verification and caller ID refusals at settings, money ones at the wallet', () => {
    expect(callbackView({ allowed: false, reason: 'KYC_PENDING', next_allowed_at: null }, 'viewer')).toMatchObject({ fix: 'settings' });
    for (const reason of ['KYC_REQUIRED', 'KYC_REJECTED', 'OUTBOUND_NOT_CONFIGURED', 'CALLER_ID_REQUIRED', 'CALLER_ID_UNVERIFIED'] as const) expect(callbackFix(reason)).toBe('settings');
    expect(callbackFix('NO_CREDITS')).toBe('wallet');
    expect(callbackFix('PURCHASE_REQUIRED')).toBe('wallet');
    expect(callbackFix('NO_PRIOR_CONTACT')).toBeNull();
    expect(callbackFix(null)).toBeNull();
  });

  it('survives a refusal without a reason', () => {
    expect(callbackView({ allowed: false, reason: null, next_allowed_at: null }, 'admin')).toEqual({ kind: 'blocked', reason: null, fix: null, nextAllowedAt: null });
  });
});

describe('canListDnc', () => {
  it('is editor and up, with a number, not already listed', () => {
    expect(canListDnc({ reason: null, to_number: '+14165550123' }, 'editor')).toBe(true);
    expect(canListDnc({ reason: null, to_number: '+14165550123' }, 'viewer')).toBe(false);
    expect(canListDnc({ reason: 'DNC_LISTED', to_number: '+14165550123' }, 'admin')).toBe(false);
    expect(canListDnc({ reason: 'DESTINATION_INVALID', to_number: null }, 'admin')).toBe(false);
  });
});

describe('keepIdempotencyKey', () => {
  const err = (status: number, code: string) => new ApiError(status, { code, message: code });

  it('keeps the key when we cannot tell whether the call was placed', () => {
    expect(keepIdempotencyKey(err(0, 'NETWORK'))).toBe(true);
    expect(keepIdempotencyKey(err(503, 'UPSTREAM_UNAVAILABLE'))).toBe(true);
    expect(keepIdempotencyKey(err(502, 'INTERNAL'))).toBe(true);
    expect(keepIdempotencyKey(err(409, 'OUTBOUND_IN_PROGRESS'))).toBe(true);
  });

  it('takes a new key after a definitive refusal', () => {
    expect(keepIdempotencyKey(err(409, 'DNC_LISTED'))).toBe(false);
    expect(keepIdempotencyKey(err(429, 'OUTBOUND_DAILY_CAP'))).toBe(false);
    expect(keepIdempotencyKey(err(409, 'CONFLICT'))).toBe(false);
    expect(keepIdempotencyKey(new Error('boom'))).toBe(false);
  });
});

describe('callerIdNote', () => {
  it('says how a number was verified, or that support verifies it', () => {
    expect(callerIdNote({ verified: true, verified_via: 'purchase' })).toBe('purchase');
    expect(callerIdNote({ verified: true, verified_via: 'staff' })).toBe('staff');
    expect(callerIdNote({ verified: false, verified_via: null })).toBe('contactSupport');
    expect(callerIdNote({ verified: true, verified_via: null })).toBeNull();
  });
});
