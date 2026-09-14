import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminDb,
  appDb,
  asWorkspace,
  createWorkspace,
  ownerDb,
  withNoWorkspace,
  type Workspace,
} from './fixtures.js';

/**
 * Cross-tenant isolation (§17). These are the tests the D1 exit check names, and they
 * assert the database's behaviour, not the API's — the guard in the API is the first
 * lock, this is the second, and the second is the one that still holds when a service
 * forgets a `where: { tenantId }`.
 */

let acme: Workspace;
let globex: Workspace;

beforeAll(async () => {
  acme = await createWorkspace('acme');
  globex = await createWorkspace('globex');
});

afterAll(async () => {
  await Promise.all([ownerDb.$disconnect(), appDb.$disconnect(), adminDb.$disconnect()]);
});

describe('the app connection is actually RLS-enforced', () => {
  it('connects as a portal_app member that neither owns the tables nor bypasses RLS', async () => {
    const [probe] = await appDb.$queryRaw<
      { bypasses: boolean; superuser: boolean; member: boolean; owns: boolean }[]
    >`
      SELECT
        (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypasses,
        (SELECT rolsuper     FROM pg_roles WHERE rolname = current_user) AS superuser,
        pg_has_role(current_user, 'portal_app', 'member')                AS member,
        pg_get_userbyid(relowner) = current_user                         AS owns
      FROM pg_class WHERE oid = 'public.tenants'::regclass
    `;
    expect(probe).toMatchObject({
      bypasses: false,
      superuser: false,
      member: true,
      owns: false,
    });
  });
});

