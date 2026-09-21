/**
 * Dev only: ek workspace ko "paid" bana do taaki D6 ke Postman folders chal sakein.
 *
 *   pnpm --filter @portal/api exec dotenv -e ../../.env -- tsx scripts/dev-seed-workspace.ts <workspace_id> [pack_id]
 *
 * Kyun chahiye: D6 ke saare routes paid state ke peeche hain, jaan-boojh kar —
 *   knowledge      → `knowledge_base` gate + `caps.kb_allowance` (§5.2)
 *   SIP import     → `sip_import` gate (Scale+)
 *   buy/activate   → ek paid purchase + balance > 0 (§5.4 "pehli purchase se pehle koi number nahi")
 *                    aur plan ka `max_numbers`
 * Trial workspace par ye 400 PLAN_LIMIT / 402 NO_CREDITS dete hain, jo sahi behaviour hai.
 *
 * Ye script wahi karta hai jo ek asli Checkout karta: purchase row `paid`, credits grant,
 * aur tenant par us pack ke caps. Stripe ko chhua nahi jaata — isliye `POST /wallet/portal-session`
 * aur auto top-up (jinhe asli Stripe customer + saved card chahiye) iske baad bhi kaam nahi karenge;
 * unke liye `POST /wallet/checkout` se asli test-mode Checkout chalao.
 *
 * Caps aur credits pricing config se aate hain, code se nahi (CLAUDE.md: "never hard-code a price,
 * rate, cap or model id"), isliye SA5 se pack badla toh ye apne aap wahi naya number use karega.
 */
import 'reflect-metadata';
import { adminDb, disconnect, type PlanTier } from '@portal/db';
import { isDevEnv } from '../src/common/env';
import { PlatformConfigService } from '../src/modules/config';
import { RedisCache, closeRedis, createRedisClient, waitForRedis } from '../src/modules/redis';
import { WalletService, addMonths } from '../src/modules/wallet/wallet.service';

async function main() {
  if (!isDevEnv()) throw new Error(`This script only runs with APP_ENV=dev (got ${process.env.APP_ENV ?? 'unset'}).`);

  const [workspaceId, packId = 'growth'] = process.argv.slice(2);
  if (!workspaceId) throw new Error('Usage: tsx scripts/dev-seed-workspace.ts <workspace_id> [pack_id]');

  const tenant = await adminDb.tenant.findUnique({ where: { id: workspaceId }, select: { id: true, name: true } });
  if (!tenant) throw new Error(`workspace ${workspaceId} does not exist — run dev-link-user.ts first`);

  const redis = createRedisClient(process.env.REDIS_URL);
  await waitForRedis(redis);
  const cache = new RedisCache(redis);
  const config = new PlatformConfigService(cache);
  const wallet = new WalletService(cache, config);

  const found = await config.purchasablePack(packId);
  if (!found) {
    const { config: pricing } = await config.currentPricing();
    throw new Error(`pack "${packId}" is not purchasable. Try one of: ${pricing.packs.filter((p) => p.active).map((p) => p.id).join(', ')}`);
  }
  const { pack } = found;
  const { policy, configVersion } = await config.walletPolicy();
  const credits = pack.credits + pack.bonus_credits;

  // Ek paid purchase — wahi row jo `checkout.session.completed` banata hai, Stripe ke bina.
  const purchase = await adminDb.purchase.create({
    data: {
      tenantId: workspaceId,
      packId: pack.id,
      amountCents: pack.price_cents,
      currency: pack.currency,
      credits,
      status: 'paid',
      stripeSessionId: `cs_dev_seed_${Date.now()}`,
    },
    select: { id: true },
  });

  const write = await wallet.grant(workspaceId, {
    credits,
    reason: 'purchase',
    expiresAt: addMonths(new Date(), policy.credit_expiry_months),
    purchaseId: purchase.id,
    refType: 'purchase',
    refId: purchase.id,
    policyVersion: configVersion,
  });

  // §5.2: plan tier = sabse bada pack jo 12 mahine me khareeda gaya, aur tenant us pack ke caps copy karta hai.
  await adminDb.tenant.update({
    where: { id: workspaceId },
    data: { planTier: pack.plan_tier as PlanTier, concurrencyCap: pack.concurrency_cap, kbAllowance: pack.kb_allowance },
  });

  // Gates 60 s tak cached rehte hain — refresh na karo toh Postman me PLAN_LIMIT dikhta rahega.
  await config.invalidateWorkspace(workspaceId);
  const caps = await config.refreshCaps(workspaceId);
  const flags = await config.flagsFor(workspaceId);

  console.log(
    JSON.stringify(
      {
        workspace_id: workspaceId,
        workspace_name: tenant.name,
        pack: pack.id,
        plan_tier: caps.plan_tier,
        credits_granted: credits,
        balance: write.balance_after,
        caps: { max_agents: caps.max_agents, max_numbers: caps.max_numbers, kb_allowance: caps.kb_allowance, concurrency_cap: caps.concurrency_cap },
        gates: { knowledge_base: flags.gates.knowledge_base, sip_import: flags.gates.sip_import, auto_topup: flags.gates.auto_topup },
        now_works: ['POST /agents/:id/knowledge', 'PUT /agents/:id/phone-plan', 'POST /numbers/buy', 'POST /agents/:id/activate'],
        still_needs_real_stripe: ['PUT /wallet/auto-topup', 'POST /wallet/portal-session'],
      },
      null,
      2,
    ),
  );

  await closeRedis(redis);
  await disconnect();
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await disconnect().catch(() => undefined);
  process.exit(1);
});
