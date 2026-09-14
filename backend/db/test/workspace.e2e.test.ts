import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnect, withWorkspace } from '../src/index.js';
import { createWorkspace, ownerDb, type Workspace } from './fixtures.js';

/**
 * withWorkspace() is the only door onto the customer request path, so its two jobs get
 * tested directly: it sets the context RLS reads, and it does not let that context
 * survive the transaction it belongs to.
 */

let acme: Workspace;
let globex: Workspace;

beforeAll(async () => {
  acme = await createWorkspace('scope-a');
  globex = await createWorkspace('scope-b');
});

afterAll(async () => {
  await ownerDb.$disconnect();
  await disconnect();
});

describe('withWorkspace', () => {
  it('scopes reads to the workspace it was given', async () => {
    const names = await withWorkspace(acme.tenantId, (db) =>
      db.agent.findMany({ select: { id: true } }),
    );
    expect(names.map((a) => a.id)).toEqual([acme.agentId]);
  });

  it('accepts the request context object as well as a bare id', async () => {
    const rows = await withWorkspace({ workspaceId: acme.tenantId, userId: acme.userId }, (db) =>
      db.user.findMany({ select: { id: true } }),
    );
    expect(rows.map((u) => u.id)).toEqual([acme.userId]);
  });

  it('sets app.user_id only when a user is given', async () => {
    const [withUser] = await withWorkspace(
      { workspaceId: acme.tenantId, userId: acme.userId },
      (db) => db.$queryRaw<{ u: string | null }[]>`SELECT app.current_user_id()::text AS u`,
    );
    const [withoutUser] = await withWorkspace(
      acme.tenantId,
      (db) => db.$queryRaw<{ u: string | null }[]>`SELECT app.current_user_id()::text AS u`,
    );
    expect(withUser?.u).toBe(acme.userId);
    expect(withoutUser?.u).toBeNull();
  });

  it('does not leak context into the next transaction on the same pool', async () => {
    await withWorkspace(acme.tenantId, (db) => db.agent.count());
    const leaked = await withWorkspace(globex.tenantId, (db) =>
      db.agent.findMany({ select: { id: true } }),
    );
    expect(leaked.map((a) => a.id)).toEqual([globex.agentId]);
  });

  it('rolls the whole transaction back when the callback throws', async () => {
    await expect(
      withWorkspace(acme.tenantId, async (db) => {
        await db.agent.create({ data: { tenantId: acme.tenantId, name: 'doomed' } });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const survivors = await ownerDb.agent.count({ where: { tenantId: acme.tenantId } });
    expect(survivors).toBe(1);
  });

  it.each([
    ['not a uuid', 'workspace-1'],
    ['an empty string', ''],
    ['a SQL fragment', "' OR '1'='1"],
  ])('refuses %s rather than passing it to set_config', async (_label, id) => {
    await expect(withWorkspace(id, async (db) => db.agent.count())).rejects.toThrow(
      /is not a workspace id/,
    );
  });

  it('refuses a malformed user id too', async () => {
    await expect(
      withWorkspace({ workspaceId: acme.tenantId, userId: 'me' }, async (db) => db.agent.count()),
    ).rejects.toThrow(/is not a user id/);
  });
});

describe('notification settings', () => {
  it('allows exactly one workspace-level default row', async () => {
    await ownerDb.notificationSetting.create({ data: { tenantId: acme.tenantId } });
    await expect(
      ownerDb.notificationSetting.create({ data: { tenantId: acme.tenantId } }),
    ).rejects.toThrow(/notification_settings_workspace_default_idx|Unique constraint/i);
  });

  it('still allows one per-user row alongside it', async () => {
    await expect(
      ownerDb.notificationSetting.create({
        data: { tenantId: acme.tenantId, userId: acme.userId },
      }),
    ).resolves.toBeTruthy();
  });
});
