import { randomUUID } from 'node:crypto';
import { adminDb } from '@portal/db';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isEnvelope } from '../src/modules/crypto';
import { numberNickname } from '../src/modules/numbers';
import { RedisCache, redisKeys } from '../src/modules/redis';
import { type FakeRetellGateway, addMember, createWorkspace, startD5Harness } from './d5-fixtures';
import { authFor, caller, paidWorkspace, publishedAgent, waitForNumber } from './d6-fixtures';

/*
 * §11 numbers (D6): the W6 plan for the three options, SIP credentials at rest, buy and
 * import through the provisioning job against the Retell double, PATCH and DELETE, the
 * forwarding guide, plan caps, and workspace isolation.
 */

let app: NestFastifyApplication;
let retell: FakeRetellGateway;
let stop: () => Promise<void>;
let auth: ReturnType<typeof authFor>;
let call: ReturnType<typeof caller>;

beforeAll(async () => {
  const harness = await startD5Harness({ workers: true });
  app = harness.app;
  retell = harness.retell;
  stop = harness.stop;
  auth = authFor(harness.customerTenant);
  call = caller(app);
});

afterAll(async () => {
  await stop?.();
  await adminDb.$disconnect();
});

describe('PUT /agents/:id/phone-plan', () => {
  it('stores Option A and replaces it in place on a second PUT', async () => {
    const ws = await paidWorkspace(app, 'plan', 'growth');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers, { publish: false });

    const first = await call('PUT', `/agents/${agentId}/phone-plan`, headers, { option: 'new', country: 'CA', area_code: '450', hours_mode: 'business', transfer_targets: [{ label: 'Front desk', number: '+15145550100' }] });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ option: 'new', country: 'CA', area_code: '450', status: 'pending', sip: null, transfer_targets: [{ label: 'Front desk', number: '+15145550100' }] });

    const second = await call('PUT', `/agents/${agentId}/phone-plan`, headers, { option: 'forward', country: 'CA', existing_number: '+15145550199', carrier: 'bell' });
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body).toMatchObject({ option: 'forward', existing_number: '+15145550199', carrier: 'bell', country: 'CA', area_code: null });
    expect(await adminDb.phonePlan.count({ where: { agentId } })).toBe(1);
    expect((await call('GET', `/agents/${agentId}/phone-plan`, headers)).body.option).toBe('forward');
  });

  it('Option C needs the sip_import gate, encrypts the password at rest and never returns it', async () => {
    const growth = await paidWorkspace(app, 'plan-sip-growth', 'growth');
    const growthAuth = await auth(growth.sub, growth.workspaceId);
    const growthAgent = await publishedAgent(call, growthAuth, { publish: false });
    const gated = await call('PUT', `/agents/${growthAgent}/phone-plan`, growthAuth, { option: 'sip', sip: { number: '+14505550123', host: 'sip.example.com', username: 'trunk', password: 'Tr0nk-pa55' } });
    expect(gated.status).toBe(400);
    expect(gated.body.code).toBe('PLAN_LIMIT');

    const scale = await paidWorkspace(app, 'plan-sip-scale', 'scale');
    const scaleAuth = await auth(scale.sub, scale.workspaceId);
    const agentId = await publishedAgent(call, scaleAuth, { publish: false });
    const saved = await call('PUT', `/agents/${agentId}/phone-plan`, scaleAuth, { option: 'sip', sip: { number: '+14505550123', host: 'sip.example.com', username: 'trunk', password: 'Tr0nk-pa55' } });
    expect(saved.status).toBe(200);
    expect(saved.body.sip).toEqual({ number: '+14505550123', host: 'sip.example.com', username: 'trunk', has_password: true });
    expect(JSON.stringify(saved.body)).not.toContain('Tr0nk-pa55');

    const row = await adminDb.phonePlan.findUniqueOrThrow({ where: { id: saved.body.id as string } });
    const stored = row.sipJson as { password: unknown; host: string };
    expect(isEnvelope(stored.password)).toBe(true);
    expect(JSON.stringify(row)).not.toContain('Tr0nk-pa55');
    expect(JSON.stringify(row)).not.toContain(Buffer.from('Tr0nk-pa55').toString('base64'));
    // The audit row records that a password exists, never what it is.
    const audit = await adminDb.auditLog.findFirst({ where: { tenantId: scale.workspaceId, action: 'phone_plan.created' } });
    expect(JSON.stringify(audit)).not.toContain('Tr0nk-pa55');
    expect(audit?.metaJson).toMatchObject({ has_sip_password: true });

    // Switching away from SIP leaves no credentials behind.
    const switched = await call('PUT', `/agents/${agentId}/phone-plan`, scaleAuth, { option: 'new', country: 'US' });
    expect(switched.body.sip).toBeNull();
    expect((await adminDb.phonePlan.findUniqueOrThrow({ where: { id: row.id } })).sipJson).toBeNull();
  });

  it('porting is refused, and a plan cannot be set on another workspace\'s agent', async () => {
    const ws = await paidWorkspace(app, 'plan-port', 'growth');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers, { publish: false });
    const port = await call('PUT', `/agents/${agentId}/phone-plan`, headers, { option: 'port' });
    expect(port.status).toBe(400);

    const other = await paidWorkspace(app, 'plan-other', 'growth');
    const otherAuth = await auth(other.sub, other.workspaceId);
    expect((await call('PUT', `/agents/${agentId}/phone-plan`, otherAuth, { option: 'new', country: 'CA' })).status).toBe(404);
    expect((await call('GET', `/agents/${agentId}/phone-plan`, otherAuth)).status).toBe(404);
  });
});

