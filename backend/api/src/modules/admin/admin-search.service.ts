import { Injectable } from '@nestjs/common';
import { adminDb } from '@portal/db';
import type { AdminSearchResponse, AdminSearchResult } from '@portal/schemas';

const UUID_FULL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Admin §3 "Global search (⌘K)": tenant name or id, user email, phone number (E.164 or
 * partial), platform call id, platform agent id, Stripe customer / session / payment
 * intent id, job and webhook event ids. Each entity is one bounded query and the result
 * says what it is and whose it is, so the shell can open the right detail page.
 */
@Injectable()
export class AdminSearchService {
  async search(q: string, limit: number): Promise<AdminSearchResponse> {
    const term = q.trim();
    const per = Math.max(3, Math.ceil(limit / 4));
    const digits = term.replace(/[^\d+]/g, '');
    const uuidish = UUID_FULL.test(term);
    const lower = term.toLowerCase();

    const [tenants, users, agents, numbers, calls, purchases, jobs, events] = await Promise.all([
      adminDb.tenant.findMany({
        where: {
          OR: [
            { name: { contains: term, mode: 'insensitive' } },
            ...(uuidish ? [{ id: lower }] : []),
            { stripeCustomerId: term },
          ],
        },
        take: per,
        select: {
          id: true,
          name: true,
          planTier: true,
          pausedAt: true,
          onboardingCompletedAt: true,
        },
      }),
      adminDb.user.findMany({
        where: {
          OR: [
            { email: { contains: term, mode: 'insensitive' } },
            { name: { contains: term, mode: 'insensitive' } },
            ...(uuidish ? [{ id: lower }] : []),
          ],
        },
        take: per,
        select: {
          id: true,
          email: true,
          name: true,
          lockedAt: true,
          memberships: { take: 1, select: { tenantId: true, tenant: { select: { name: true } } } },
        },
      }),
      adminDb.agent.findMany({
        where: {
          deletedAt: null,
          OR: [
            { name: { contains: term, mode: 'insensitive' } },
            { retellAgentId: term },
            ...(uuidish ? [{ id: lower }] : []),
          ],
        },
        take: per,
        select: {
          id: true,
          name: true,
          status: true,
          tenantId: true,
          tenant: { select: { name: true } },
        },
      }),
      digits.length >= 4
        ? adminDb.phoneNumber.findMany({
            where: { e164: { contains: digits } },
            take: per,
            select: {
              id: true,
              e164: true,
              status: true,
              tenantId: true,
              tenant: { select: { name: true } },
            },
          })
        : Promise.resolve([]),
      term.length >= 8
        ? adminDb.call.findMany({
            where: { id: { startsWith: term } },
            take: per,
            select: {
              id: true,
              status: true,
              fromNumber: true,
              startedAt: true,
              tenantId: true,
              tenant: { select: { name: true } },
            },
          })
        : Promise.resolve([]),
      /^(cs_|pi_|ch_|in_)/.test(term) || uuidish
        ? adminDb.purchase.findMany({
            where: {
              OR: [
                { stripeSessionId: term },
                { stripePaymentIntent: term },
                ...(uuidish ? [{ id: lower }] : []),
              ],
            },
            take: per,
            select: {
              id: true,
              status: true,
              amountCents: true,
              currency: true,
              packId: true,
              tenantId: true,
              tenant: { select: { name: true } },
            },
          })
        : Promise.resolve([]),
      uuidish
        ? adminDb.job.findMany({
            where: { id: lower },
            take: per,
            select: {
              id: true,
              type: true,
              status: true,
              tenantId: true,
              tenant: { select: { name: true } },
            },
          })
        : Promise.resolve([]),
      term.length >= 6
        ? adminDb.webhookEvent.findMany({
            where: {
              OR: [
                { externalId: { contains: term } },
                ...(uuidish ? [{ id: lower }] : []),
              ],
            },
            take: per,
            select: {
              id: true,
              provider: true,
              eventType: true,
              externalId: true,
              processedAt: true,
              error: true,
            },
          })
        : Promise.resolve([]),
    ]);

    const results: AdminSearchResult[] = [
      ...tenants.map((t) => ({
        type: 'customer' as const,
        id: t.id,
        title: t.name,
        subtitle: t.planTier,
        status: t.pausedAt ? 'paused' : t.onboardingCompletedAt ? 'active' : 'onboarding',
        tenant_id: t.id,
        tenant_name: t.name,
      })),
      ...users.map((u) => ({
        type: 'user' as const,
        id: u.id,
        title: u.email,
        subtitle: u.name,
        status: u.lockedAt ? 'locked' : 'active',
        tenant_id: u.memberships[0]?.tenantId ?? null,
        tenant_name: u.memberships[0]?.tenant.name ?? null,
      })),
      ...agents.map((a) => ({
        type: 'agent' as const,
        id: a.id,
        title: a.name,
        subtitle: null,
        status: a.status,
        tenant_id: a.tenantId,
        tenant_name: a.tenant.name,
      })),
      ...numbers.map((n) => ({
        type: 'number' as const,
        id: n.id,
        title: n.e164 ?? '(provisioning)',
        subtitle: null,
        status: n.status,
        tenant_id: n.tenantId,
        tenant_name: n.tenant.name,
      })),
      ...calls.map((c) => ({
        type: 'call' as const,
        id: c.id,
        title: c.id,
        subtitle: c.fromNumber ?? (c.startedAt ? c.startedAt.toISOString() : null),
        status: c.status,
        tenant_id: c.tenantId,
        tenant_name: c.tenant.name,
      })),
      ...purchases.map((p) => ({
        type: 'purchase' as const,
        id: p.id,
        title: `${p.packId ?? 'custom'} · ${(p.amountCents / 100).toFixed(2)} ${p.currency}`,
        subtitle: null,
        status: p.status,
        tenant_id: p.tenantId,
        tenant_name: p.tenant.name,
      })),
      ...jobs.map((j) => ({
        type: 'job' as const,
        id: j.id,
        title: j.type,
        subtitle: j.id,
        status: j.status,
        tenant_id: j.tenantId,
        tenant_name: j.tenant?.name ?? null,
      })),
      ...events.map((e) => ({
        type: 'webhook_event' as const,
        id: e.id,
        title: `${e.provider} ${e.eventType}`,
        subtitle: e.externalId,
        status: e.processedAt ? 'processed' : e.error ? 'failed' : 'pending',
        tenant_id: null,
        tenant_name: null,
      })),
    ];
    return { q: term, results: results.slice(0, limit) };
  }
}
