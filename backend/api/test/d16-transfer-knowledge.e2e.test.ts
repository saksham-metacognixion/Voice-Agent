import { adminDb } from '@portal/db';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { localClock } from '@portal/schemas';
import { RetellGateway } from '../src/modules/retell';
import { RuntimeCacheService } from '../src/modules/runtime-cache';
import { WalletService } from '../src/modules/wallet';
import { WebhookProcessingService } from '../src/modules/webhooks';
import type { FakeAuth0Tenant } from './auth0-double';
import { type CallWorkspace, callId, createCallWorkspace, inboundEvent, ledgerSum, lifecycleEvent, startHarness, waitFor, waitForBilled } from './calls-fixtures';

/*
 * D16 end to end: transfer events and knowledge use, from a signed webhook through the
 * real queue and worker to the ledger and `GET /calls/:id`. The transferred leg must be
 * billed exactly once, on its own ledger row, whatever order the platform posts in.
 *
 * Needs Postgres, Redis and the seed (pnpm infra:up && pnpm db:deploy && pnpm db:seed).
 */

let app: NestFastifyApplication;
let stop: () => Promise<void>;
let customerTenant: FakeAuth0Tenant;
let retell: RetellGateway;
let wallet: WalletService;
let runtimeCache: RuntimeCacheService;

beforeAll(async () => {
  const harness = await startHarness();
  app = harness.app;
  stop = harness.stop;
  customerTenant = harness.customerTenant;
  retell = app.get(RetellGateway);
  wallet = app.get(WalletService);
  runtimeCache = app.get(RuntimeCacheService);
});

afterAll(async () => {
  await stop?.();
  await adminDb.$disconnect();
});

afterEach(() => vi.restoreAllMocks());

async function post(body: unknown) {
  const payload = JSON.stringify(body);
  return app.inject({ method: 'POST', url: '/webhooks/retell', headers: { 'content-type': 'application/json', 'x-retell-signature': await retell.signWebhookBody(payload) }, payload });
}

async function readyWorkspace(label: string, credits = 100): Promise<CallWorkspace> {
  const ws = await createCallWorkspace(label);
  await wallet.grant(ws.tenantId, { credits, reason: 'purchase', expiresAt: new Date(Date.now() + 365 * 86_400_000) });
  await runtimeCache.refresh(ws.tenantId);
  return ws;
}

/** The bare shape the platform posts transfer events in (stored on 26 Oct). */
const transfer = (event: string, id: string, at: number, call: Record<string, unknown> = {}) => ({ call: { call_id: id, ...call }, event, event_timestamp: at });

const transferLedger = (tenantId: string, id: string) => adminDb.creditLedger.findMany({ where: { tenantId, reason: 'transfer', refId: id } });
const processed = (id: string, eventType: string) =>
  waitFor(`${eventType} ${id} processed`, async () => {
    const row = await adminDb.webhookEvent.findFirst({ where: { provider: 'retell', externalId: id, eventType } });
    return row?.processedAt ? row : null;
  });
const transferBilled = (id: string) =>
  waitFor(`the transfer leg of ${id}`, async () => {
    const row = await adminDb.call.findUnique({ where: { id } });
    return row?.transferCreditsCharged != null ? row : null;
  });

