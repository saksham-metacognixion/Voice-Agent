import { adminDb, isAppendOnlyViolation } from '@portal/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redisKeys } from '../src/modules/redis';
import type { WorkspaceContext } from '../src/modules/auth';
import { BALANCE_TTL_S, DuplicateCallDebit } from '../src/modules/wallet';
import { computeCharge } from '../src/modules/calls/metering';
import { createWorkspace, inMonths, ledgerSum, moneyServices } from './money-fixtures';

/*
 * The wallet module's money rules against real Postgres and Redis (§5.4, §14.2, §17):
 * append-only ledger, FIFO by expires_at, grace overdraft, idempotent call debits,
 * and a balance cache that is rebuilt from the ledger rather than trusted.
 */

const svc = moneyServices();

afterAll(async () => {
  await svc.redis.quit();
  await adminDb.$disconnect();
});

describe('ledger writes', () => {
  let ws = '';
  beforeAll(async () => {
    ws = (await createWorkspace('wallet')).tenantId;
  });

  it('grant creates a lot and a positive ledger row; balance_after runs', async () => {
    const a = await svc.wallet.grant(ws, { credits: 150, reason: 'purchase', expiresAt: inMonths(12), refType: 'test', refId: 'p1' });
    expect(a).toMatchObject({ delta: 150, balance_after: 150, reason: 'purchase', duplicate: false });
    expect(a.lot_id).toBeTruthy();

    const b = await svc.wallet.grant(ws, { credits: 20.5, reason: 'adjustment', expiresAt: inMonths(12) });
    expect(b.balance_after).toBe(170.5);
    expect(await ledgerSum(ws)).toBe(170.5);
  });

  it('the ledger is append-only for both roles — the trigger, not just the grant', async () => {
    const row = await adminDb.creditLedger.findFirstOrThrow({ where: { tenantId: ws } });
    // portal_admin has UPDATE/DELETE revoked; even if a grant slipped, the trigger stops it.
    await expect(adminDb.creditLedger.update({ where: { id: row.id }, data: { delta: 999 } })).rejects.toSatisfy(
      (e: unknown) => isAppendOnlyViolation(e) || /permission denied|append_only/i.test(String((e as Error).message)),
    );
    await expect(adminDb.creditLedger.delete({ where: { id: row.id } })).rejects.toThrow();
    await expect(adminDb.$executeRawUnsafe(`DELETE FROM credit_ledger WHERE tenant_id = '${ws}'`)).rejects.toThrow();
  });

  it('refuses a non-positive grant or debit rather than writing a zero row', async () => {
    await expect(svc.wallet.grant(ws, { credits: 0, reason: 'purchase', expiresAt: inMonths(1) })).rejects.toThrow(/positive/);
    await expect(svc.wallet.debit(ws, { credits: -1, reason: 'rental' })).rejects.toThrow(/positive/);
  });
});

