/* eslint-disable no-console */
/**
 * Links each paid Checkout purchase to its Stripe invoice, for rows from before the
 * invoice carried our ids (19 Nov 2026). Stripe removed `payment_intent` from invoice
 * objects in API 2025-03 and we had set no invoice metadata, so `invoice.*` events could
 * not name their purchase and every `invoices.purchase_id` stayed NULL.
 *
 * For every paid or refunded Checkout purchase with no invoice linked, it asks Stripe for
 * the purchase's session, reads the session's invoice id, and then:
 *   - links the `invoices` row that already holds that Stripe invoice, or
 *   - when there is no such row (the webhook never reached this environment), reads the
 *     invoice from Stripe and stores it through the same `InvoicesService.applyEvent` the
 *     webhook uses.
 *
 * It moves no money and no credits, and never touches an invoice already linked.
 *
 *   pnpm --filter @portal/api invoices:link            # dry run: what it would do
 *   pnpm --filter @portal/api invoices:link --apply    # do it
 */
import { adminDb, disconnect } from '@portal/db';
import { InvoicesService } from '../src/modules/billing/invoices.service';
import { StripeConfig } from '../src/modules/billing/stripe.config';
import { StripeGateway } from '../src/modules/billing/stripe.gateway';

async function main() {
  const apply = process.argv.includes('--apply');
  const stripe = new StripeGateway(new StripeConfig());
  const invoices = new InvoicesService();
  const purchases = await adminDb.purchase.findMany({
    where: { isAutoTopup: false, status: { in: ['paid', 'refunded'] }, stripeSessionId: { not: null }, invoices: { none: {} } },
    select: { id: true, tenantId: true, stripeSessionId: true, amountCents: true, currency: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const count = { purchases: purchases.length, linked: 0, created: 0, no_invoice: 0, mismatch: 0, failed: 0 };
  console.log(`${purchases.length} paid Checkout purchase(s) with no invoice linked${apply ? '' : ' (dry run)'}`);

  for (const purchase of purchases) {
    const tag = `purchase ${purchase.id.slice(0, 8)} (${purchase.amountCents} ${purchase.currency.trim()}, ${purchase.createdAt.toISOString().slice(0, 10)})`;
    try {
      const session = await stripe.retrieveCheckoutSession(purchase.stripeSessionId!);
      if (!session.invoice) {
        count.no_invoice += 1;
        console.log(`${tag}: Stripe made no invoice for its session`);
        continue;
      }
      const row = await adminDb.invoice.findUnique({ where: { stripeInvoiceId: session.invoice }, select: { id: true, tenantId: true, purchaseId: true, number: true, amountCents: true, currency: true } });
      if (row) {
        // Same workspace or an invoice nobody could map; never one that belongs elsewhere.
        if (row.purchaseId || (row.tenantId && row.tenantId !== purchase.tenantId)) {
          count.mismatch += 1;
          console.log(`${tag}: invoice ${row.number ?? session.invoice} is already linked or belongs to another workspace; left alone`);
          continue;
        }
        if (apply) await adminDb.invoice.update({ where: { id: row.id }, data: { purchaseId: purchase.id, tenantId: purchase.tenantId } });
        count.linked += 1;
        console.log(`${tag}: ${apply ? 'linked to' : 'would link to'} invoice ${row.number ?? session.invoice} (${row.amountCents} ${row.currency.trim()})`);
        continue;
      }
      const facts = StripeGateway.invoiceFacts(await stripe.client.invoices.retrieve(session.invoice));
      if (apply) {
        await invoices.applyEvent(
          { id: `backfill-${facts.id}`, type: facts.status === 'paid' ? 'invoice.paid' : 'invoice.finalized', created: Math.floor(Date.now() / 1000) },
          { ...facts, metadata: { ...facts.metadata, purchase_id: purchase.id, workspace_id: purchase.tenantId } },
        );
      }
      count.created += 1;
      console.log(`${tag}: no local row; ${apply ? 'stored' : 'would store'} invoice ${facts.number ?? facts.id} (${facts.amount_due} ${facts.currency.toUpperCase()}, ${facts.status}) from Stripe`);
    } catch (error) {
      count.failed += 1;
      console.log(`${tag}: failed: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`);
    }
  }
  console.log(JSON.stringify(count));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => disconnect());
