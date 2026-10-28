import { adminDb } from '@portal/db';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { portalUrl } from '../src/common/env';
import { encodeActive } from '../src/modules/calls';
import { WIDGET_CALLS_PER_HOUR, WIDGET_CALLS_PER_IP } from '../src/modules/calls/widget.service';
import { PlatformConfigService } from '../src/modules/config';
import { ForwardingTestService } from '../src/modules/numbers/forwarding-test.service';
import { REDIS, type RedisLike, redisKeys } from '../src/modules/redis';
import { RuntimeCacheService } from '../src/modules/runtime-cache';
import { WalletService } from '../src/modules/wallet';
import { type FakeRetellGateway, addMember, createWorkspace, startD5Harness, waitFor } from './d5-fixtures';
import { authFor, caller, paidWorkspace, publishedAgent } from './d6-fixtures';

/*
 * D17 end to end: "Call my phone" (W5), the forwarding test (D4) and the website widget
 * (§11.5). The exit check is the last describe: a widget call is recorded with
 * `channel = web`, is not a test, and appears in D2 and in the D1 channel split.
 *
 * Needs Postgres, Redis and the seed (pnpm infra:up && pnpm db:deploy && pnpm db:seed).
 */

let app: NestFastifyApplication;
let retell: FakeRetellGateway;
let stop: () => Promise<void>;
let auth: ReturnType<typeof authFor>;
let call: ReturnType<typeof caller>;
let redis: RedisLike;

beforeAll(async () => {
  const harness = await startD5Harness();
  app = harness.app;
  retell = harness.retell;
  stop = harness.stop;
  auth = authFor(harness.customerTenant);
  call = caller(app);
  redis = app.get<RedisLike>(REDIS);
});

afterAll(async () => {
  await stop?.();
  await adminDb.$disconnect();
});