describe('FIFO lot consumption by expires_at', () => {
  let ws = '';
  let soon = '';
  let later = '';
  let latest = '';

  beforeAll(async () => {
    ws = (await createWorkspace('fifo')).tenantId;
    // Created out of order on purpose: FIFO is by expiry, not by creation.
    latest = (await svc.wallet.grant(ws, { credits: 100, reason: 'purchase', expiresAt: inMonths(12) })).lot_id!;
    soon = (await svc.wallet.grant(ws, { credits: 4, reason: 'adjustment', expiresAt: inMonths(1) })).lot_id!;
    later = (await svc.wallet.grant(ws, { credits: 10, reason: 'purchase', expiresAt: inMonths(6) })).lot_id!;
  });

  async function remaining(id: string): Promise<number> {
    return (await adminDb.creditLot.findUniqueOrThrow({ where: { id } })).creditsRemaining.toNumber();
  }

  it('burns the soonest-expiring lot first and spills into the next', async () => {
    const write = await svc.wallet.debit(ws, { credits: 5.5, reason: 'rental', refType: 'number', refId: 'n1' });
    expect(write.delta).toBe(-5.5);
    expect(write.balance_after).toBe(108.5);
    expect(write.lot_id).toBe(soon);
    expect(await remaining(soon)).toBe(0);
    expect(await remaining(later)).toBe(8.5);
    expect(await remaining(latest)).toBe(100);
  });

  it('overdraws into the grace allowance when the lots run out, and the next grant settles it first', async () => {
    await svc.wallet.debit(ws, { credits: 112, reason: 'kb' }); // 108.5 available → −3.5
    expect(await ledgerSum(ws)).toBe(-3.5);
    expect(await remaining(later)).toBe(0);
    expect(await remaining(latest)).toBe(0);

    const topup = await svc.wallet.grant(ws, { credits: 50, reason: 'purchase', expiresAt: inMonths(12) });
    expect(topup.delta).toBe(50); // the ledger records the full purchase
    expect(topup.balance_after).toBe(46.5);
    expect(await remaining(topup.lot_id!)).toBe(46.5); // the lot is short by the overdraft
  });

  it('expires lapsed lots into negative expiry rows', async () => {
    const lapsed = await svc.wallet.grant(ws, { credits: 7, reason: 'adjustment', expiresAt: new Date(Date.now() + 500) });
    await new Promise((r) => setTimeout(r, 600));
    const before = await ledgerSum(ws);
    const rows = await svc.wallet.expireLots(ws);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ delta: -7, reason: 'expiry', lot_id: lapsed.lot_id });
    expect(await ledgerSum(ws)).toBe(before - 7);
    expect(await remaining(lapsed.lot_id!)).toBe(0);
    expect(await svc.wallet.expireLots(ws)).toEqual([]);
  });
});

describe('a lapsed lot is written off before it can be charged twice', () => {
  it('spends against a lot that lapsed before the expiry job ran without double-deducting', async () => {
    const ws = (await createWorkspace('lapse')).tenantId;
    await svc.wallet.grant(ws, { credits: 100, reason: 'purchase', expiresAt: new Date(Date.now() + 500) });
    await new Promise((r) => setTimeout(r, 600));

    // The lot has lapsed but no job has swept it. The debit writes it off first, so the
    // call is charged once against a wallet that is already empty, not once here and
    // again when the sweep lands.
    const write = await svc.wallet.debit(ws, { credits: 10, reason: 'call', refType: 'call', refId: `call_lapse_${ws.slice(0, 8)}` });
    expect(write.delta).toBe(-10);
    expect(await ledgerSum(ws)).toBe(-10);

    // Nothing left for the job to find, and running it changes no money.
    expect(await svc.wallet.expireLots(ws)).toEqual([]);
    expect(await ledgerSum(ws)).toBe(-10);

    const rows = await adminDb.creditLedger.findMany({ where: { tenantId: ws }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => r.reason)).toEqual(['purchase', 'expiry', 'call']);
  });
});