async function getCall(ws: CallWorkspace, id: string) {
  const res = await app.inject({ method: 'GET', url: `/calls/${id}`, headers: { authorization: `Bearer ${await customerTenant.mint(ws.sub)}`, 'x-workspace-id': ws.tenantId } });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe('transfer billing (D16)', () => {
  it('bills a transferred call as two legs: the agent leg at the tier rate, the transferred leg at 0.25/min', async () => {
    const ws = await readyWorkspace('transfer-two-legs');
    const id = callId();
    const start = Date.now() - 300_000;
    const meta = { tenant_id: ws.tenantId, agent_id: ws.agentId, tier: 'standard' };

    await post(lifecycleEvent('call_started', { call_id: id, start_timestamp: start, metadata: meta }));
    await post(transfer('transfer_started', id, start + 55_000));
    await post(transfer('transfer_bridged', id, start + 60_000));
    // The agent leg ends when the transfer bridges: 60 s at 1/min.
    await post(lifecycleEvent('call_ended', { call_id: id, start_timestamp: start, end_timestamp: start + 60_000, disconnection_reason: 'transfer_bridged', call_status: 'ended', metadata: meta }));
    // The transferred leg talks for 150 s: 0.625 → 0.63 at 0.25/min.
    await post(transfer('transfer_ended', id, start + 215_000, { transfer_end_timestamp: start + 210_000 }));

    const row = await transferBilled(id);
    expect((await waitForBilled(id)).creditsCharged!.toNumber()).toBe(1);
    expect(row).toMatchObject({ transferStatus: 'ended', transferDurationS: 150, durationS: 60 });
    expect(row.transferRate!.toNumber()).toBe(0.25);
    expect(row.transferCreditsCharged!.toNumber()).toBe(0.63);

    const ledger = await adminDb.creditLedger.findMany({ where: { tenantId: ws.tenantId, refId: id }, orderBy: { createdAt: 'asc' } });
    expect(ledger.map((l) => [l.reason, l.delta.toNumber(), l.refType])).toEqual(
      expect.arrayContaining([
        ['call', -1, 'call'],
        ['transfer', -0.63, 'call_transfer'],
      ]),
    );
    expect(ledger).toHaveLength(2);
    expect(await ledgerSum(ws.tenantId)).toBeCloseTo(100 - 1.63, 2);

    const detail = await getCall(ws, id);
    expect(detail).toMatchObject({ credits_charged: 1, transfer_credits_charged: 0.63, transfer: { status: 'ended', duration_s: 150, rate: 0.25, credits_charged: 0.63 } });
  });

  it('bills once whatever arrives twice: a re-delivery, a replay, a late call_analyzed', async () => {
    const ws = await readyWorkspace('transfer-once');
    const id = callId();
    const start = Date.now() - 300_000;
    const meta = { tenant_id: ws.tenantId };
    await post(lifecycleEvent('call_started', { call_id: id, start_timestamp: start, metadata: meta }));
    await post(transfer('transfer_bridged', id, start + 30_000));
    const ended = transfer('transfer_ended', id, start + 90_000);
    await post(ended);
    await transferBilled(id);

    // The platform re-delivers the same event: a 204 once processed, nothing moves.
    expect((await post(ended)).statusCode).toBe(204);
    // SA12 replays every stored transfer event.
    const processing = app.get(WebhookProcessingService);
    for (const row of await adminDb.webhookEvent.findMany({ where: { provider: 'retell', externalId: id } })) await processing.replay(row.id);
    // call_analyzed carries the platform's end of the leg, the same 60 s.
    await post(lifecycleEvent('call_analyzed', { call_id: id, start_timestamp: start, end_timestamp: start + 30_000, transfer_end_timestamp: start + 90_000, metadata: meta, call_analysis: {} }));
    await processed(id, 'call_analyzed');

    const ledger = await transferLedger(ws.tenantId, id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.delta.toNumber()).toBe(-0.25);
    expect((await adminDb.call.findUnique({ where: { id } }))!.transferCreditsCharged!.toNumber()).toBe(0.25);
  });

  it('settles the leg when the transfer events arrive before the call is recorded, in reverse order', async () => {
    const ws = await readyWorkspace('transfer-early');
    const id = callId();
    const start = Date.now() - 300_000;
    // No row yet: both are stored and settled as deferred, not retried for ever.
    await post(transfer('transfer_ended', id, start + 160_000));
    await post(transfer('transfer_bridged', id, start + 40_000));
    const deferred = await processed(id, 'transfer_bridged');
    expect(deferred.error).toBeNull();
    expect(await adminDb.call.findUnique({ where: { id } })).toBeNull();

    // call_started was lost; call_ended creates the row, and the leg is folded in.
    await post(lifecycleEvent('call_ended', { call_id: id, start_timestamp: start, end_timestamp: start + 40_000, disconnection_reason: 'call_transfer', call_status: 'ended', metadata: { tenant_id: ws.tenantId } }));
    const row = await transferBilled(id);
    expect(row).toMatchObject({ transferStatus: 'ended', transferDurationS: 120 });
    expect(row.transferCreditsCharged!.toNumber()).toBe(0.5);
    expect(await transferLedger(ws.tenantId, id)).toHaveLength(1);
  });

  it('never bills a transfer that did not connect', async () => {
    const ws = await readyWorkspace('transfer-cancelled');
    const id = callId();
    const start = Date.now() - 120_000;
    const meta = { tenant_id: ws.tenantId };
    await post(lifecycleEvent('call_started', { call_id: id, start_timestamp: start, metadata: meta }));
    await post(transfer('transfer_started', id, start + 20_000));
    await post(transfer('transfer_cancelled', id, start + 45_000));
    await post(lifecycleEvent('call_ended', { call_id: id, start_timestamp: start, end_timestamp: start + 60_000, disconnection_reason: 'user_hangup', call_status: 'ended', metadata: meta }));
    const row = await transferBilled(id);
    expect(row.transferStatus).toBe('cancelled');
    expect(row.transferCreditsCharged!.toNumber()).toBe(0);
    expect(await transferLedger(ws.tenantId, id)).toHaveLength(0);
    // The agent leg is billed as ever.
    expect((await waitForBilled(id)).creditsCharged!.toNumber()).toBe(1);
  });

  it('holds a bridged leg open until it ends, and a declined call never bills one', async () => {
    const ws = await readyWorkspace('transfer-open');
    const id = callId();
    const start = Date.now() - 60_000;
    await post(lifecycleEvent('call_started', { call_id: id, start_timestamp: start, metadata: { tenant_id: ws.tenantId } }));
    await post(transfer('transfer_bridged', id, start + 10_000));
    await processed(id, 'transfer_bridged');
    const open = await adminDb.call.findUnique({ where: { id } });
    expect(open).toMatchObject({ transferStatus: 'bridged', transferCreditsCharged: null, transferDurationS: null });
    expect(await transferLedger(ws.tenantId, id)).toHaveLength(0);

    const missed = callId();
    await adminDb.call.create({ data: { id: missed, tenantId: ws.tenantId, channel: 'phone', status: 'declined', declineReason: 'hours', startedAt: new Date(start), endedAt: new Date(start) } });
    await post(transfer('transfer_bridged', missed, start + 1_000));
    await post(transfer('transfer_ended', missed, start + 61_000));
    await processed(missed, 'transfer_ended');
    expect(await transferLedger(ws.tenantId, missed)).toHaveLength(0);
  });
});

describe('knowledge use per call (D16)', () => {
  it('records look-ups, hits and per-source hits from the platform file, and shows them on the call', async () => {
    const ws = await readyWorkspace('kb-hits');
    const faq = await adminDb.knowledgeSource.create({ data: { tenantId: ws.tenantId, agentId: ws.agentId, type: 'file', name: 'Patient FAQ', status: 'ready' } });
    const hours = await adminDb.knowledgeSource.create({ data: { tenantId: ws.tenantId, agentId: ws.agentId, type: 'text', name: 'Opening hours', status: 'ready' } });
    const url = `https://cdn.example.test/${callId('kb')}/knowledge_base_retrieved_contents.json?Expires=1`;
    const file = [
      { response_id: 1, kb_ids: ['kb'], contexts: [`{FileName: ${faq.id.slice(0, 8)}-Patient_FAQ.txt}\nAppointments…`, `{FileName: ${faq.id.slice(0, 8)}-Patient_FAQ.txt}\nParking…`] },
      { response_id: 2, kb_ids: ['kb'], contexts: [] },
      { response_id: 3, kb_ids: ['kb'], contexts: [`{Title: Opening hours [${hours.id.slice(0, 8)}]}\nMon–Fri`, `{FileName: ${faq.id.slice(0, 8)}-Patient_FAQ.txt}\nX-rays…`] },
    ];
    const fetchFile = vi.spyOn(retell, 'fetchKnowledgeRetrievals').mockImplementation(async (u) => (u === url ? structuredClone(file) : Promise.reject(new Error('HTTP 403'))));

    const id = callId();
    const start = Date.now() - 120_000;
    const call = { call_id: id, start_timestamp: start, end_timestamp: start + 90_000, call_status: 'ended', disconnection_reason: 'user_hangup', metadata: { tenant_id: ws.tenantId, agent_id: ws.agentId }, latency: { knowledge_base: { num: 3 } }, knowledge_base_retrieved_contents_url: url };
    await post(lifecycleEvent('call_ended', call));
    await post(lifecycleEvent('call_analyzed', { ...call, call_analysis: {} }));

    const row = await waitFor('the knowledge use', async () => {
      const r = await adminDb.call.findUnique({ where: { id } });
      return r?.kbHits != null ? r : null;
    }, 20_000);
    expect(row).toMatchObject({ kbRetrievals: 3, kbHits: 2 });
    // ended and analyzed both enqueued it; the job id is one, so the file was read once.
    expect(fetchFile).toHaveBeenCalledTimes(1);

    const detail = await getCall(ws, id);
    expect(detail.knowledge).toEqual({
      lookups: 3,
      hits: 2,
      detail: 'complete',
      sources: [
        { source_id: faq.id, name: 'Patient FAQ', kind: 'file', hits: 2 },
        { source_id: hours.id, name: 'Opening hours', kind: 'text', hits: 1 },
      ],
    });
    // Knowledge use never moves credits.
    expect(await adminDb.creditLedger.count({ where: { tenantId: ws.tenantId, refId: id } })).toBe(1);
  }, 30_000);

  it('keeps the count when the file cannot be read, and shows nothing for a call that never looked anything up', async () => {
    const ws = await readyWorkspace('kb-count-only');
    vi.spyOn(retell, 'fetchKnowledgeRetrievals').mockRejectedValue(new Error('knowledge retrievals: HTTP 403'));
    const id = callId();
    const start = Date.now() - 120_000;
    await post(lifecycleEvent('call_ended', { call_id: id, start_timestamp: start, end_timestamp: start + 30_000, call_status: 'ended', disconnection_reason: 'user_hangup', metadata: { tenant_id: ws.tenantId }, latency: { knowledge_base: { num: 5 } }, knowledge_base_retrieved_contents_url: 'https://cdn.example.test/gone.json' }));
    const row = await waitFor('the count', async () => {
      const r = await adminDb.call.findUnique({ where: { id } });
      return r?.kbRetrievals != null ? r : null;
    }, 20_000);
    expect(row).toMatchObject({ kbRetrievals: 5, kbHits: null });
    expect((await getCall(ws, id)).knowledge).toEqual({ lookups: 5, hits: null, detail: 'count_only', sources: [] });

    const plain = callId();
    await post(lifecycleEvent('call_ended', { call_id: plain, start_timestamp: start, end_timestamp: start + 30_000, call_status: 'ended', disconnection_reason: 'user_hangup', metadata: { tenant_id: ws.tenantId } }));
    await waitForBilled(plain);
    expect((await getCall(ws, plain)).knowledge).toBeNull();
  }, 30_000);
});

describe('per-number business hours at the inbound check (D16)', () => {
  const allDay = { open: '00:00', close: '00:00' };
  const everyDay = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [allDay]]));

  async function ring(ws: CallWorkspace) {
    const id = callId();
    const payload = JSON.stringify(inboundEvent({ callId: id, to: ws.e164 }));
    const res = await app.inject({ method: 'POST', url: `/webhooks/retell/inbound/${ws.token}`, headers: { 'content-type': 'application/json', 'x-retell-signature': await retell.signWebhookBody(payload) }, payload });
    return { id, body: res.json() };
  }

  it("a number's own schedule wins over the workspace's, and a closed-today override declines as hours", async () => {
    const ws = await readyWorkspace('hours-override');
    const today = localClock(new Date(), 'Asia/Riyadh')!.date;
    // The workspace is open around the clock…
    await adminDb.tenant.update({ where: { id: ws.tenantId }, data: { businessHoursJson: { days: everyDay, closed_dates: [] } } });
    await adminDb.phoneNumber.update({ where: { id: ws.numberId }, data: { hoursMode: 'business' } });
    await runtimeCache.refresh(ws.tenantId);
    expect((await ring(ws)).body.call_inbound.reject).toBeUndefined();

    // …but this number keeps its own hours, in its own zone, and today is closed there.
    await adminDb.phoneNumber.update({
      where: { id: ws.numberId },
      data: { hoursMode: 'custom', hoursOverrideJson: { timezone: 'Asia/Riyadh', days: everyDay, closed_dates: [], date_overrides: [{ date: today, intervals: [] }] } },
    });
    await runtimeCache.refresh(ws.tenantId);
    const closed = await ring(ws);
    expect(closed.body).toEqual({ call_inbound: { reject: true } });
    expect(await waitFor('the missed row', async () => adminDb.call.findUnique({ where: { id: closed.id } }))).toMatchObject({ status: 'declined', declineReason: 'hours' });

    // Back to the week as written: open again.
    await adminDb.phoneNumber.update({ where: { id: ws.numberId }, data: { hoursOverrideJson: { timezone: 'Asia/Riyadh', days: everyDay, closed_dates: [] } } });
    await runtimeCache.refresh(ws.tenantId);
    expect((await ring(ws)).body.call_inbound.reject).toBeUndefined();
  });
});