describe('POST /numbers/buy and the provisioning job', () => {
  it('needs a paid purchase, then buys, binds latest_published to our inbound webhook and goes active', async () => {
    const trial = await createWorkspace('buy-trial');
    const trialAuth = await auth(trial.sub, trial.workspaceId);
    const trialAgent = await publishedAgent(call, trialAuth);
    const refused = await call('POST', '/numbers/buy', trialAuth, { agent_id: trialAgent, country: 'CA' });
    expect(refused.status).toBe(402);
    expect(refused.body.code).toBe('NO_CREDITS');

    const ws = await paidWorkspace(app, 'buy', 'growth');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers);
    const accepted = await call('POST', '/numbers/buy', headers, { agent_id: agentId, country: 'CA', area_code: '450', nickname: 'Main line' });
    expect(accepted.status).toBe(202);
    const number = accepted.body.number as Record<string, unknown>;
    expect(number).toMatchObject({ status: 'provisioning', e164: null, kind: 'bought', agent_id: agentId, nickname: 'Main line' });

    const row = await waitForNumber(number.id as string);
    expect(row.status).toBe('active');
    expect(row.e164).toMatch(/^\+1450\d{7}$/);
    expect(row.nextRentalAt).toBeTruthy();

    const platform = retell.phoneNumbers.get(row.e164!)!;
    const agent = await adminDb.agent.findUniqueOrThrow({ where: { id: agentId } });
    expect(platform.inbound_agents).toEqual([{ agent_id: agent.retellAgentId, agent_version: 'latest_published', weight: 1 }]);
    expect(platform.inbound_webhook_url).toContain(`/webhooks/retell/inbound/${row.inboundToken}`);
    expect(platform.nickname).toBe(`dev-${numberNickname(row.id)}`);
    expect(platform.nickname!.length).toBeLessThanOrEqual(40);

    // The hot path can see it.
    const cached = await app.get(RedisCache).getJson<{ number_active: boolean; agent_live: boolean }>(redisKeys.number(row.e164!));
    expect(cached).toMatchObject({ number_active: true, agent_live: true });

    const shown = await call('GET', `/numbers/${row.id}`, headers);
    expect(shown.body).toMatchObject({ status: 'active', e164: row.e164, paused: false });
    expect(JSON.stringify(shown.body)).not.toMatch(/retell|twilio|inbound_token|tok_/i);
  }, 30_000);

  it('a purchase that succeeded after our timeout is adopted, never bought twice', async () => {
    const ws = await paidWorkspace(app, 'buy-adopt', 'growth');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers);
    // The platform buys, then the next call (persisting is ours, but the *bind* read) fails once.
    retell.failNext('getPhoneNumber', 1, new Error('ETIMEDOUT'));
    const before = retell.countOf('createPhoneNumber');
    const accepted = await call('POST', '/numbers/buy', headers, { agent_id: agentId, country: 'US' });
    const row = await waitForNumber(accepted.body.number ? ((accepted.body.number as { id: string }).id) : '', 30_000);
    expect(row.status).toBe('active');
    expect(retell.countOf('createPhoneNumber') - before).toBe(1);
    expect(retell.phoneNumbers.size).toBeGreaterThan(0);
  }, 40_000);

  it('respects max_numbers for the plan tier', async () => {
    const ws = await paidWorkspace(app, 'buy-cap', 'starter');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers);
    const first = await call('POST', '/numbers/buy', headers, { agent_id: agentId, country: 'CA' });
    expect(first.status).toBe(202);
    const second = await call('POST', '/numbers/buy', headers, { agent_id: agentId, country: 'CA' });
    expect(second.status).toBe(400);
    expect(second.body.code).toBe('PLAN_LIMIT');
  });

  it('an editor cannot buy; a viewer cannot edit', async () => {
    const ws = await paidWorkspace(app, 'buy-roles', 'growth');
    const agentId = await publishedAgent(call, await auth(ws.sub, ws.workspaceId));
    const editor = await addMember(ws.workspaceId, 'editor', 'editor');
    expect((await call('POST', '/numbers/buy', await auth(editor.sub, ws.workspaceId), { agent_id: agentId, country: 'CA' })).status).toBe(403);
  });
});

