import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * §6.2 "MFA required for Owner/Admin once auto top-up is enabled or balance > threshold"
 * (ADR 0036). Postgres (`adminDb`), Redis (`RedisCache`) and the pricing config are
 * replaced; the service's reading of them and the rule's answer are what is asserted.
 */

const db = vi.hoisted(() => ({
  tenant: { findUnique: vi.fn() },
  creditLedger: { aggregate: vi.fn() },
}));
vi.mock('@portal/db', () => ({ adminDb: db }));

import { WorkspaceMfaService } from './workspace-mfa.service';

const WS = 'ws-1';
const THRESHOLD = 1_000;

function service(cached: string | null) {
  const cache = { get: vi.fn().mockResolvedValue(cached) };
  const config = { walletPolicy: vi.fn().mockResolvedValue({ policy: { mfa_required_above_balance: THRESHOLD } }) };
  return { mfa: new WorkspaceMfaService(cache as never, config as never), cache };
}

function ledgerSum(value: number | null) {
  db.creditLedger.aggregate.mockResolvedValue({ _sum: { delta: value === null ? null : { toNumber: () => value } } });
}

beforeEach(() => {
  db.tenant.findUnique.mockReset().mockResolvedValue({ autoTopupJson: null });
  db.creditLedger.aggregate.mockReset();
});

describe('WorkspaceMfaService.state', () => {
  it('reads the balance from bal:{ws} and never touches the ledger on a hit', async () => {
    const { mfa, cache } = service('250.5');
    await expect(mfa.state(WS)).resolves.toEqual({ balance: 250.5, autoTopupEnabled: false, threshold: THRESHOLD });
    expect(cache.get).toHaveBeenCalledWith(expect.stringContaining(WS));
    expect(db.creditLedger.aggregate).not.toHaveBeenCalled();
  });

  it('falls back to the ledger sum, rounded to 2 decimals, on a miss or a non-numeric cache value', async () => {
    ledgerSum(12.345);
    await expect(service(null).mfa.state(WS)).resolves.toMatchObject({ balance: 12.35 });
    await expect(service('garbage').mfa.state(WS)).resolves.toMatchObject({ balance: 12.35 });
  });

  it('an empty ledger is a zero balance', async () => {
    ledgerSum(null);
    await expect(service(null).mfa.state(WS)).resolves.toMatchObject({ balance: 0 });
  });

  it.each([
    [{ enabled: true }, true],
    [{ enabled: false }, false],
    [{ enabled: 'true' }, false],
    [null, false],
    ['on', false],
  ])('auto top-up %j reads as enabled=%s', async (json, expected) => {
    db.tenant.findUnique.mockResolvedValue({ autoTopupJson: json });
    await expect(service('0').mfa.state(WS)).resolves.toMatchObject({ autoTopupEnabled: expected });
  });

  it('a missing tenant row reads as auto top-up off', async () => {
    db.tenant.findUnique.mockResolvedValue(null);
    await expect(service('0').mfa.state(WS)).resolves.toMatchObject({ autoTopupEnabled: false });
  });
});

describe('WorkspaceMfaService.assert', () => {
  it('a session that passed a factor is never refused and reads nothing', async () => {
    const { mfa, cache } = service('99999');
    await expect(mfa.assert({ workspaceId: WS, role: 'owner', mfa: true })).resolves.toBeUndefined();
    expect(cache.get).not.toHaveBeenCalled();
  });

  it('balance at the threshold is not "over" it; one cent above is', async () => {
    await expect(service(String(THRESHOLD)).mfa.assert({ workspaceId: WS, role: 'owner', mfa: false })).resolves.toBeUndefined();
    await expect(service(String(THRESHOLD + 0.01)).mfa.assert({ workspaceId: WS, role: 'owner', mfa: false })).rejects.toMatchObject({
      code: 'MFA_REQUIRED',
      message: expect.stringContaining('balance is high'),
    });
  });

  it('auto top-up on refuses an admin with the auto top-up message', async () => {
    db.tenant.findUnique.mockResolvedValue({ autoTopupJson: { enabled: true } });
    await expect(service('5').mfa.assert({ workspaceId: WS, role: 'admin', mfa: false })).rejects.toMatchObject({
      code: 'MFA_REQUIRED',
      message: expect.stringContaining('auto top-up'),
    });
  });

  it.each(['editor', 'viewer'] as const)('never refuses an %s, whatever the money', async (role) => {
    db.tenant.findUnique.mockResolvedValue({ autoTopupJson: { enabled: true } });
    await expect(service('99999').mfa.assert({ workspaceId: WS, role, mfa: false })).resolves.toBeUndefined();
  });

  it('refuses the request that would put money at risk (the `next` state), not only later ones', async () => {
    const { mfa } = service('10');
    await expect(mfa.assert({ workspaceId: WS, role: 'owner', mfa: false })).resolves.toBeUndefined();
    await expect(mfa.assert({ workspaceId: WS, role: 'owner', mfa: false }, { autoTopupEnabled: true })).rejects.toMatchObject({
      code: 'MFA_REQUIRED',
      message: expect.stringContaining('auto top-up'),
    });
    await expect(mfa.assert({ workspaceId: WS, role: 'owner', mfa: false }, { balance: THRESHOLD + 500 })).rejects.toMatchObject({
      code: 'MFA_REQUIRED',
    });
  });

  it('describe() reports required, satisfied and the reasons', async () => {
    db.tenant.findUnique.mockResolvedValue({ autoTopupJson: { enabled: true } });
    await expect(service(String(THRESHOLD * 2)).mfa.describe(WS, 'owner', false)).resolves.toEqual({
      required: true,
      satisfied: false,
      reasons: ['auto_topup', 'balance'],
    });
    await expect(service(String(THRESHOLD * 2)).mfa.describe(WS, 'viewer', false)).resolves.toEqual({
      required: false,
      satisfied: false,
      reasons: [],
    });
  });
});
