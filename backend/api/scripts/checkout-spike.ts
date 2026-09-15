/**
 * D3 acceptance: create a real Stripe Checkout Session for a throwaway workspace through the
 * same BillingService the route uses, so the session shape (§13.7: client_reference_id,
 * metadata, setup_future_usage, invoice_creation) is accepted by Stripe in test mode.
 *
 *   pnpm --filter @portal/api exec dotenv -e ../../.env -- tsx scripts/checkout-spike.ts
 *
 * Prints the checkout URL and the ids `stripe trigger` needs to complete the purchase via
 * the webhook. Leaves the workspace behind (ledger rows are undeletable by design).
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { adminDb, disconnect } from '@portal/db';
import { BillingService } from '../src/modules/billing/billing.service';
import { StripeConfig } from '../src/modules/billing/stripe.config';
import { StripeGateway } from '../src/modules/billing/stripe.gateway';
import { PlatformConfigService } from '../src/modules/config';
import { RedisCache, closeRedis, createRedisClient, waitForRedis } from '../src/modules/redis';
import { WalletService } from '../src/modules/wallet';

async function main() {
  const packId = process.argv[2] ?? 'starter';
  const redis = createRedisClient(process.env.REDIS_URL);
  await waitForRedis(redis);
  const cache = new RedisCache(redis);
  const config = new PlatformConfigService(cache);
  const wallet = new WalletService(cache, config);
  const stripe = new StripeGateway(new StripeConfig());
  const billing = new BillingService(stripe, config, wallet);

  const run = randomUUID().slice(0, 8);
  const tenant = await adminDb.tenant.create({ data: { name: `D3 spike ${run}`, country: 'CA' } });
  const user = await adminDb.user.create({
    data: { authProviderId: `auth0|d3-spike-${run}`, email: `d3-spike-${run}@example.test`, name: 'D3 spike' },
  });
  await adminDb.membership.create({ data: { tenantId: tenant.id, userId: user.id, role: 'owner' } });
  await wallet.grantTrial(tenant.id);

  const ctx = { userId: user.id, workspaceId: tenant.id, role: 'owner' as const };
  const out = await billing.createCheckout(ctx, { pack_id: packId, auto_topup: { enabled: true, threshold: 50 } });
  const purchase = await adminDb.purchase.findUniqueOrThrow({ where: { id: out.purchase_id } });

  console.log(JSON.stringify({
    workspace_id: tenant.id,
    purchase_id: out.purchase_id,
    stripe_session_id: purchase.stripeSessionId,
    checkout_url: out.checkout_url,
    balance_before: await wallet.balance(tenant.id),
  }, null, 2));

  await closeRedis(redis);
  await disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await disconnect().catch(() => undefined);
  process.exit(1);
});
