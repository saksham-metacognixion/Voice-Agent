import { randomUUID } from 'node:crypto';
import { adminDb } from '@portal/db';
import { PlatformConfigService } from '../src/modules/config';
import { RedisCache, createRedisClient } from '../src/modules/redis';
import { WalletService } from '../src/modules/wallet';

/**
 * Shared plumbing for the money e2e suites. Real Postgres (the two roles, migrations
 * applied, `pnpm db:seed` run so pricing_configs v1 exists) and real Redis from REDIS_URL.
 *
 * Every suite makes its own workspaces and never deletes them: credit_ledger rows cannot be
 * deleted, which makes a tenant with any undeletable — that is the point of §17.
 */
export function moneyServices() {
  const redis = createRedisClient(process.env.REDIS_URL);
  const cache = new RedisCache(redis);
  const config = new PlatformConfigService(cache);
  const wallet = new WalletService(cache, config);
  return { redis, cache, config, wallet };
}

export async function createWorkspace(label: string): Promise<{ tenantId: string; userId: string; email: string }> {
  const run = randomUUID().slice(0, 8);
  const tenant = await adminDb.tenant.create({ data: { name: `${label} ${run}`, country: 'CA' } });
  const email = `${label}-${run}@example.test`;
  const user = await adminDb.user.create({
    data: { authProviderId: `auth0|${label}-${run}`, email, name: label },
  });
  await adminDb.membership.create({ data: { tenantId: tenant.id, userId: user.id, role: 'owner' } });
  return { tenantId: tenant.id, userId: user.id, email };
}

/** Σ delta straight from Postgres — the truth the cache must agree with. */
export async function ledgerSum(tenantId: string): Promise<number> {
  const agg = await adminDb.creditLedger.aggregate({ where: { tenantId }, _sum: { delta: true } });
  return agg._sum.delta?.toNumber() ?? 0;
}

export function inMonths(months: number): Date {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}
