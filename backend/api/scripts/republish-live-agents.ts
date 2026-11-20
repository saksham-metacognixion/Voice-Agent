/* eslint-disable no-console */
/**
 * D16 rollout: republishes every live agent with `refresh`, so its platform copy carries
 * the current agent spec — today, the webhook subscription to `transfer_bridged` and
 * `transfer_cancelled` that transfer billing reads. A published platform version cannot
 * be edited (ADR 0003 §7), so the only way to change one is the publish path itself:
 * same version of ours, new platform version (the ADR 0024 knowledge republish).
 *
 *   pnpm --filter @portal/api agents:republish            # list what it would republish
 *   pnpm --filter @portal/api agents:republish --apply    # republish, one agent at a time
 *
 * Paused workspaces and paused agents are skipped (publish refuses them anyway). Safe to
 * rerun: a republish of an up-to-date agent only mints another platform version. Run it
 * once per environment after the deploy that ships the new spec.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { adminDb, disconnect } from '@portal/db';
import { AgentPublishService } from '../src/modules/agents/agent-publish.service';
import { WorkerModule } from '../src/worker.module';

async function main() {
  const apply = process.argv.includes('--apply');
  const agents = await adminDb.agent.findMany({
    where: { status: 'live', deletedAt: null, publishedVersion: { not: null }, retellAgentId: { not: null }, tenant: { pausedAt: null } },
    select: { id: true, name: true, tenantId: true, publishedVersion: true, tenant: { select: { memberships: { where: { role: 'owner' }, select: { userId: true }, take: 1 } } } },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`${agents.length} live agent(s)${apply ? '' : ' (dry run — pass --apply to republish)'}`);
  if (!apply) {
    for (const a of agents) console.log(`  ${a.id}  v${a.publishedVersion}  ${a.name}`);
    return;
  }

  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: ['warn', 'error'] });
  const publisher = app.get(AgentPublishService);
  let ok = 0;
  try {
    for (const a of agents) {
      const owner = a.tenant.memberships[0]?.userId;
      if (!owner) {
        console.log(`! ${a.id}: no owner, skipped`);
        continue;
      }
      try {
        await publisher.publish({ userId: owner, workspaceId: a.tenantId, role: 'owner' }, a.id, a.publishedVersion!, { refresh: true });
        ok += 1;
        console.log(`✓ ${a.id}  v${a.publishedVersion}  ${a.name}`);
      } catch (error) {
        console.log(`✗ ${a.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await app.close();
  }
  console.log(`${ok}/${agents.length} republished`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void disconnect());
