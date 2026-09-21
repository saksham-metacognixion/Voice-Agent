import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Prisma, adminDb } from '@portal/db';
import { applyGuardrails } from '../src/modules/prompting';
import { WalletService } from '../src/modules/wallet';
import type { FakeAuth0Tenant } from './auth0-double';
import { READY_BRIEF, type TestWorkspace, createWorkspace, waitFor } from './d5-fixtures';

/*
 * D6 helpers on top of the D5 harness. A workspace that has *paid* — plan tier, caps,
 * a paid purchase, a Stripe customer, credits — because everything in D6 sits behind
 * "the customer has bought a pack": knowledge behind the `knowledge_base` gate, numbers
 * behind `max_numbers` and a paid purchase, auto top-up behind a saved card.
 */

export type PaidTier = 'starter' | 'growth' | 'scale';

const TIERS: Record<PaidTier, { planTier: PaidTier; concurrencyCap: number; kbAllowance: number; credits: number; priceCents: number }> = {
  starter: { planTier: 'starter', concurrencyCap: 2, kbAllowance: 0, credits: 150, priceCents: 4_900 },
  growth: { planTier: 'growth', concurrencyCap: 3, kbAllowance: 1, credits: 500, priceCents: 14_900 },
  scale: { planTier: 'scale', concurrencyCap: 5, kbAllowance: 3, credits: 1_500, priceCents: 39_900 },
};

export interface PaidWorkspace extends TestWorkspace {
  purchaseId: string;
  stripeCustomerId: string;
}

/** A workspace as it looks after one paid Checkout of `tier`, with the card kept for auto top-up when asked. */
export async function paidWorkspace(app: NestFastifyApplication, label: string, tier: PaidTier, options: { savedCard?: boolean } = {}): Promise<PaidWorkspace> {
  const ws = await createWorkspace(label);
  const spec = TIERS[tier];
  const stripeCustomerId = `cus_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
  await adminDb.tenant.update({
    where: { id: ws.workspaceId },
    data: {
      planTier: spec.planTier,
      concurrencyCap: spec.concurrencyCap,
      kbAllowance: spec.kbAllowance,
      stripeCustomerId,
      autoTopupJson: options.savedCard
        ? ({ enabled: false, pack_id: tier, threshold: null, payment_method_id: `pm_${randomUUID().slice(0, 12)}`, card_last4: '4242' } as Prisma.InputJsonValue)
        : Prisma.DbNull,
    },
  });
  const purchase = await adminDb.purchase.create({
    data: {
      tenantId: ws.workspaceId,
      packId: tier,
      amountCents: spec.priceCents,
      currency: 'USD',
      credits: spec.credits,
      status: 'paid',
      stripeSessionId: `cs_test_${randomUUID().replace(/-/g, '')}`,
      stripePaymentIntent: `pi_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    },
  });
  await app.get(WalletService).grant(ws.workspaceId, {
    credits: spec.credits,
    reason: 'purchase',
    expiresAt: new Date(Date.now() + 365 * 86_400_000),
    purchaseId: purchase.id,
    refType: 'purchase',
    refId: purchase.id,
  });
  return { ...ws, purchaseId: purchase.id, stripeCustomerId };
}

export function authFor(tenant: FakeAuth0Tenant) {
  return async (sub: string, workspaceId?: string): Promise<Record<string, string>> => ({
    authorization: `Bearer ${await tenant.mint(sub)}`,
    ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}),
  });
}

export function caller(app: NestFastifyApplication) {
  return async (method: string, path: string, auth: Record<string, string>, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await app.inject({
      method: method as 'GET',
      url: path,
      headers: body === undefined ? auth : { ...auth, 'content-type': 'application/json' },
      payload: body === undefined ? undefined : JSON.stringify(body),
    });
    let parsed: Record<string, unknown> = {};
    if (res.body) {
      try {
        parsed = res.json() as Record<string, unknown>;
      } catch {
        parsed = { raw: res.body };
      }
    }
    return { status: res.statusCode, body: parsed };
  };
}

/**
 * An agent with a lint-clean v1 prompt, published through the real route (so it has
 * Retell objects on the double). Generation is skipped: the prompt is written straight
 * onto the draft, which is exactly what the Advanced editor does.
 */
export async function publishedAgent(
  call: ReturnType<typeof caller>,
  auth: Record<string, string>,
  options: { publish?: boolean; name?: string } = {},
): Promise<string> {
  const created = await call('POST', '/agents', auth, { template_id: 'receptionist', industry: 'dental', ...(options.name ? { name: options.name } : {}) });
  if (created.status !== 201) throw new Error(`POST /agents → ${created.status} ${JSON.stringify(created.body)}`);
  const agentId = created.body.id as string;
  const patched = await call('PATCH', `/agents/${agentId}/draft`, auth, { brief: READY_BRIEF });
  if (patched.status !== 200) throw new Error(`PATCH draft → ${patched.status} ${JSON.stringify(patched.body)}`);
  await adminDb.agentVersion.update({
    where: { agentId_versionNo: { agentId, versionNo: 1 } },
    data: {
      promptText: applyGuardrails(TEST_PROMPT),
      greeting: 'Thanks for calling Maple Dental, this is Sophie. How can I help you today?',
    },
  });
  if (options.publish !== false) {
    const published = await call('POST', `/agents/${agentId}/publish`, auth, {});
    if (published.status !== 201) throw new Error(`publish → ${published.status} ${JSON.stringify(published.body)}`);
  }
  return agentId;
}

export const TEST_PROMPT = [
  '## Identity',
  'You are Sophie, the friendly receptionist for Maple Dental, a family dental clinic in Laval.',
  '',
  '## Goal',
  'Answer calls, share opening hours (Monday to Friday, 9am to 5pm), and take detailed messages for the team including the caller name and callback number.',
  '',
  '## Style',
  'Warm, concise, professional. Confirm details back to the caller. Never give medical advice.',
  '',
  '## Hand-off',
  'If the caller is in pain, take a message marked urgent and promise a callback within the hour.',
].join('\n');

/** Waits for a knowledge source to leave pending/syncing. */
export async function waitForSource(sourceId: string, timeoutMs = 20_000) {
  return waitFor(
    `knowledge source ${sourceId} to settle`,
    async () => {
      const row = await adminDb.knowledgeSource.findUnique({ where: { id: sourceId } });
      if (!row) return { gone: true as const };
      return row.status === 'ready' || row.status === 'failed' ? row : null;
    },
    timeoutMs,
  );
}

/** Waits for a phone number to leave `provisioning`. */
export async function waitForNumber(numberId: string, timeoutMs = 20_000) {
  return waitFor(
    `number ${numberId} to settle`,
    async () => {
      const row = await adminDb.phoneNumber.findUnique({ where: { id: numberId } });
      return row && row.status !== 'provisioning' ? row : null;
    },
    timeoutMs,
  );
}
