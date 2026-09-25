import { describe, expect, it } from 'vitest';
import { walletFrame } from './wallet-frame';

describe('walletFrame', () => {
  it('reads the balance from a ledger frame, to two decimals', () => {
    expect(walletFrame({ topic: 'wallet', type: 'ledger', data: { delta: -1.2, balance_after: 312.404, reason: 'call', ref_id: 'c1' } })).toEqual({ balanceAfter: 312.4, delta: -1.2, reason: 'call' });
  });

  it('keeps a negative balance (the grace overdraft)', () => {
    expect(walletFrame({ topic: 'wallet', type: 'ledger', data: { delta: -3, balance_after: -2.5 } })?.balanceAfter).toBe(-2.5);
  });

  it('refuses anything that is not a well-formed ledger frame', () => {
    expect(walletFrame({ topic: 'wallet', type: 'other', data: { balance_after: 1 } })).toBeNull();
    expect(walletFrame({ topic: 'alerts', type: 'ledger', data: { balance_after: 1 } })).toBeNull();
    expect(walletFrame({ topic: 'wallet', type: 'ledger', data: null })).toBeNull();
    expect(walletFrame({ topic: 'wallet', type: 'ledger', data: [1] })).toBeNull();
    expect(walletFrame({ topic: 'wallet', type: 'ledger', data: { balance_after: '12.00' } })).toBeNull();
    expect(walletFrame({ topic: 'wallet', type: 'ledger', data: { balance_after: Number.NaN } })).toBeNull();
    expect(walletFrame({ topic: 'wallet', type: 'ledger', data: { balance_after: Number.POSITIVE_INFINITY } })).toBeNull();
  });

  it('tolerates a missing delta', () => {
    expect(walletFrame({ topic: 'wallet', type: 'ledger', data: { balance_after: 5 } })).toEqual({ balanceAfter: 5, delta: 0, reason: null });
  });
});
