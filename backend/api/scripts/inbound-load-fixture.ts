/**
 * Sets up (or tears down) the workspace the k6 inbound load test aims at.
 *
 *   pnpm --filter @portal/api load:setup      → prints the env k6 needs
 *   pnpm --filter @portal/api load:reset      → frees the slots a previous run reserved
 *   pnpm --filter @portal/api load:teardown   → pauses the number so it stops answering
 *
 * The workspace is a real one: a live agent, an active number with an inbound token, a
 * generous concurrency override and enough credits that the six checks all pass. What k6
 * then measures is the real §13.9 path, not a stub.
 */
import { randomUUID } from 'node:crypto';
import { adminDb, disconnect } from '@portal/db';
import { PlatformConfigService } from '../src/modules/config';
import { RedisCache, closeRedis, createRedisClient, waitForRedis } from '../src/modules/redis';
import { redisKeys } from '../src/modules/redis';
import { RuntimeCacheService } from '../src/modules/runtime-cache';
import { WalletService } from '../src/modules/wallet';

const LABEL = 'k6-inbound-load';

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'setup';
  const redis = createRedisClient(process.env.REDIS_URL);
  await waitForRedis(redis);
  const cache = new RedisCache(redis);
  const config = new PlatformConfigService(cache);
  const wallet = new WalletService(cache, config);
  const runtimeCache = new RuntimeCacheService(cache, config, wallet);

  try {
    if (command === 'reset') {
      // A load run leaves one reservation per call id in `active:{ws}`, and nothing ends
      // those calls: without this the next run is above the concurrency cap from its first
      // request and measures the decline path instead of the allow path.
      const tenants = await adminDb.tenant.findMany({ where: { name: { startsWith: LABEL } }, select: { id: true } });
      for (const tenant of tenants) await cache.del(redisKeys.activeCalls(tenant.id));
      console.log(`cleared active:{ws} for ${tenants.length} load workspace(s)`);
      return;
    }

    if (command === 'teardown') {
      const numbers = await adminDb.phoneNumber.findMany({ where: { tenant: { name: { startsWith: LABEL } } }, select: { id: true, tenantId: true } });
      for (const number of numbers) {
        await adminDb.phoneNumber.update({ where: { id: number.id }, data: { pausedAt: new Date(), status: 'paused' } });
        await runtimeCache.refresh(number.tenantId);
      }
      console.log(`paused ${numbers.length} load-test number(s). Ledger history keeps the workspaces themselves (§17).`);
      return;
    }

    const run = randomUUID().slice(0, 8);
    const tenant = await adminDb.tenant.create({ data: { name: `${LABEL} ${run}`, country: 'CA', timezone: 'America/Toronto' } });
    const agent = await adminDb.agent.create({
      data: { tenantId: tenant.id, name: 'load receptionist', status: 'live', tier: 'standard', retellAgentId: `agent_load_${run}`, publishedVersion: 1, maxCallDurationS: 600 },
    });
    const number = await adminDb.phoneNumber.create({
      data: {
        tenantId: tenant.id,
        agentId: agent.id,
        e164: `+1450${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`,
        type: 'retell_twilio',
        status: 'active',
        inboundToken: `tok_${randomUUID().replace(/-/g, '')}`,
        country: 'CA',
      },
    });
    // A cap high enough that concurrency is not what the run measures, and credits deep
    // enough that no iteration is declined on balance.
    await adminDb.tenantOverride.create({ data: { tenantId: tenant.id, concurrencyCap: 500, reason: 'k6 inbound load test' } });
    await wallet.grant(tenant.id, { credits: 100_000, reason: 'adjustment', expiresAt: new Date(Date.now() + 365 * 86_400_000) });
    await runtimeCache.refresh(tenant.id);

    const apiUrl = (process.env.API_PUBLIC_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? 4000}`).replace(/\/+$/, '');
    console.log(
      [
        '# k6 inbound load target (source this, or pass with -e)',
        `export API_URL=${apiUrl}`,
        `export NUMBER_TOKEN=${number.inboundToken}`,
        `export TO_NUMBER=${number.e164}`,
        `export WORKSPACE_ID=${tenant.id}`,
        '# RETELL_API_KEY must match the API’s, since it is also the webhook signing secret.',
        '',
        `# then: k6 run -e API_URL=$API_URL -e NUMBER_TOKEN=$NUMBER_TOKEN -e TO_NUMBER=$TO_NUMBER -e RETELL_API_KEY=$RETELL_API_KEY test/load/inbound.k6.js`,
      ].join('\n'),
    );
  } finally {
    await closeRedis(redis);
    await disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
