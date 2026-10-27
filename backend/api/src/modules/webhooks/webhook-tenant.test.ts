import { describe, expect, it } from 'vitest';
import { webhookTenantHint } from './webhook-tenant';

const WS = '0b85feaf-b661-4bbd-a390-a559ecbafb45';

describe('webhookTenantHint', () => {
  it('reads our tenant_id from a call’s metadata, and nothing from a call let through without it', () => {
    expect(webhookTenantHint('retell', { event: 'call_ended', call: { call_id: 'call_1', metadata: { tenant_id: WS } } })).toEqual({ tenantId: WS, stripeCustomerId: null });
    expect(webhookTenantHint('retell', { event: 'call_ended', call: { call_id: 'call_1' } })).toEqual({ tenantId: null, stripeCustomerId: null });
  });

  it('reads Stripe metadata first, and keeps the customer for objects we put no metadata on', () => {
    expect(webhookTenantHint('stripe', { data: { object: { metadata: { workspace_id: WS }, customer: 'cus_123' } } })).toEqual({ tenantId: WS, stripeCustomerId: 'cus_123' });
    expect(webhookTenantHint('stripe', { data: { object: { metadata: { tenant_id: WS } } } })).toEqual({ tenantId: WS, stripeCustomerId: null });
    expect(webhookTenantHint('stripe', { type: 'invoice.paid', data: { object: { customer: 'cus_456' } } })).toEqual({ tenantId: null, stripeCustomerId: 'cus_456' });
  });

  it('accepts only a well-formed id, and names no workspace for an auth event or a body that is not an object', () => {
    expect(webhookTenantHint('retell', { call: { metadata: { tenant_id: 'not-a-uuid' } } }).tenantId).toBeNull();
    expect(webhookTenantHint('stripe', { data: { object: { customer: { id: 'cus_1' } } } }).stripeCustomerId).toBeNull();
    expect(webhookTenantHint('auth', { user_id: 'auth0|x' })).toEqual({ tenantId: null, stripeCustomerId: null });
    expect(webhookTenantHint('retell', null)).toEqual({ tenantId: null, stripeCustomerId: null });
  });
});
