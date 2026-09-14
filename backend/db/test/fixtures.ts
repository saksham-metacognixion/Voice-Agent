import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

/**
 * Every test run gets its own workspaces, so runs do not interfere and nothing has to
 * be torn down — which matters here, because credit_ledger rows cannot be deleted and
 * a tenant that has any is therefore undeletable (that is the point of §17).
 */
export const ownerDb = new PrismaClient({
  datasources: { db: { url: requireEnv('DIRECT_DATABASE_URL') } },
});

/** The runtime connection: a portal_app member, RLS applies. */
export const appDb = new PrismaClient({
  datasources: { db: { url: requireEnv('DATABASE_URL') } },
});

/** The privileged connection: a portal_admin member, crosses workspaces. */
export const adminDb = new PrismaClient({
  datasources: { db: { url: requireEnv('ADMIN_DATABASE_URL') } },
});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Run these through "pnpm --filter @portal/db test:e2e", ` +
        'which loads the root .env.',
    );
  }
  return value;
}

export interface Workspace {
  tenantId: string;
  userId: string;
  agentId: string;
  callId: string;
}

/** Builds one fully populated workspace on the owner connection, bypassing RLS. */
export async function createWorkspace(label: string): Promise<Workspace> {
  const suffix = randomUUID().slice(0, 8);

  const tenant = await ownerDb.tenant.create({
    data: { name: `${label} ${suffix}`, country: 'CA' },
  });
  const user = await ownerDb.user.create({
    data: {
      authProviderId: `auth0|${label}-${suffix}`,
      email: `${label}-${suffix}@example.test`,
      name: `${label} owner`,
    },
  });
  await ownerDb.membership.create({
    data: { tenantId: tenant.id, userId: user.id, role: 'owner' },
  });
  const agent = await ownerDb.agent.create({
    data: { tenantId: tenant.id, name: `${label} receptionist` },
  });
  await ownerDb.agentVersion.create({
    data: { agentId: agent.id, versionNo: 1, source: 'generated', briefJson: { label } },
  });
  const call = await ownerDb.call.create({
    data: {
      id: `call_${label}_${suffix}`,
      tenantId: tenant.id,
      agentId: agent.id,
      channel: 'phone',
      status: 'ended',
      durationS: 120,
      rate: 1.0,
      creditsCharged: 2.0,
    },
  });
  await ownerDb.creditLedger.create({
    data: { tenantId: tenant.id, delta: 20, balanceAfter: 20, reason: 'trial' },
  });

  return { tenantId: tenant.id, userId: user.id, agentId: agent.id, callId: call.id };
}

/**
 * Runs `fn` with the same GUCs withWorkspace() sets at runtime. Pass `userId` for the
 * policies where "my workspace" is not a tight enough answer — see users_update_self.
 */
export async function asWorkspace<T>(
  tenantId: string,
  fn: (tx: PrismaClient) => Promise<T>,
  userId?: string,
): Promise<T> {
  return appDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    if (userId) {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`;
    }
    return fn(tx as unknown as PrismaClient);
  });
}

/** Runs `fn` on the app connection with no workspace in context. */
export async function withNoWorkspace<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  return appDb.$transaction(async (tx) => fn(tx as unknown as PrismaClient));
}
