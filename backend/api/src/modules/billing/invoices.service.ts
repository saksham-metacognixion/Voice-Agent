import { Injectable, Logger } from '@nestjs/common';
import { Prisma, adminDb, withWorkspace, type InvoiceStatus } from '@portal/db';
import type { InvoiceResponse, Page, PaginationQuery } from '@portal/schemas';
import { cursorArgs, toPage } from '../../common/pagination';
import type { WorkspaceContext } from '../auth';
import type { InvoiceFacts } from './stripe.gateway';

/**
 * Stripe's `status` plus the event type → our enum. `payment_failed` is not a Stripe
 * invoice status (the invoice stays `open`); it is what an `invoice.payment_failed`
 * event means for the customer, so the event wins over the object's status there.
 */
export function invoiceStatusOf(eventType: string, stripeStatus: string | null): InvoiceStatus {
  if (eventType === 'invoice.payment_failed') return 'payment_failed';
  if (eventType === 'invoice.marked_uncollectible' || stripeStatus === 'uncollectible') return 'uncollectible';
  switch (stripeStatus) {
    case 'draft':
      return 'draft';
    case 'open':
      return 'open';
    case 'paid':
      return 'paid';
    case 'void':
      return 'void';
    default:
      return eventType === 'invoice.paid' ? 'paid' : eventType === 'invoice.voided' ? 'void' : eventType === 'invoice.finalized' ? 'open' : 'draft';
  }
}

/**
 * Terminal states never regress. Stripe delivers events in any order (`invoice.paid` can
 * arrive before `invoice.finalized`), so a lower-ranked status is applied only when the
 * event is *newer* than the last one applied — and never over a terminal one.
 */
export const STATUS_RANK: Record<InvoiceStatus, number> = { draft: 0, open: 1, payment_failed: 1, paid: 3, void: 3, uncollectible: 3 };

/**
 * Invoices (D5 "Invoices", SA9). Written only by the `invoice.*` webhook handlers, read
 * by `GET /wallet/invoices` under RLS. Idempotency is `webhook_events` (one processing
 * per Stripe event id) plus the `stripe_invoice_id` upsert with `last_event_created`,
 * so a replayed or reordered event cannot move an invoice backwards.
 */
@Injectable()
export class InvoicesService {
  private readonly log = new Logger(InvoicesService.name);

  async applyEvent(event: { id: string; type: string; created: number }, facts: InvoiceFacts): Promise<{ outcome: string; invoiceId?: string; reason?: string }> {
    const status = invoiceStatusOf(event.type, facts.status);
    const tenantId = await this.resolveWorkspace(facts);
    const purchaseId = await this.resolvePurchase(facts, tenantId);
    if (!tenantId) this.log.warn(`invoice ${facts.id}: customer ${facts.customer ?? 'null'} maps to no workspace; stored for reconciliation`);

    const existing = await adminDb.invoice.findUnique({ where: { stripeInvoiceId: facts.id } });
    if (existing) {
      if (existing.lastEventId === event.id) return { outcome: 'ignored', invoiceId: existing.id, reason: 'event already applied' };
      const older = existing.lastEventCreated !== null && event.created < existing.lastEventCreated;
      const regresses = STATUS_RANK[status] < STATUS_RANK[existing.status];
      const terminal = STATUS_RANK[existing.status] >= 3 && existing.status !== status;
      if ((older && regresses) || terminal) {
        this.log.log(`invoice ${facts.id}: ${event.type} (${status}) does not move it off ${existing.status}; recording the event only`);
        await adminDb.invoice.update({ where: { id: existing.id }, data: { lastEventId: event.id, amountPaidCents: Math.max(existing.amountPaidCents, facts.amount_paid) } });
        return { outcome: 'kept', invoiceId: existing.id, reason: `stays ${existing.status}` };
      }
    }

    const data = {
      tenantId,
      purchaseId,
      stripeCustomerId: facts.customer,
      stripePaymentIntent: facts.payment_intent,
      number: facts.number,
      amountCents: facts.amount_due,
      amountPaidCents: facts.amount_paid,
      currency: facts.currency.toUpperCase().slice(0, 3),
      status,
      hostedUrl: facts.hosted_invoice_url,
      pdfUrl: facts.invoice_pdf,
      lastEventId: event.id,
      lastEventCreated: event.created,
      finalizedAt: facts.finalized_at ? new Date(facts.finalized_at * 1000) : undefined,
      paidAt: facts.paid_at ? new Date(facts.paid_at * 1000) : undefined,
      voidedAt: facts.voided_at ? new Date(facts.voided_at * 1000) : undefined,
    } satisfies Prisma.InvoiceUncheckedUpdateInput;

    const row = await adminDb.invoice.upsert({
      where: { stripeInvoiceId: facts.id },
      create: { ...data, stripeInvoiceId: facts.id, createdAt: new Date(facts.created * 1000) } as Prisma.InvoiceUncheckedCreateInput,
      update: data,
    });
    if (purchaseId && facts.hosted_invoice_url) {
      await adminDb.purchase.updateMany({ where: { id: purchaseId, invoiceUrl: null }, data: { invoiceUrl: facts.hosted_invoice_url } }).catch(() => undefined);
    }
    this.log.log(`invoice ${facts.id} (${facts.number ?? 'no number'}) → ${status} for ${tenantId ?? 'unmapped workspace'} via ${event.type}`);
    return { outcome: existing ? 'updated' : 'created', invoiceId: row.id };
  }

