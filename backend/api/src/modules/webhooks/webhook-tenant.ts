/**
 * What a stored webhook body says about the workspace it belongs to (SA12, admin §11).
 * Pure: the worker resolves the hint against the database once the event is processed
 * (`WebhookEventsService.attribute`) and SA12 falls back to it for a row not yet settled.
 *
 * The payload is only a hint. A call let through without metadata — a fail-open, or an
 * event `call-recovery` stored — carries no `tenant_id`, and the workspace it was billed
 * to is the `calls` row's, found by the agent / number fallback (ADR 0011 §2).
 */
export interface WebhookTenantHint {
  /** Our workspace id as the payload names it: Retell `call.metadata.tenant_id`, Stripe `metadata.workspace_id` / `tenant_id`. */
  tenantId: string | null;
  /** Stripe only: the customer the object belongs to, for events we put no metadata on (invoices, disputes). */
  stripeCustomerId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function webhookTenantHint(provider: string, payload: unknown): WebhookTenantHint {
  const p = record(payload);
  if (provider === 'retell') {
    return { tenantId: uuidOf(record(record(p.call).metadata).tenant_id), stripeCustomerId: null };
  }
  if (provider === 'stripe') {
    const object = record(record(p.data).object);
    const metadata = record(object.metadata);
    const customer = typeof object.customer === 'string' && object.customer.startsWith('cus_') ? object.customer : null;
    return { tenantId: uuidOf(metadata.workspace_id) ?? uuidOf(metadata.tenant_id), stripeCustomerId: customer };
  }
  return { tenantId: null, stripeCustomerId: null };
}

function uuidOf(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
