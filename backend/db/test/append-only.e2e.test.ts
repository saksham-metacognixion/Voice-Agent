import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminDb,
  appDb,
  asWorkspace,
  createWorkspace,
  ownerDb,
  type Workspace,
} from './fixtures.js';

/**
 * credit_ledger, audit_log and staff_audit_log are append-only (§17, admin §10),
 * enforced twice: REVOKE for the app roles and a trigger for everyone else. The trigger
 * is what still stands when someone opens psql as the owner at 2am.
 */

let ws: Workspace;

beforeAll(async () => {
  ws = await createWorkspace('ledger');
});

afterAll(async () => {
  await Promise.all([ownerDb.$disconnect(), appDb.$disconnect(), adminDb.$disconnect()]);
});

describe('credit_ledger', () => {
  it('accepts new rows from the customer path', async () => {
    const row = await asWorkspace(ws.tenantId, (db) =>
      db.creditLedger.create({
        data: {
          tenantId: ws.tenantId,
          delta: -1.5,
          balanceAfter: 18.5,
          reason: 'call',
          refId: `call_${ws.tenantId}`,
        },
      }),
    );
    expect(row.delta.toString()).toBe('-1.5');
  });

  it('refuses UPDATE from the app connection', async () => {
    await expect(
      asWorkspace(ws.tenantId, (db) =>
        db.creditLedger.updateMany({ where: { tenantId: ws.tenantId }, data: { delta: 9999 } }),
      ),
    ).rejects.toThrow(/permission denied|append_only_violation/i);
  });

  it('refuses DELETE from the app connection', async () => {
    await expect(
      asWorkspace(ws.tenantId, (db) =>
        db.creditLedger.deleteMany({ where: { tenantId: ws.tenantId } }),
      ),
    ).rejects.toThrow(/permission denied|append_only_violation/i);
  });

  it('refuses UPDATE from the privileged admin connection too', async () => {
    await expect(
      adminDb.creditLedger.updateMany({ where: { tenantId: ws.tenantId }, data: { delta: 9999 } }),
    ).rejects.toThrow(/permission denied|append_only_violation/i);
  });

  it('refuses UPDATE even from the schema owner — the trigger, not the grant', async () => {
    await expect(
      ownerDb.$executeRawUnsafe(
        `UPDATE credit_ledger SET delta = 9999 WHERE tenant_id = '${ws.tenantId}'`,
      ),
    ).rejects.toThrow(/append_only_violation/i);
  });

  it('refuses DELETE even from the schema owner', async () => {
    await expect(
      ownerDb.$executeRawUnsafe(`DELETE FROM credit_ledger WHERE tenant_id = '${ws.tenantId}'`),
    ).rejects.toThrow(/append_only_violation/i);
  });

  it('debits a given call exactly once, however many times call_ended arrives', async () => {
    const callId = `call_replay_${ws.tenantId}`;
    const debit = () =>
      adminDb.creditLedger.create({
        data: { tenantId: ws.tenantId, delta: -2, balanceAfter: 16, reason: 'call', refId: callId },
      });

    await expect(debit()).resolves.toBeTruthy();
    await expect(debit()).rejects.toThrow(/credit_ledger_call_debit_once_idx|Unique constraint/i);

    const debits = await adminDb.creditLedger.count({ where: { reason: 'call', refId: callId } });
    expect(debits).toBe(1);
  });

  it('leaves room for many non-call movements, which are not deduplicated', async () => {
    await expect(
      adminDb.creditLedger.create({
        data: {
          tenantId: ws.tenantId,
          delta: -15,
          balanceAfter: 1,
          reason: 'rental',
          refId: 'num_1',
        },
      }),
    ).resolves.toBeTruthy();
    await expect(
      adminDb.creditLedger.create({
        data: {
          tenantId: ws.tenantId,
          delta: -15,
          balanceAfter: -14,
          reason: 'rental',
          refId: 'num_1',
        },
      }),
    ).resolves.toBeTruthy();
  });
});

describe('audit_log', () => {
  it('accepts inserts and refuses rewrites', async () => {
    await asWorkspace(ws.tenantId, (db) =>
      db.auditLog.create({
        data: { tenantId: ws.tenantId, action: 'agent.published', targetType: 'agent' },
      }),
    );
    await expect(
      ownerDb.$executeRawUnsafe(
        `UPDATE audit_log SET action = 'nothing.happened' WHERE tenant_id = '${ws.tenantId}'`,
      ),
    ).rejects.toThrow(/append_only_violation/i);
  });
});

describe('staff_audit_log', () => {
  it('refuses rewrites from every connection', async () => {
    const staff = await adminDb.staffUser.create({
      data: {
        authProviderId: `auth0|staff-${ws.tenantId}`,
        email: `staff-${ws.tenantId}@metacognixion.test`,
        role: 'ops',
      },
    });
    await adminDb.staffAuditLog.create({
      data: {
        staffId: staff.id,
        tenantId: ws.tenantId,
        action: 'tenant.paused',
        reasonCode: 'abuse_policy',
      },
    });

    await expect(
      adminDb.staffAuditLog.updateMany({ where: { staffId: staff.id }, data: { note: 'edited' } }),
    ).rejects.toThrow(/permission denied|append_only_violation/i);
    await expect(
      ownerDb.$executeRawUnsafe(`DELETE FROM staff_audit_log WHERE staff_id = '${staff.id}'`),
    ).rejects.toThrow(/append_only_violation/i);
  });
});
