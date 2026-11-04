import { describe, expect, it } from 'vitest';
import { SIGN_IN_BLOCK_MS, auditActionForLog, signInBlockLift } from './auth-log-events';

describe('signInBlockLift (ADR 0036 §8, §6.2 "5 failures / 15 min")', () => {
  const blockedAt = Date.parse('2026-11-04T10:00:00.000Z');
  const entry = (data: Record<string, unknown>) => ({ log_id: 'log-1', data: { type: 'limit_wc', date: '2026-11-04T10:00:00.000Z', ...data } });

  it('lifts a brute-force block 15 minutes after it was set', () => {
    expect(signInBlockLift(entry({ user_id: 'auth0|abc' }), blockedAt)).toEqual({ logId: 'log-1', sub: 'auth0|abc', identifier: null, delayMs: SIGN_IN_BLOCK_MS });
    expect(SIGN_IN_BLOCK_MS).toBe(900_000);
  });

  it('counts from the block, so a late delivery does not lengthen it', () => {
    expect(signInBlockLift(entry({ user_id: 'auth0|abc' }), blockedAt + 10 * 60_000)?.delayMs).toBe(5 * 60_000);
    expect(signInBlockLift(entry({ user_id: 'auth0|abc' }), blockedAt + 20 * 60_000)?.delayMs).toBe(0);
  });

  it('falls back to the address typed when the log names no user', () => {
    expect(signInBlockLift(entry({ user_id: '', user_name: ' Owner@Example.com ' }), blockedAt)).toMatchObject({ sub: null, identifier: 'owner@example.com' });
  });

  it('counts an unreadable date from now', () => {
    expect(signInBlockLift(entry({ user_id: 'auth0|abc', date: 'nonsense' }), blockedAt)?.delayMs).toBe(SIGN_IN_BLOCK_MS);
  });

  it('lifts nothing else: other types, or a block naming nobody', () => {
    expect(signInBlockLift({ log_id: 'l', data: { type: 'limit_sul', user_id: 'auth0|abc' } })).toBeNull();
    expect(signInBlockLift({ log_id: 'l', data: { type: 'f', user_id: 'auth0|abc' } })).toBeNull();
    expect(signInBlockLift(entry({ user_id: null, user_name: null }), blockedAt)).toBeNull();
  });
});

describe('auditActionForLog (ADR 0036 §9)', () => {
  it('records sign-ins, failures, second-factor outcomes and blocks', () => {
    expect(auditActionForLog('s')).toBe('auth.signed_in');
    expect(auditActionForLog('fp')).toBe('auth.sign_in_failed');
    expect(auditActionForLog('limit_wc')).toBe('auth.sign_in_blocked');
    expect(auditActionForLog('gd_auth_succeed')).toBe('auth.mfa_passed');
    expect(auditActionForLog('gd_auth_failed')).toBe('auth.mfa_failed');
    expect(auditActionForLog('scp')).toBe('auth.password_changed');
    expect(auditActionForLog('slo')).toBe('auth.signed_out');
  });

  it('drops token exchanges and anything unknown', () => {
    expect(auditActionForLog('sertft')).toBeNull();
    expect(auditActionForLog('seacft')).toBeNull();
    expect(auditActionForLog('ssa')).toBeNull();
    expect(auditActionForLog('toString')).toBeNull();
    expect(auditActionForLog('')).toBeNull();
  });
});