describe('POST /numbers/import (Option C)', () => {
  it('imports a SIP number with the decrypted password reaching only the platform call', async () => {
    const ws = await paidWorkspace(app, 'import', 'scale');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers);
    const sipNumber = `+1450${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
    const accepted = await call('POST', '/numbers/import', headers, {
      agent_id: agentId,
      sip: { number: sipNumber, host: 'sip:pbx.example.com:5060', username: 'trunk', password: 'Imp0rt-pa55' },
    });
    expect(accepted.status).toBe(202);
    const number = accepted.body.number as Record<string, unknown>;
    expect(number).toMatchObject({ kind: 'sip', e164: sipNumber, status: 'provisioning', rental_credits: 0 });

    const row = await waitForNumber(number.id as string);
    expect(row.status).toBe('active');
    expect(row.rentalCredits).toBe(0);
    expect(row.nextRentalAt).toBeNull();
    const platform = retell.phoneNumbers.get(sipNumber)!;
    expect(platform.phone_number_type).toBe('custom');
    expect(platform.sip).toMatchObject({ termination_uri: 'sip:pbx.example.com:5060', username: 'trunk', password_seen: true });

    // Nowhere at rest, in any table, in clear.
    const plan = await adminDb.phonePlan.findUniqueOrThrow({ where: { id: row.planId! } });
    expect(JSON.stringify(plan)).not.toContain('Imp0rt-pa55');
    expect(JSON.stringify(row)).not.toContain('Imp0rt-pa55');
    expect(JSON.stringify(await adminDb.auditLog.findMany({ where: { tenantId: ws.workspaceId } }))).not.toContain('Imp0rt-pa55');
    // The double recorded the call with the password redacted, so even the test log is clean.
    expect(JSON.stringify(retell.calls.filter((c) => c.method === 'importPhoneNumber'))).not.toContain('Imp0rt-pa55');

    // D4 SIP section: host and username come back, the password only as a flag.
    const read = await call('GET', `/numbers/${row.id}`, headers);
    expect(read.body.sip).toEqual({ host: 'sip:pbx.example.com:5060', username: 'trunk', has_password: true });
    const listed = await call('GET', '/numbers', headers);
    expect(JSON.stringify(listed.body)).not.toContain('Imp0rt-pa55');
    expect(JSON.stringify(read.body)).not.toContain('Imp0rt-pa55');
  }, 30_000);
});

describe('PATCH and DELETE /numbers/:id', () => {
  it('edits routing, pauses, re-points to another published agent, and releases on the platform first', async () => {
    const ws = await paidWorkspace(app, 'patch', 'growth');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers, { name: 'Day' });
    const accepted = await call('POST', '/numbers/buy', headers, { agent_id: agentId, country: 'CA' });
    const row = await waitForNumber((accepted.body.number as { id: string }).id);
    const cache = app.get(RedisCache);

    const edited = await call('PATCH', `/numbers/${row.id}`, headers, {
      nickname: 'Reception',
      hours_mode: 'custom',
      hours_override: { days: { mon: [{ open: '09:00', close: '17:00' }] } },
      blocklist: ['+15145550666'],
      transfer_targets: [{ label: 'Owner', number: '+15145550001' }],
    });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ nickname: 'Reception', hours_mode: 'custom', blocklist: ['+15145550666'], sip: null, calls_7d: 0 });

    // D4 "calls 7d": this week's calls on this number, declined ones included; last month's
    // are not. Counted on when the call started, not on when the row was written: a call
    // `call-recovery` learned about late still belongs to the day it rang.
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3_600_000);
    await adminDb.call.createMany({
      data: [
        { tenantId: ws.workspaceId, numberId: row.id, id: `c7-${randomUUID()}`, channel: 'phone', status: 'ended', direction: 'inbound', startedAt: new Date() },
        { tenantId: ws.workspaceId, numberId: row.id, id: `c7-${randomUUID()}`, channel: 'phone', status: 'declined', direction: 'inbound', startedAt: new Date() },
        { tenantId: ws.workspaceId, numberId: row.id, id: `c7-${randomUUID()}`, channel: 'phone', status: 'ended', direction: 'inbound', startedAt: tenDaysAgo, createdAt: tenDaysAgo },
        { tenantId: ws.workspaceId, numberId: row.id, id: `c7-${randomUUID()}`, channel: 'phone', status: 'ended', direction: 'inbound', startedAt: tenDaysAgo, createdAt: new Date() },
      ],
    });
    expect((await call('GET', `/numbers/${row.id}`, headers)).body.calls_7d).toBe(2);
    expect(((await call('GET', '/numbers', headers)).body as unknown as Array<{ id: string; calls_7d: number }>).find((n) => n.id === row.id)?.calls_7d).toBe(2);
    // The record merges the number's list with the global phone blocklist (SA12), so "contains", not "equals".
    const cachedAfterEdit = await cache.getJson<{ blocklist: string[]; hours_mode: string; hours: unknown }>(redisKeys.number(row.e164!));
    expect(cachedAfterEdit?.blocklist).toContain('+15145550666');
    expect(cachedAfterEdit).toMatchObject({ hours_mode: 'custom', hours: { days: { mon: [{ open: '09:00', close: '17:00' }] } } });

    const paused = await call('PATCH', `/numbers/${row.id}`, headers, { paused: true });
    expect(paused.body).toMatchObject({ paused: true, status: 'paused' });
    expect(await cache.getJson<{ number_paused: boolean }>(redisKeys.number(row.e164!))).toMatchObject({ number_paused: true });
    expect((await call('PATCH', `/numbers/${row.id}`, headers, { paused: false })).body).toMatchObject({ paused: false, status: 'active' });

    // Re-point: only at a published agent, and the platform binding follows.
    const draftAgent = await publishedAgent(call, headers, { publish: false, name: 'Draft' });
    const refused = await call('PATCH', `/numbers/${row.id}`, headers, { agent_id: draftAgent });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('AGENT_NOT_PUBLISHED');
    const nightAgent = await publishedAgent(call, headers, { name: 'Night' });
    const repointed = await call('PATCH', `/numbers/${row.id}`, headers, { agent_id: nightAgent });
    expect(repointed.body.agent_id).toBe(nightAgent);
    const night = await adminDb.agent.findUniqueOrThrow({ where: { id: nightAgent } });
    expect(retell.phoneNumbers.get(row.e164!)!.inbound_agents[0]!.agent_id).toBe(night.retellAgentId);

    // Provider identity is not editable through the request shape: the key is unknown to the
    // schema, so the body is "nothing to update" and refused before the service.
    const identity = await call('PATCH', `/numbers/${row.id}`, headers, { e164: '+19999999999' });
    expect(identity.status).toBe(422);
    expect((await adminDb.phoneNumber.findUniqueOrThrow({ where: { id: row.id } })).e164).toBe(row.e164);

    // Release: platform first, row kept as released, cache key gone, forwarding guide still works.
    const released = await call('DELETE', `/numbers/${row.id}`, headers);
    expect(released.body).toEqual({ released: true });
    expect(retell.phoneNumbers.has(row.e164!)).toBe(false);
    const after = await adminDb.phoneNumber.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('released');
    expect(after.releasedAt).toBeTruthy();
    expect(await cache.get(redisKeys.number(row.e164!))).toBeNull();
    expect((await call('DELETE', `/numbers/${row.id}`, headers)).body).toEqual({ released: false });
  }, 40_000);

  it('Option B: the number is active but the forwarding waits for the customer until they confirm', async () => {
    const ws = await paidWorkspace(app, 'forward', 'growth');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers);
    const accepted = await call('POST', '/numbers/buy', headers, { agent_id: agentId, country: 'CA', forward_from: '+15145550100', carrier: 'bell' });
    const row = await waitForNumber((accepted.body.number as { id: string }).id);
    expect(row.status).toBe('active');
    const shown = await call('GET', `/numbers/${row.id}`, headers);
    expect(shown.body.forwarding).toEqual({ from: '+15145550100', status: 'waiting_for_customer', carrier: 'bell' });

    const guide = await call('GET', `/numbers/forwarding-guide?carrier=bell&destination=${encodeURIComponent(row.e164!)}`, headers);
    expect(guide.status).toBe(200);
    expect((guide.body.steps as string[]).join(' ')).toContain(row.e164!);

    const confirmed = await call('PATCH', `/numbers/${row.id}`, headers, { forwarding_confirmed: true });
    expect((confirmed.body.forwarding as { status: string }).status).toBe('ready');
  }, 30_000);

  it('another workspace gets 404 on every route for a number it does not own', async () => {
    const owner = await paidWorkspace(app, 'iso-owner', 'growth');
    const ownerAuth = await auth(owner.sub, owner.workspaceId);
    const agentId = await publishedAgent(call, ownerAuth);
    const accepted = await call('POST', '/numbers/buy', ownerAuth, { agent_id: agentId, country: 'CA' });
    const row = await waitForNumber((accepted.body.number as { id: string }).id);

    const other = await paidWorkspace(app, 'iso-other', 'growth');
    const otherAuth = await auth(other.sub, other.workspaceId);
    expect((await call('GET', `/numbers/${row.id}`, otherAuth)).status).toBe(404);
    expect((await call('PATCH', `/numbers/${row.id}`, otherAuth, { nickname: 'stolen' })).status).toBe(404);
    expect((await call('DELETE', `/numbers/${row.id}`, otherAuth)).status).toBe(404);
    expect((await call('GET', '/numbers', otherAuth)).body).toEqual([]);
    expect((await adminDb.phoneNumber.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('active');
    // And a number cannot be bought for another workspace's agent.
    expect((await call('POST', '/numbers/buy', otherAuth, { agent_id: agentId, country: 'CA' })).status).toBe(404);
  }, 30_000);
});