describe('call debits are idempotent on call_id (§14.2)', () => {
  let ws = '';
  beforeAll(async () => {
    ws = (await createWorkspace('meter')).tenantId;
    await svc.wallet.grant(ws, { credits: 20, reason: 'trial', expiresAt: inMonths(1) });
  });

  it('a real fixture call debits once; the replay returns the same row and moves nothing', async () => {
    const callId = `call_e2e_${ws.slice(0, 8)}`;
    const charge = computeCharge({ call_status: 'ended', start_timestamp: 1789450193999, end_timestamp: 1789450269548, disconnection_reason: 'user_hangup' }, 1.0);
    expect(charge.credits).toBe(1.26);

    const first = await svc.wallet.debitCall(ws, callId, charge.credits);
    expect(first).toMatchObject({ delta: -1.26, balance_after: 18.74, duplicate: false, ref_id: callId });

    const replay = await svc.wallet.debitCall(ws, callId, charge.credits);
    expect(replay).toMatchObject({ id: first.id, duplicate: true, balance_after: 18.74 });

    expect(await adminDb.creditLedger.count({ where: { reason: 'call', refId: callId } })).toBe(1);
    expect(await ledgerSum(ws)).toBe(18.74);
  });

  it('two concurrent debits for one call cannot both land', async () => {
    const callId = `call_race_${ws.slice(0, 8)}`;
    const results = await Promise.allSettled([
      svc.wallet.debitCall(ws, callId, 2),
      svc.wallet.debitCall(ws, callId, 2),
      svc.wallet.debitCall(ws, callId, 2),
    ]);
    const landed = results.filter((r) => r.status === 'fulfilled' && !r.value.duplicate);
    const noops = results.filter((r) => (r.status === 'fulfilled' && r.value.duplicate) || (r.status === 'rejected' && r.reason instanceof DuplicateCallDebit));
    expect(landed).toHaveLength(1);
    expect(noops).toHaveLength(2);
    expect(await adminDb.creditLedger.count({ where: { reason: 'call', refId: callId } })).toBe(1);
    expect(await ledgerSum(ws)).toBe(16.74);
  });

  it('the metered debit is within ±5 % of duration × rate (the D3 exit check), here exactly', async () => {
    const callId = `call_pct_${ws.slice(0, 8)}`;
    const durationMs = 60_004;
    const rate = 1.5;
    const charge = computeCharge({ call_status: 'ended', start_timestamp: 0, end_timestamp: durationMs, disconnection_reason: 'max_duration_reached' }, rate);
    const write = await svc.wallet.debitCall(ws, callId, charge.credits);
    const expected = (durationMs / 60_000) * rate;
    expect(Math.abs(-write.delta - expected) / expected).toBeLessThan(0.05);
    expect(-write.delta).toBe(1.5);
  });
});