/** A live number on `agentId`, as activation leaves one, projected into `num:{e164}`. */
async function liveNumber(workspaceId: string, agentId: string, extra: { forwardingFrom?: string } = {}) {
  const e164 = `+1450${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
  const token = `tok_${randomUUID().replace(/-/g, '')}`;
  const number = await adminDb.phoneNumber.create({
    data: {
      tenantId: workspaceId,
      agentId,
      e164,
      type: 'retell_twilio',
      status: 'active',
      inboundToken: token,
      country: 'CA',
      ...(extra.forwardingFrom ? { forwardingFrom: extra.forwardingFrom, forwardingStatus: 'waiting_for_customer' } : {}),
    },
  });
  await adminDb.agent.update({ where: { id: agentId }, data: { status: 'live' } });
  await app.get(RuntimeCacheService).refresh(workspaceId);
  return { id: number.id, e164, token };
}

const lastArgs = <T>(method: string) => retell.calls.filter((c) => c.method === method).at(-1)!.args[0] as T;

async function webhook(path: string, body: unknown) {
  const payload = JSON.stringify(body);
  return app.inject({ method: 'POST', url: path, headers: { 'content-type': 'application/json', 'x-retell-signature': 'fake' }, payload });
}

describe('POST /agents/:id/test/phone — "Call my phone" (W5, Phase 2)', () => {
  it('rings the customer’s phone from the agent’s number, on the version under test, as a test call', async () => {
    const ws = await paidWorkspace(app, 'cmp-ok', 'starter');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers);
    const number = await liveNumber(ws.workspaceId, agentId);
    const agent = await adminDb.agent.findUniqueOrThrow({ where: { id: agentId } });
    const version = await adminDb.agentVersion.findUniqueOrThrow({ where: { agentId_versionNo: { agentId, versionNo: 1 } } });

    const res = await call('POST', `/agents/${agentId}/test/phone`, headers, { to: '+14165550123', version_no: 1 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ from_number: number.e164, to_number: '+14165550123', version_no: 1, balance: 150 });
    expect(JSON.stringify(res.body)).not.toMatch(/retell|agent_/i);

    const placed = lastArgs<{ fromNumber: string; toNumber: string; agentId: string; agentVersion: number; metadata: Record<string, unknown> }>('createPhoneCall');
    expect(placed).toMatchObject({ fromNumber: number.e164, toNumber: '+14165550123', agentId: agent.retellAgentId, agentVersion: version.retellAgentVersion });
    expect(placed.metadata).toEqual({ tenant_id: ws.workspaceId, agent_id: agentId, version_no: 1, tier: agent.tier, test: true, number_id: number.id });
    // QA-083: the calling number's transfer-failed message rides along, as on an inbound call (none set = '').
    expect((placed as { dynamicVariables?: Record<string, string> }).dynamicVariables).toEqual({ transfer_fail_message: '' });
    // The country, never the number, in the audit log every admin reads.
    const audit = await adminDb.auditLog.findFirstOrThrow({ where: { tenantId: ws.workspaceId, action: 'agent.test_phone_call' } });
    expect(audit.metaJson).toMatchObject({ to_country: 'CA' });
    expect(JSON.stringify(audit.metaJson)).not.toContain('5550123');
  });

  it('is closed to the trial (402 PURCHASE_REQUIRED) and needs a live number (409 NO_NUMBER)', async () => {
    const trial = await createWorkspace('cmp-trial');
    await app.get(WalletService).grantTrial(trial.workspaceId);
    const trialHeaders = await auth(trial.sub, trial.workspaceId);
    const trialAgent = await publishedAgent(call, trialHeaders);
    const before = retell.countOf('createPhoneCall');
    const refused = await call('POST', `/agents/${trialAgent}/test/phone`, trialHeaders, { to: '+14165550123' });
    expect(refused.status).toBe(402);
    expect(refused.body.code).toBe('PURCHASE_REQUIRED');

    const paid = await paidWorkspace(app, 'cmp-nonumber', 'starter');
    const headers = await auth(paid.sub, paid.workspaceId);
    const agentId = await publishedAgent(call, headers);
    const none = await call('POST', `/agents/${agentId}/test/phone`, headers, { to: '+14165550123' });
    expect(none.status).toBe(409);
    expect(none.body.code).toBe('NO_NUMBER');
    expect(retell.countOf('createPhoneCall')).toBe(before);
  });

  it('refuses a destination that is not the customer’s own phone: invalid, another country, premium-rate, one of our numbers, or a line forwarded to one', async () => {
    const ws = await paidWorkspace(app, 'cmp-dest', 'starter');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers);
    const number = await liveNumber(ws.workspaceId, agentId);
    // Option B: the business line forwards to a number of ours, so ringing it loops the agent back to itself.
    const forwardedLine = `+1416555${String(Math.floor(Math.random() * 9_000) + 1_000)}`;
    await liveNumber(ws.workspaceId, agentId, { forwardingFrom: forwardedLine });
    const before = retell.countOf('createPhoneCall');
    // The number is Canadian and the workspace American, so both countries may be rung and
    // the US premium-rate number reaches the type check. One code per reason, so the portal
    // can say which (all 422 on `to`).
    await adminDb.tenant.update({ where: { id: ws.workspaceId }, data: { country: 'US' } });
    const cases: Array<[string, string]> = [
      ['+11234567890', 'VALIDATION_FAILED'],
      ['+966501234567', 'DESTINATION_COUNTRY'],
      ['+19005551234', 'DESTINATION_TYPE'],
      [number.e164, 'DESTINATION_IS_AGENT'],
      [forwardedLine, 'DESTINATION_IS_AGENT'],
    ];
    for (const [to, code] of cases) {
      const res = await call('POST', `/agents/${agentId}/test/phone`, headers, { to });
      expect(res.status, to).toBe(422);
      expect(res.body.code, to).toBe(code);
      expect((res.body.fields as Array<{ field: string }>)[0]!.field).toBe('to');
    }
    expect(retell.countOf('createPhoneCall')).toBe(before);
  });

  it('shares the browser test’s roles, kill switch and workspace isolation', async () => {
    const ws = await paidWorkspace(app, 'cmp-roles', 'starter');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers);
    await liveNumber(ws.workspaceId, agentId);
    const viewer = await addMember(ws.workspaceId, 'cmp-viewer', 'viewer');
    expect((await call('POST', `/agents/${agentId}/test/phone`, await auth(viewer.sub, ws.workspaceId), { to: '+14165550123' })).status).toBe(403);

    const other = await paidWorkspace(app, 'cmp-other', 'starter');
    expect((await call('POST', `/agents/${agentId}/test/phone`, await auth(other.sub, other.workspaceId), { to: '+14165550123' })).status).toBe(404);

    const config = app.get(PlatformConfigService);
    await config.setKillSwitch('pause_web_tests', { on: true, reason: 'e2e' });
    try {
      const paused = await call('POST', `/agents/${agentId}/test/phone`, headers, { to: '+14165550123' });
      expect(paused.status).toBe(409);
      expect(paused.body.code).toBe('TESTS_PAUSED');
    } finally {
      await config.setKillSwitch('pause_web_tests', { on: false });
    }
  });
});

describe('POST /numbers/:id/forwarding/test — "Test forwarding" (D4)', () => {
  async function forwardingSetup(label: string) {
    const ws = await paidWorkspace(app, label, 'starter');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers);
    const number = await liveNumber(ws.workspaceId, agentId, { forwardingFrom: '+14165550100' });
    return { ws, headers, agentId, number };
  }

  it('rings the original line from the number, recognises the forwarded call on the inbound path, turns it away and marks the forwarding ready', async () => {
    const { ws, headers, number } = await forwardingSetup('fwd-landed');
    const res = await call('POST', `/numbers/${number.id}/forwarding/test`, headers);
    expect(res.status).toBe(200);
    expect((res.body.forwarding as { test: { status: string } }).test.status).toBe('calling');
    const placed = lastArgs<{ fromNumber: string; toNumber: string; metadata: Record<string, unknown>; maxCallDurationMs: number }>('createPhoneCall');
    expect(placed).toMatchObject({ fromNumber: number.e164, toNumber: '+14165550100', maxCallDurationMs: 60_000 });
    expect(placed.metadata).toMatchObject({ tenant_id: ws.workspaceId, number_id: number.id, test: true });

    // A second press while it rings is refused, and places nothing.
    const before = retell.countOf('createPhoneCall');
    const again = await call('POST', `/numbers/${number.id}/forwarding/test`, headers);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('FORWARDING_TEST_IN_PROGRESS');
    expect(retell.countOf('createPhoneCall')).toBe(before);

    // A real caller while the test rings is answered as usual.
    const realId = `call_real_${randomUUID().slice(0, 8)}`;
    const real = await webhook(`/webhooks/retell/inbound/${number.token}`, {
      event: 'call_inbound',
      event_timestamp: Date.now(),
      call_inbound: { call_id: realId, from_number: '+12125550199', to_number: number.e164 },
    });
    expect(real.json().call_inbound?.reject).toBeUndefined();
    // That caller hangs up (as call_ended would free the line): the test leg holds one of
    // the plan's lines too, and the callers below must not be turned away on the cap.
    await redis.hdel(redisKeys.activeCalls(ws.workspaceId), realId);

    // The carrier forwards our own call back: busy tone, no call row, and the test lands.
    const forwardedId = `call_fwd_${randomUUID().slice(0, 8)}`;
    const forwarded = await webhook(`/webhooks/retell/inbound/${number.token}`, {
      event: 'call_inbound',
      event_timestamp: Date.now(),
      call_inbound: { call_id: forwardedId, from_number: number.e164, to_number: number.e164 },
    });
    expect(forwarded.json()).toEqual({ call_inbound: { reject: true } });
    // One call per test: the marker went with the call it turned away, so the next caller
    // who matches it — on a carrier that shows every forwarded caller as the customer's
    // line — is answered, not mistaken for the test.
    expect(await redis.get(redisKeys.forwardingTest(number.e164))).toBeNull();
    const after = await webhook(`/webhooks/retell/inbound/${number.token}`, {
      event: 'call_inbound',
      event_timestamp: Date.now(),
      call_inbound: { call_id: `call_after_${randomUUID().slice(0, 8)}`, from_number: '+14165550100', to_number: number.e164 },
    });
    expect(after.json().call_inbound?.reject).toBeUndefined();
    const landed = await waitFor('the test to land', async () => {
      const got = await call('GET', `/numbers/${number.id}`, headers);
      const forwarding = got.body.forwarding as { status: string; test: { status: string; caller_id: string | null } };
      return forwarding.test.status === 'landed' ? forwarding : null;
    });
    expect(landed).toMatchObject({ status: 'ready', test: { status: 'landed', caller_id: 'ours' } });
    expect(await adminDb.call.findUnique({ where: { id: forwardedId } })).toBeNull();
    expect(await redis.get(redisKeys.forwardingTest(number.e164))).toBeNull();
  });

  it('reads not_landed when the window closes with nothing back, a late landing still proves the forwarding, and a stale job cannot settle a newer test', async () => {
    const { ws, headers, number } = await forwardingSetup('fwd-missed');
    expect((await call('POST', `/numbers/${number.id}/forwarding/test`, headers)).status).toBe(200);
    const row = await adminDb.phoneNumber.findUniqueOrThrow({ where: { id: number.id } });
    const testId = (row.forwardingTestJson as { test_id: string }).test_id;

    const tests = app.get(ForwardingTestService);
    await tests.landed({ testId: randomUUID(), numberId: number.id, workspaceId: ws.workspaceId, callerId: 'ours' });
    expect(((await call('GET', `/numbers/${number.id}`, headers)).body.forwarding as { test: { status: string } }).test.status).toBe('calling');

    await tests.expire({ testId, numberId: number.id, workspaceId: ws.workspaceId });
    const after = (await call('GET', `/numbers/${number.id}`, headers)).body.forwarding as { status: string; test: { status: string } };
    expect(after).toMatchObject({ status: 'waiting_for_customer', test: { status: 'not_landed' } });
    // The marker outlives the ring window, so a forward the carrier sends late is still
    // turned away on the inbound path — and that landing is proof, whatever expired first.
    await tests.landed({ testId, numberId: number.id, workspaceId: ws.workspaceId, callerId: 'ours' });
    const late = (await call('GET', `/numbers/${number.id}`, headers)).body.forwarding as { status: string; test: { status: string } };
    expect(late).toMatchObject({ status: 'ready', test: { status: 'landed' } });
    // …and an expiry that runs after the landing changes nothing.
    await tests.expire({ testId, numberId: number.id, workspaceId: ws.workspaceId });
    expect(((await call('GET', `/numbers/${number.id}`, headers)).body.forwarding as { test: { status: string } }).test.status).toBe('landed');
  });

  it('is for a forwarded number only, frees the lease when the call cannot be placed, and is workspace-scoped', async () => {
    const { ws, headers, agentId, number } = await forwardingSetup('fwd-edges');
    const plain = await liveNumber(ws.workspaceId, agentId);
    const notForwarded = await call('POST', `/numbers/${plain.id}/forwarding/test`, headers);
    expect(notForwarded.status).toBe(400);
    expect(notForwarded.body.code).toBe('NOT_FORWARDING_NUMBER');

    retell.failNext('createPhoneCall');
    const failed = await call('POST', `/numbers/${number.id}/forwarding/test`, headers);
    expect(failed.status).toBe(503);
    expect(((await call('GET', `/numbers/${number.id}`, headers)).body.forwarding as { test: { status: string } }).test.status).toBe('failed');
    expect(await redis.get(redisKeys.forwardingTest(number.e164))).toBeNull();
    // …and the line it took for the call that never rang.
    expect(await redis.hgetall(redisKeys.activeCalls(ws.workspaceId))).toEqual({});

    const other = await paidWorkspace(app, 'fwd-other', 'starter');
    expect((await call('POST', `/numbers/${number.id}/forwarding/test`, await auth(other.sub, other.workspaceId))).status).toBe(404);
    const viewer = await addMember(ws.workspaceId, 'fwd-viewer', 'viewer');
    expect((await call('POST', `/numbers/${number.id}/forwarding/test`, await auth(viewer.sub, ws.workspaceId))).status).toBe(403);
  });

  it('passes what every test call passes: the kill switch, a free line, credits the live calls leave, and it takes its line before dialling', async () => {
    const { ws, headers, number } = await forwardingSetup('fwd-gates');
    const test = () => call('POST', `/numbers/${number.id}/forwarding/test`, headers);
    const before = retell.countOf('createPhoneCall');

    const config = app.get(PlatformConfigService);
    await config.setKillSwitch('pause_web_tests', { on: true, reason: 'e2e' });
    try {
      expect((await test()).body.code).toBe('TESTS_PAUSED');
    } finally {
      await config.setKillSwitch('pause_web_tests', { on: false });
    }

    const active = redisKeys.activeCalls(ws.workspaceId);
    const cap = (await config.capsFor(ws.workspaceId)).concurrency_cap;
    const until = Date.now() + 600_000;
    for (let i = 0; i < cap; i += 1) await redis.hset(active, `call_live_${i}`, encodeActive(0.01, until));
    const busy = await test();
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe('CONCURRENCY_LIMIT');

    await redis.del(active);
    await redis.hset(active, 'call_holding_all', encodeActive(await app.get(WalletService).balance(ws.workspaceId), until));
    const held = await test();
    expect(held.status).toBe(402);
    expect(held.body.code).toBe('NO_CREDITS');
    expect(retell.countOf('createPhoneCall')).toBe(before);

    await redis.del(active);
    expect((await test()).status).toBe(200);
    // The line was taken before dialling and moved to the call once it had an id.
    const fields = Object.keys(await redis.hgetall(active));
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatch(/^call_out_/);
    await redis.del(active, redisKeys.forwardingTest(number.e164));
  });
});

describe('the website widget (§11.5)', () => {
  async function widgetSetup(label: string, origins?: string[]) {
    const ws = await paidWorkspace(app, label, 'starter');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers);
    await adminDb.agent.update({ where: { id: agentId }, data: { status: 'live' } });
    const res = await call('PUT', `/agents/${agentId}/widget`, headers, { enabled: true, ...(origins ? { allowed_origins: origins } : {}) });
    expect(res.status).toBe(200);
    return { ws, headers, agentId, key: res.body.key as string };
  }

  /** As the `/embed/` frame sends it: from the portal's origin. */
  const publicCall = (key: string, body: unknown = {}, ip = '203.0.113.7', origin: string | null = portalUrl()) =>
    app.inject({
      method: 'POST',
      url: `/widget/${key}/call`,
      headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
      payload: JSON.stringify(body),
      remoteAddress: ip,
    });

  it('owner and admin turn it on (a key is minted once), every member reads it, and the public config names nothing private', async () => {
    const ws = await paidWorkspace(app, 'wg-settings', 'starter');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers);
    expect((await call('GET', `/agents/${agentId}/widget`, headers)).body).toEqual({ enabled: false, key: null, allowed_origins: [], agent_live: true });

    const editor = await addMember(ws.workspaceId, 'wg-editor', 'editor');
    const editorHeaders = await auth(editor.sub, ws.workspaceId);
    expect((await call('PUT', `/agents/${agentId}/widget`, editorHeaders, { enabled: true })).status).toBe(403);
    expect((await call('GET', `/agents/${agentId}/widget`, editorHeaders)).status).toBe(200);

    const on = await call('PUT', `/agents/${agentId}/widget`, headers, { enabled: true, allowed_origins: ['Example.com/contact', 'https://example.com'] });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ enabled: true, allowed_origins: ['https://example.com'] });
    const key = on.body.key as string;
    expect(key).toMatch(/^wk_[0-9a-f]{32}$/);
    expect((await call('PUT', `/agents/${agentId}/widget`, headers, { enabled: false })).body).toMatchObject({ enabled: false, key });
    expect((await call('PUT', `/agents/${agentId}/widget`, headers, { allowed_origins: ['ftp://example.com'] })).status).toBe(422);
    const rotated = await call('PUT', `/agents/${agentId}/widget`, headers, { enabled: true, rotate_key: true });
    expect(rotated.body.key).not.toBe(key);

    const config = await app.inject({ method: 'GET', url: `/widget/${rotated.body.key as string}` });
    expect(config.statusCode).toBe(200);
    expect(Object.keys(config.json()).sort()).toEqual(['agent_name', 'business_name', 'language']);
    expect((await app.inject({ method: 'GET', url: `/widget/${key}` })).statusCode).toBe(404);
  });

  it('mints a browser call on the published version for a stranger, marked as a real call', async () => {
    const { ws, agentId, key } = await widgetSetup('wg-mint');
    const agent = await adminDb.agent.findUniqueOrThrow({ where: { id: agentId } });
    const published = await adminDb.agentVersion.findUniqueOrThrow({ where: { agentId_versionNo: { agentId, versionNo: agent.publishedVersion! } } });
    const res = await publicCall(key);
    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    expect(Object.keys(body)).not.toContain('balance');
    expect(Object.keys(body)).not.toContain('rate');
    const minted = lastArgs<{ agentId: string; agentVersion: number; metadata: Record<string, unknown> }>('createWebCall');
    expect(minted).toMatchObject({ agentId: agent.retellAgentId, agentVersion: published.retellAgentVersion });
    expect(minted.metadata).toEqual({ tenant_id: ws.workspaceId, agent_id: agentId, version_no: agent.publishedVersion, tier: agent.tier, test: false, widget: true });
  });

  it('refuses a page not on the list, a widget switched off, a paused agent and an empty wallet — without saying which', async () => {
    const { ws, headers, agentId, key } = await widgetSetup('wg-refuse', ['https://maple-dental.example']);
    const before = retell.countOf('createWebCall');
    // Only our embed frame calls this route, and a browser always names the portal as its
    // origin: a request with none (curl, a script) or another site's is refused first.
    for (const origin of [null, 'https://copycat.example']) {
      const res = await publicCall(key, { page_origin: 'https://maple-dental.example' }, '203.0.113.19', origin);
      expect(res.statusCode, String(origin)).toBe(403);
      expect(res.json().code).toBe('ORIGIN_NOT_ALLOWED');
    }
    const foreign = await publicCall(key, { page_origin: 'https://copycat.example' }, '203.0.113.20');
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().code).toBe('ORIGIN_NOT_ALLOWED');
    expect((await publicCall(key, {}, '203.0.113.21')).statusCode).toBe(403);
    expect((await publicCall(key, { page_origin: 'https://maple-dental.example' }, '203.0.113.22')).statusCode).toBe(201);

    await adminDb.agent.update({ where: { id: agentId }, data: { status: 'paused' } });
    const paused = await publicCall(key, { page_origin: 'https://maple-dental.example' }, '203.0.113.23');
    expect(paused.statusCode).toBe(409);
    expect(paused.json().code).toBe('WIDGET_UNAVAILABLE');
    await adminDb.agent.update({ where: { id: agentId }, data: { status: 'live' } });

    const wallet = app.get(WalletService);
    await wallet.debit(ws.workspaceId, { credits: await wallet.balance(ws.workspaceId), reason: 'adjustment', refType: 'e2e', refId: `drain-${randomUUID()}` });
    const empty = await publicCall(key, { page_origin: 'https://maple-dental.example' }, '203.0.113.24');
    expect(empty.json()).toMatchObject({ code: 'WIDGET_UNAVAILABLE' });
    expect(empty.json().message).toBe(paused.json().message);

    expect((await call('PUT', `/agents/${agentId}/widget`, headers, { enabled: false })).status).toBe(200);
    expect((await publicCall(key, { page_origin: 'https://maple-dental.example' }, '203.0.113.25')).statusCode).toBe(404);
    expect(retell.countOf('createWebCall')).toBe(before + 1);
  });

  it(`answers 429 past ${WIDGET_CALLS_PER_IP} calls from one visitor address, and that address cannot spend the widget’s hour for everyone else`, async () => {
    const { ws, key } = await widgetSetup('wg-ip');
    // Each call ends before the next (as call_ended would free it), so the plan's lines are not what refuses.
    const hangUp = () => redis.del(redisKeys.activeCalls(ws.workspaceId));
    for (let i = 0; i < WIDGET_CALLS_PER_IP; i += 1) {
      expect((await publicCall(key, {}, '198.51.100.9')).statusCode).toBe(201);
      await hangUp();
    }
    const limited = await publicCall(key, {}, '198.51.100.9');
    expect(limited.statusCode).toBe(429);
    // Past the widget's hourly budget, from that one address: every attempt is refused on its own window.
    for (let i = 0; i < WIDGET_CALLS_PER_HOUR; i += 1) expect((await publicCall(key, {}, '198.51.100.9')).statusCode).toBe(429);
    expect((await publicCall(key, {}, '198.51.100.10')).statusCode).toBe(201);
    await hangUp();
  });

  it('counts an IPv6 visitor by its /64, so rotating addresses does not reset the window', async () => {
    const { ws, key } = await widgetSetup('wg-ipv6');
    const hangUp = () => redis.del(redisKeys.activeCalls(ws.workspaceId));
    for (let i = 1; i <= WIDGET_CALLS_PER_IP; i += 1) {
      expect((await publicCall(key, {}, `2001:db8:17:4::${i.toString(16)}`)).statusCode).toBe(201);
      await hangUp();
    }
    expect((await publicCall(key, {}, '2001:db8:17:4:beef::1')).statusCode).toBe(429);
    expect((await publicCall(key, {}, '2001:db8:17:5::1')).statusCode).toBe(201);
    await hangUp();
  });

  it('takes a line atomically: strangers pressing at once get no more calls than the plan has lines (ADR 0011 §1)', async () => {
    const { ws, key } = await widgetSetup('wg-burst');
    const cap = (await app.get(PlatformConfigService).capsFor(ws.workspaceId)).concurrency_cap;
    expect(cap).toBeGreaterThan(0);
    const presses = await Promise.all(Array.from({ length: cap + 4 }, (_, i) => publicCall(key, {}, `192.0.2.${100 + i}`)));
    const minted = presses.filter((r) => r.statusCode === 201);
    expect(minted).toHaveLength(cap);
    for (const r of presses.filter((p) => p.statusCode !== 201)) expect(r.json().code).toBe('WIDGET_UNAVAILABLE');
    const held = await redis.hgetall(redisKeys.activeCalls(ws.workspaceId));
    expect(Object.keys(held).sort()).toEqual(minted.map((r) => (r.json() as { call_id: string }).call_id).sort());
    await redis.del(redisKeys.activeCalls(ws.workspaceId));
  });

  it('exit check: a widget call is recorded with channel=web, is not a test, and appears in D2 and the D1 channel split', async () => {
    const { ws, headers, agentId, key } = await widgetSetup('wg-exit');
    const minted = (await publicCall(key, {}, '192.0.2.44')).json() as { call_id: string };
    const metadata = lastArgs<{ metadata: Record<string, unknown> }>('createWebCall').metadata;
    const start = Date.now() - 90_000;
    const lifecycle = (event: string, extra: Record<string, unknown>) => ({
      event,
      event_timestamp: Date.now(),
      call: { call_id: minted.call_id, call_type: 'web_call', agent_id: 'agent_whatever', metadata, start_timestamp: start, ...extra },
    });
    expect((await webhook('/webhooks/retell', lifecycle('call_started', {}))).statusCode).toBeLessThan(300);
    expect((await webhook('/webhooks/retell', lifecycle('call_ended', { end_timestamp: start + 60_000, disconnection_reason: 'user_hangup', call_status: 'ended' }))).statusCode).toBeLessThan(300);

    const row = await waitFor('the widget call billed', async () => {
      const r = await adminDb.call.findUnique({ where: { id: minted.call_id } });
      return r?.creditsCharged != null ? r : null;
    });
    expect(row).toMatchObject({ channel: 'web', isTest: false, agentId, durationS: 60 });

    const list = await call('GET', '/calls?channel=web&is_test=false', headers);
    expect(list.status).toBe(200);
    expect((list.body.items as Array<Record<string, unknown>>).map((c) => [c.id, c.channel, c.is_test])).toContainEqual([minted.call_id, 'web', false]);

    const stats = await call('GET', '/stats?range=today', headers);
    expect((stats.body.by_channel as { web: { calls: number; minutes: number } }).web).toMatchObject({ calls: 1, minutes: 1 });
    expect(await app.get(WalletService).balance(ws.workspaceId)).toBeLessThan(150);
  });
});