describe('reads are confined to the workspace in context', () => {
  it('sees its own rows and none of the neighbour’s', async () => {
    const rows = await asWorkspace(acme.tenantId, (db) =>
      db.agent.findMany({ select: { id: true } }),
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(acme.agentId);
    expect(ids).not.toContain(globex.agentId);
  });

  it('cannot reach another workspace’s row even by primary key', async () => {
    const agent = await asWorkspace(acme.tenantId, (db) =>
      db.agent.findUnique({ where: { id: globex.agentId } }),
    );
    expect(agent).toBeNull();
  });

  it('cannot reach another workspace’s calls, ledger or audit log', async () => {
    const found = await asWorkspace(acme.tenantId, async (db) => ({
      call: await db.call.findUnique({ where: { id: globex.callId } }),
      tenant: await db.tenant.findUnique({ where: { id: globex.tenantId } }),
      ledger: await db.creditLedger.count({ where: { tenantId: globex.tenantId } }),
    }));
    expect(found.call).toBeNull();
    expect(found.tenant).toBeNull();
    expect(found.ledger).toBe(0);
  });

  it('hides agent_versions through the parent agent, not a column of its own', async () => {
    const versions = await asWorkspace(acme.tenantId, (db) =>
      db.agentVersion.findMany({ where: { agentId: globex.agentId } }),
    );
    expect(versions).toHaveLength(0);
  });

  it('hides users who have no membership in the workspace', async () => {
    const users = await asWorkspace(acme.tenantId, (db) =>
      db.user.findMany({ select: { id: true } }),
    );
    const ids = users.map((u) => u.id);
    expect(ids).toContain(acme.userId);
    expect(ids).not.toContain(globex.userId);
  });

  it('lets a member read a co-member, which is what GET /members needs', async () => {
    const alsoInA = await ownerDb.user.create({
      data: {
        authProviderId: `auth0|second-${acme.tenantId}`,
        email: `second-${acme.tenantId}@example.test`,
      },
    });
    await ownerDb.membership.create({
      data: { tenantId: acme.tenantId, userId: alsoInA.id, role: 'editor' },
    });

    const ids = (
      await asWorkspace(acme.tenantId, (db) => db.user.findMany({ select: { id: true } }))
    ).map((u) => u.id);
    expect(ids).toEqual(expect.arrayContaining([acme.userId, alsoInA.id]));
  });

  it('sees nothing at all when no workspace is set — the default is deny', async () => {
    const counts = await withNoWorkspace(async (db) => ({
      tenants: await db.tenant.count(),
      agents: await db.agent.count(),
      calls: await db.call.count(),
      users: await db.user.count(),
    }));
    expect(counts).toEqual({ tenants: 0, agents: 0, calls: 0, users: 0 });
  });

  it('does not leak context between transactions on a pooled connection', async () => {
    await asWorkspace(acme.tenantId, (db) => db.agent.count());
    const leaked = await withNoWorkspace((db) => db.agent.count());
    expect(leaked).toBe(0);
  });
});

describe('writes are confined to the workspace in context', () => {
  it('refuses to insert a row belonging to another workspace', async () => {
    await expect(
      asWorkspace(acme.tenantId, (db) =>
        db.agent.create({ data: { tenantId: globex.tenantId, name: 'planted' } }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('silently updates nothing when the target is another workspace', async () => {
    await asWorkspace(acme.tenantId, (db) =>
      db.agent.updateMany({ where: { id: globex.agentId }, data: { name: 'renamed' } }),
    );
    const survivor = await ownerDb.agent.findUniqueOrThrow({ where: { id: globex.agentId } });
    expect(survivor.name).not.toBe('renamed');
  });

  it('silently deletes nothing when the target is another workspace', async () => {
    const removed = await asWorkspace(acme.tenantId, (db) =>
      db.agent.deleteMany({ where: { id: globex.agentId } }),
    );
    expect(removed.count).toBe(0);
    await expect(
      ownerDb.agent.findUniqueOrThrow({ where: { id: globex.agentId } }),
    ).resolves.toBeTruthy();
  });
});

describe('a profile belongs to its owner, not to the workspace', () => {
  it('lets a user edit their own row', async () => {
    await asWorkspace(
      acme.tenantId,
      (db) => db.user.update({ where: { id: acme.userId }, data: { name: 'Renamed by self' } }),
      acme.userId,
    );
    const updated = await ownerDb.user.findUniqueOrThrow({ where: { id: acme.userId } });
    expect(updated.name).toBe('Renamed by self');
  });

  it('refuses to let one member rewrite a co-member’s profile', async () => {
    const coMember = await ownerDb.user.create({
      data: {
        authProviderId: `auth0|colleague-${acme.tenantId}`,
        email: `colleague-${acme.tenantId}@example.test`,
        name: 'Colleague',
      },
    });
    await ownerDb.membership.create({
      data: { tenantId: acme.tenantId, userId: coMember.id, role: 'editor' },
    });

    // Visible — they share a workspace — but not writable.
    const visible = await asWorkspace(
      acme.tenantId,
      (db) => db.user.findUnique({ where: { id: coMember.id } }),
      acme.userId,
    );
    expect(visible).not.toBeNull();

    const changed = await asWorkspace(
      acme.tenantId,
      (db) => db.user.updateMany({ where: { id: coMember.id }, data: { name: 'Hijacked' } }),
      acme.userId,
    );
    expect(changed.count).toBe(0);

    const survivor = await ownerDb.user.findUniqueOrThrow({ where: { id: coMember.id } });
    expect(survivor.name).toBe('Colleague');
  });

  it('refuses every profile write when no user is in context', async () => {
    const changed = await asWorkspace(acme.tenantId, (db) =>
      db.user.updateMany({ where: { id: acme.userId }, data: { name: 'No context' } }),
    );
    expect(changed.count).toBe(0);
  });
});

describe('staff-only tables are out of reach entirely', () => {
  it.each(['staff_users', 'staff_audit_log', 'customer_notes', 'tenant_overrides', 'refunds'])(
    'denies portal_app any access to %s',
    async (table) => {
      await expect(
        withNoWorkspace((db) => db.$queryRawUnsafe(`SELECT 1 FROM "${table}" LIMIT 1`)),
      ).rejects.toThrow(/permission denied/i);
    },
  );

  it('hides internal ticket notes from the customer connection', async () => {
    const ticket = await ownerDb.supportTicket.create({
      data: { tenantId: acme.tenantId, subject: 'Call quality' },
    });
    await ownerDb.ticketMessage.createMany({
      data: [
        { ticketId: ticket.id, authorType: 'customer', body: 'visible to the customer' },
        { ticketId: ticket.id, authorType: 'staff', body: 'staff eyes only', isInternal: true },
      ],
    });

    const visible = await asWorkspace(acme.tenantId, (db) =>
      db.ticketMessage.findMany({ where: { ticketId: ticket.id } }),
    );
    expect(visible.map((m) => m.body)).toEqual(['visible to the customer']);
  });
});

describe('the admin connection crosses workspaces on purpose', () => {
  it('reads both workspaces without setting any context', async () => {
    const ids = (await adminDb.agent.findMany({ select: { id: true } })).map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining([acme.agentId, globex.agentId]));
  });

  it('reads the staff tables the app connection cannot', async () => {
    await expect(adminDb.staffRoleLimit.count()).resolves.toBeGreaterThanOrEqual(0);
  });
});
