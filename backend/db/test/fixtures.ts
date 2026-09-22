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
  /** D6/D7 tenant-scoped rows, one of each, for the isolation matrix. */
  knowledgeSourceId: string;
  phonePlanId: string;
  phoneNumberId: string;
  creditLotId: string;
  purchaseId: string;
  invoiceId: string;
  alertId: string;
  notificationId: string;
  jobId: string;
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

  // D6/D7: one row in every tenant-scoped table the later days added.
  const knowledge = await ownerDb.knowledgeSource.create({
    data: { tenantId: tenant.id, agentId: agent.id, type: 'text', name: `${label} faq`, status: 'ready' },
  });
  const plan = await ownerDb.phonePlan.create({
    data: { tenantId: tenant.id, agentId: agent.id, option: 'new', country: 'CA', status: 'executed' },
  });
  const number = await ownerDb.phoneNumber.create({
    data: {
      tenantId: tenant.id,
      agentId: agent.id,
      planId: plan.id,
      e164: `+1450${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`,
      type: 'retell_twilio',
      status: 'active',
      inboundToken: `tok_${randomUUID().replace(/-/g, '')}`,
      country: 'CA',
      nextRentalAt: new Date(Date.now() + 86_400_000),
    },
  });
  const purchase = await ownerDb.purchase.create({
    data: { tenantId: tenant.id, packId: 'starter', amountCents: 4_900, currency: 'USD', credits: 150, status: 'paid', stripeSessionId: `cs_${suffix}_${label}` },
  });
  const lot = await ownerDb.creditLot.create({
    data: { tenantId: tenant.id, purchaseId: purchase.id, creditsTotal: 150, creditsRemaining: 150, expiresAt: new Date(Date.now() + 365 * 86_400_000) },
  });
  const invoice = await ownerDb.invoice.create({
    data: { tenantId: tenant.id, purchaseId: purchase.id, stripeInvoiceId: `in_${suffix}_${label}`, stripeCustomerId: `cus_${suffix}_${label}`, amountCents: 4_900, currency: 'USD', status: 'paid' },
  });
  const alert = await ownerDb.alert.create({
    data: { tenantId: tenant.id, type: 'low_balance', key: 'low_balance:20', threshold: 20, channel: 'in_app' },
  });
  const notification = await ownerDb.notification.create({
    data: { tenantId: tenant.id, userId: user.id, kind: 'low_balance', dedupeKey: `rls:${suffix}:${label}`, channel: 'email', status: 'sent' },
  });
  const job = await ownerDb.job.create({ data: { tenantId: tenant.id, type: 'generate-agent', status: 'succeeded' } });

  return {
    tenantId: tenant.id,
    userId: user.id,
    agentId: agent.id,
    callId: call.id,
    knowledgeSourceId: knowledge.id,
    phonePlanId: plan.id,
    phoneNumberId: number.id,
    creditLotId: lot.id,
    purchaseId: purchase.id,
    invoiceId: invoice.id,
    alertId: alert.id,
    notificationId: notification.id,
    jobId: job.id,
  };
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