  async list(ctx: WorkspaceContext, query: PaginationQuery): Promise<Page<InvoiceResponse>> {
    const rows = await withWorkspace(ctx, (db) =>
      db.invoice.findMany({ ...cursorArgs(query), where: { tenantId: ctx.workspaceId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
    );
    const page = toPage(rows, query);
    return {
      next_cursor: page.next_cursor,
      items: page.items.map((row) => ({
        id: row.id,
        purchase_id: row.purchaseId,
        number: row.number,
        amount_cents: row.amountCents,
        currency: row.currency,
        status: row.status,
        hosted_url: row.hostedUrl,
        pdf_url: row.pdfUrl,
        finalized_at: row.finalizedAt?.toISOString() ?? null,
        paid_at: row.paidAt?.toISOString() ?? null,
        created_at: row.createdAt.toISOString(),
      })),
    };
  }

  /** metadata.workspace_id when it is ours, else the customer id on `tenants`. */
  private async resolveWorkspace(facts: InvoiceFacts): Promise<string | null> {
    const fromMeta = facts.metadata.workspace_id;
    if (fromMeta && /^[0-9a-f-]{36}$/i.test(fromMeta)) {
      const tenant = await adminDb.tenant.findUnique({ where: { id: fromMeta }, select: { id: true, stripeCustomerId: true } });
      if (tenant && (!facts.customer || !tenant.stripeCustomerId || tenant.stripeCustomerId === facts.customer)) return tenant.id;
    }
    if (!facts.customer) return null;
    const tenant = await adminDb.tenant.findUnique({ where: { stripeCustomerId: facts.customer }, select: { id: true } });
    return tenant?.id ?? null;
  }

  private async resolvePurchase(facts: InvoiceFacts, tenantId: string | null): Promise<string | null> {
    const fromMeta = facts.metadata.purchase_id;
    if (fromMeta && /^[0-9a-f-]{36}$/i.test(fromMeta)) {
      const purchase = await adminDb.purchase.findUnique({ where: { id: fromMeta }, select: { id: true, tenantId: true } });
      if (purchase && (!tenantId || purchase.tenantId === tenantId)) return purchase.id;
    }
    if (facts.payment_intent) {
      const purchase = await adminDb.purchase.findUnique({ where: { stripePaymentIntent: facts.payment_intent }, select: { id: true, tenantId: true } });
      if (purchase && (!tenantId || purchase.tenantId === tenantId)) return purchase.id;
    }
    return null;
  }
}