describe('bal:{ws} cache', () => {
  let ws = '';
  let ctx: WorkspaceContext;
  beforeAll(async () => {
    const created = await createWorkspace('cache');
    ws = created.tenantId;
    ctx = { userId: created.userId, workspaceId: ws, role: 'owner' };
  });

  it('is written on every ledger write and read back without touching the ledger', async () => {
    await svc.wallet.grant(ws, { credits: 12.34, reason: 'trial', expiresAt: inMonths(1) });
    expect(await svc.redis.get(redisKeys.balance(ws))).toBe('12.34');
    expect(await svc.wallet.balance(ws)).toBe(12.34);
  });

  it('is rebuilt from the ledger when missing or wrong — the ledger is the truth', async () => {
    await svc.redis.del(redisKeys.balance(ws));
    expect(await svc.wallet.balance(ws)).toBe(12.34);
    expect(await svc.redis.get(redisKeys.balance(ws))).toBe('12.34');

    await svc.redis.set(redisKeys.balance(ws), '999.99');
    expect(await svc.wallet.rebuildBalance(ws)).toBe(12.34);
    expect(await svc.redis.get(redisKeys.balance(ws))).toBe('12.34');

    await svc.redis.set(redisKeys.balance(ws), 'not-a-number');
    expect(await svc.wallet.balance(ws)).toBe(12.34);
  });

  it('a fresh workspace with no ledger has balance 0', async () => {
    const empty = (await createWorkspace('empty')).tenantId;
    expect(await svc.wallet.balance(empty)).toBe(0);
  });

  it('carries a TTL, so a value that outlives its writer cannot be believed forever', async () => {
    const ttl = await svc.redis.ttl(redisKeys.balance(ws));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(BALANCE_TTL_S);
  });

  it('never publishes a balance a rolled-back transaction only imagined', async () => {
    const rolled = (await createWorkspace('rollback')).tenantId;
    await svc.wallet.grant(rolled, { credits: 5, reason: 'trial', expiresAt: inMonths(1) });
    expect(await svc.redis.get(redisKeys.balance(rolled))).toBe('5.00');

    await expect(
      svc.wallet.withWallet(rolled, async (_tx, wallet) => {
        await wallet.grant({ credits: 95, reason: 'purchase', expiresAt: inMonths(12) });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // The key is published while the lock is still held, on the way out of a callback that
    // returned — so a callback that threw never reaches it and the cache still holds the
    // balance the ledger actually has, not the 100 the abandoned grant would have made.
    expect(await svc.redis.get(redisKeys.balance(rolled))).toBe('5.00');
    expect(await svc.wallet.balance(rolled)).toBe(5);
    expect(await ledgerSum(rolled)).toBe(5);
    expect(await adminDb.creditLot.count({ where: { tenantId: rolled } })).toBe(1);
  });

  it('a rebuild that races an in-flight debit waits for its commit rather than putting the old balance back', async () => {
    const raced = (await createWorkspace('rebuild-race')).tenantId;
    await svc.wallet.grant(raced, { credits: 100, reason: 'purchase', expiresAt: inMonths(12) });
    await svc.redis.del(redisKeys.balance(raced));

    // A debit that has written its row and published 90, but is holding the lock open.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const debit = svc.wallet.withWallet(raced, async (_tx, wallet) => {
      await wallet.debit({ credits: 10, reason: 'kb', refType: 'kb', refId: 'kb_race' });
      await held;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));

    // An unlocked rebuild would sum 100 now (the −10 is uncommitted) and, once the debit
    // committed, overwrite its 90 with a stale-high 100. Under the lock it has to wait.
    const rebuild = svc.wallet.rebuildBalance(raced);
    const whileHeld = await Promise.race([rebuild.then(() => 'resolved'), new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 300))]);
    expect(whileHeld).toBe('blocked');

    release();
    await debit;
    expect(await rebuild).toBe(90);
    expect(await svc.redis.get(redisKeys.balance(raced))).toBe('90.00');
    expect(await ledgerSum(raced)).toBe(90);
  });

  it('GET /wallet fills a missing cache entry but never overwrites one a writer published', async () => {
    await svc.redis.del(redisKeys.balance(ws));
    expect((await svc.wallet.summary(ctx)).balance).toBe(12.34);
    expect(await svc.redis.get(redisKeys.balance(ws))).toBe('12.34');

    // Stand in for a debit that committed and published between summary's read and its write.
    await svc.redis.set(redisKeys.balance(ws), '7.00');
    expect((await svc.wallet.summary(ctx)).balance).toBe(12.34); // the response is the ledger truth
    expect(await svc.redis.get(redisKeys.balance(ws))).toBe('7.00'); // the cache keeps the writer's value
  });

  it('publishes in commit order when debits race, so the last value is the real balance', async () => {
    const raced = (await createWorkspace('race')).tenantId;
    await svc.wallet.grant(raced, { credits: 100, reason: 'purchase', expiresAt: inMonths(12) });

    // Ten debits at once. The advisory lock serialises them; publishing inside it means
    // the key can only ever move forward with the commits, never land backwards.
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        svc.wallet.debit(raced, { credits: 1, reason: 'call', refType: 'call', refId: `call_race_${raced.slice(0, 8)}_${i}` }),
      ),
    );

    expect(await ledgerSum(raced)).toBe(90);
    expect(await svc.redis.get(redisKeys.balance(raced))).toBe('90.00');
  });
});

describe('grantTrial', () => {
  it('grants the policy amount once and never twice', async () => {
    const ws = (await createWorkspace('trial')).tenantId;
    const first = await svc.wallet.grantTrial(ws);
    const { policy } = await svc.config.walletPolicy();
    expect(first).toMatchObject({ delta: policy.trial_credits, reason: 'trial' });
    expect(await svc.wallet.grantTrial(ws)).toBeNull();
    expect(await ledgerSum(ws)).toBe(policy.trial_credits);
    const lot = await adminDb.creditLot.findFirstOrThrow({ where: { tenantId: ws } });
    expect(lot.policyVersion).toBeGreaterThanOrEqual(1);
    expect(lot.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(policy.trial_validity_days * 86_400_000 + 5_000);
  });
});
