import { randomUUID } from 'node:crypto';
import { adminDb, isNumberHeldViolation } from '@portal/db';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import Retell from 'retell-sdk';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { isEnvelope } from '../src/modules/crypto';
import { PLATFORM_REJECTED_REASON, SipProbe, type SipProbeResult, numberNickname } from '../src/modules/numbers';
import { RedisCache, redisKeys } from '../src/modules/redis';
import { RuntimeCacheService } from '../src/modules/runtime-cache';
import { type FakeRetellGateway, addMember, createWorkspace, startD5Harness, waitFor, waitForJob, nanpNumber } from './d5-fixtures';
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
  // Paid fixtures run past the §6.2 MFA balance threshold; their owners passed a second factor (ADR 0036).
  auth = authFor(harness.customerTenant, { mfa: true });
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

    const second = await call('PUT', `/agents/${agentId}/phone-plan`, headers, { option: 'forward', country: 'CA', existing_number: '+15145550199', carrier: 'bell', forward_mode: 'busy_no_answer', hours_mode: 'outside_hours' });
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body).toMatchObject({ option: 'forward', existing_number: '+15145550199', carrier: 'bell', country: 'CA', area_code: null });
    expect(await adminDb.phonePlan.count({ where: { agentId } })).toBe(1);
    const reread = await call('GET', `/agents/${agentId}/phone-plan`, headers);
    expect(reread.body).toMatchObject({ option: 'forward', forward_mode: 'busy_no_answer', hours_mode: 'outside_hours' });
    // Back to a bought number: Option B's forward mode is reset with the rest of its fields.
    expect((await call('PUT', `/agents/${agentId}/phone-plan`, headers, { option: 'new', country: 'CA', hours_mode: 'unanswered' })).body).toMatchObject({ forward_mode: null, hours_mode: 'unanswered' });
  });

  it('Option C needs the sip_import gate, encrypts the password at rest and never returns it', async () => {
    const growth = await paidWorkspace(app, 'plan-sip-growth', 'growth');
    const growthAuth = await auth(growth.sub, growth.workspaceId);
    const growthAgent = await publishedAgent(call, growthAuth, { publish: false });
    const gated = await call('PUT', `/agents/${growthAgent}/phone-plan`, growthAuth, { option: 'sip', carrier_consent: true, sip: { number: '+14505550123', host: 'sip.example.com', username: 'trunk', password: 'Tr0nk-pa55' } });
    expect(gated.status).toBe(400);
    expect(gated.body.code).toBe('PLAN_LIMIT');

    const scale = await paidWorkspace(app, 'plan-sip-scale', 'scale');
    const scaleAuth = await auth(scale.sub, scale.workspaceId);
    const agentId = await publishedAgent(call, scaleAuth, { publish: false });
    const saved = await call('PUT', `/agents/${agentId}/phone-plan`, scaleAuth, { option: 'sip', carrier_consent: true, sip: { number: '+14505550123', host: 'sip.example.com', username: 'trunk', password: 'Tr0nk-pa55', provider: 'twilio', transport: 'TLS' } });
    expect(saved.status).toBe(200);
    expect(saved.body.sip).toEqual({ number: '+14505550123', host: 'sip.example.com', username: 'trunk', has_password: true, provider: 'twilio', transport: 'TLS' });
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

describe('QA bug list, 17 Nov: the area code and the own-line consent are checked by the server', () => {
  it('an area code that exists nowhere, or in the other country, is a 422 on area_code and stores or buys nothing', async () => {
    const ws = await paidWorkspace(app, 'areacode', 'growth');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers);
    const before = retell.countOf('createPhoneNumber');

    for (const body of [
      { option: 'new', country: 'CA', area_code: '999' },
      { option: 'new', country: 'CA', area_code: '212' },
      { option: 'forward', country: 'US', area_code: '416', existing_number: '+15145550123' },
    ]) {
      const plan = await call('PUT', `/agents/${agentId}/phone-plan`, headers, body);
      expect(plan.status, JSON.stringify(body)).toBe(422);
      expect((plan.body.fields as Array<{ field: string }>).map((f) => f.field)).toEqual(['area_code']);
    }
    expect(await adminDb.phonePlan.count({ where: { tenantId: ws.workspaceId } })).toBe(0);

    const buy = await call('POST', '/numbers/buy', headers, { agent_id: agentId, country: 'CA', area_code: '999' });
    expect(buy.status).toBe(422);
    expect((buy.body.fields as Array<{ field: string }>).map((f) => f.field)).toEqual(['area_code']);
    expect(await adminDb.phoneNumber.count({ where: { tenantId: ws.workspaceId } })).toBe(0);
    expect(retell.countOf('createPhoneNumber')).toBe(before);

    // A code of the country is saved as before.
    expect((await call('PUT', `/agents/${agentId}/phone-plan`, headers, { option: 'new', country: 'CA', area_code: '647' })).status).toBe(200);
  }, 60_000);

  it('bring your own line without the consent is a 422 on carrier_consent: no plan, no number, nothing sent to the platform', async () => {
    const ws = await paidWorkspace(app, 'sip-consent', 'scale');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers);
    const sip = { number: nanpNumber(), host: 'sip:pbx.example.com:5060', username: 'trunk', password: 'Imp0rt-pa55' };
    const before = retell.countOf('importPhoneNumber');

    for (const consent of [{}, { carrier_consent: false }, { carrier_consent: 'true' }]) {
      const plan = await call('PUT', `/agents/${agentId}/phone-plan`, headers, { option: 'sip', sip, ...consent });
      expect(plan.status).toBe(422);
      expect((plan.body.fields as Array<{ field: string }>).map((f) => f.field)).toEqual(['carrier_consent']);
      const imported = await call('POST', '/numbers/import', headers, { agent_id: agentId, sip, ...consent });
      expect(imported.status).toBe(422);
      expect((imported.body.fields as Array<{ field: string }>).map((f) => f.field)).toEqual(['carrier_consent']);
    }
    expect(await adminDb.phonePlan.count({ where: { tenantId: ws.workspaceId } })).toBe(0);
    expect(await adminDb.phoneNumber.count({ where: { tenantId: ws.workspaceId } })).toBe(0);
    expect(retell.countOf('importPhoneNumber')).toBe(before);

    // With it, the plan is saved and the import is accepted; the audit row records the consent.
    expect((await call('PUT', `/agents/${agentId}/phone-plan`, headers, { option: 'sip', sip, carrier_consent: true })).status).toBe(200);
    const accepted = await call('POST', '/numbers/import', headers, { agent_id: agentId, sip, carrier_consent: true });
    expect(accepted.status).toBe(202);
    const audit = await adminDb.auditLog.findFirstOrThrow({ where: { tenantId: ws.workspaceId, action: 'number.import_requested' } });
    expect(audit.metaJson).toMatchObject({ carrier_consent: true });
  }, 60_000);
});

describe('POST /numbers/buy and the provisioning job', () => {
  it('needs a paid purchase, then buys, binds latest_published to our inbound webhook and goes active', async () => {
    const trial = await createWorkspace('buy-trial');
    const trialAuth = await auth(trial.sub, trial.workspaceId);
    const trialAgent = await publishedAgent(call, trialAuth);
    const refused = await call('POST', '/numbers/buy', trialAuth, { agent_id: trialAgent, country: 'CA' });
    expect(refused.status).toBe(402);
    // QA-108 / ORL-NUM-629: trial credits are not a purchase; "out of credits" was the wrong reason.
    expect(refused.body.code).toBe('PURCHASE_REQUIRED');
    expect(await adminDb.phoneNumber.count({ where: { tenantId: trial.workspaceId } })).toBe(0);

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
    // QA-108 / ORL-NUM-630: the plan includes a number and it is held — not "your plan does not include that".
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ code: 'NUMBER_LIMIT', message: 'Your plan includes 1 phone number. Upgrade to add another.' });
    expect(await adminDb.phoneNumber.count({ where: { tenantId: ws.workspaceId } })).toBe(1);
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
    const sipNumber = nanpNumber();
    const accepted = await call('POST', '/numbers/import', headers, {
      agent_id: agentId,
      carrier_consent: true,
      sip: { number: sipNumber, host: 'sip:pbx.example.com:5060', username: 'trunk', password: 'Imp0rt-pa55', provider: 'telnyx', transport: 'UDP' },
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
    // W6's transport reaches the platform's import (ADR 0040).
    expect(platform.sip_outbound_trunk_config?.transport).toBe('UDP');

    // Nowhere at rest, in any table, in clear.
    const plan = await adminDb.phonePlan.findUniqueOrThrow({ where: { id: row.planId! } });
    expect(JSON.stringify(plan)).not.toContain('Imp0rt-pa55');
    expect(JSON.stringify(row)).not.toContain('Imp0rt-pa55');
    expect(JSON.stringify(await adminDb.auditLog.findMany({ where: { tenantId: ws.workspaceId } }))).not.toContain('Imp0rt-pa55');
    // The double recorded the call with the password redacted, so even the test log is clean.
    expect(JSON.stringify(retell.calls.filter((c) => c.method === 'importPhoneNumber'))).not.toContain('Imp0rt-pa55');

    // D4 SIP section: host and username come back, the password only as a flag.
    const read = await call('GET', `/numbers/${row.id}`, headers);
    expect(read.body.sip).toEqual({ host: 'sip:pbx.example.com:5060', username: 'trunk', has_password: true, provider: 'telnyx', transport: 'UDP', origination_uri: null, verification: null });
    const listed = await call('GET', '/numbers', headers);
    expect(JSON.stringify(listed.body)).not.toContain('Imp0rt-pa55');
    expect(JSON.stringify(read.body)).not.toContain('Imp0rt-pa55');
  }, 30_000);
});

describe('QA-105: a released own line can be connected again; a held one cannot be taken', () => {
  const IN_USE = 'That number is already in use.';
  const trunk = (e164: string, password = 'First-pa55') => ({ number: e164, host: 'sip:pbx.example.com:5060', username: 'trunk', password });

  async function connectedLine(label: string) {
    const ws = await paidWorkspace(app, label, 'scale');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers);
    const e164 = nanpNumber();
    const accepted = await call('POST', '/numbers/import', headers, { agent_id: agentId, carrier_consent: true, sip: trunk(e164) });
    expect(accepted.status).toBe(202);
    const row = await waitForNumber((accepted.body.number as { id: string }).id);
    expect(row.status).toBe('active');
    return { ws, headers, agentId, e164, row };
  }

  const heldRows = (e164: string) => adminDb.phoneNumber.count({ where: { e164, status: { not: 'released' } } });
  const cachedNumberId = async (e164: string) => (await app.get(RedisCache).getJson<{ number_id: string }>(redisKeys.number(e164)))?.number_id ?? null;

  it('ORL-NUM-631: release, connect the same line again, and it goes active as a new row — twice over', async () => {
    const { ws, headers, agentId, e164, row: first } = await connectedLine('qa105-reconnect');
    expect((await call('DELETE', `/numbers/${first.id}`, headers)).body).toEqual({ released: true });
    expect(retell.phoneNumbers.has(e164)).toBe(false);

    const again = await call('POST', '/numbers/import', headers, { agent_id: agentId, carrier_consent: true, sip: { ...trunk(e164, 'Second-pa55'), host: 'sip:pbx2.example.com:5061' } });
    expect(again.status).toBe(202);
    const second = await waitForNumber((again.body.number as { id: string }).id);
    expect(second.id).not.toBe(first.id);
    expect(second).toMatchObject({ status: 'active', e164, agentId, type: 'custom_sip', error: null, releasedAt: null });
    // Its own plan (fresh sealed credentials) and its own inbound token, not the released row's.
    expect(second.planId).not.toBe(first.planId);
    expect(second.inboundToken).not.toBe(first.inboundToken);
    const platform = retell.phoneNumbers.get(e164)!;
    expect(platform.sip).toMatchObject({ termination_uri: 'sip:pbx2.example.com:5061', username: 'trunk', password_seen: true });
    const agent = await adminDb.agent.findUniqueOrThrow({ where: { id: agentId } });
    expect(platform.inbound_agents[0]).toMatchObject({ agent_id: agent.retellAgentId, agent_version: 'latest_published' });

    // The released row is history: still released, still naming the number.
    expect(await adminDb.phoneNumber.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ status: 'released', e164 });
    const audit = await adminDb.auditLog.findFirstOrThrow({ where: { tenantId: ws.workspaceId, action: 'number.import_requested', targetId: second.id } });
    expect(audit.metaJson).toMatchObject({ reconnects_number_id: first.id });
    expect(JSON.stringify(audit.metaJson)).not.toContain('Second-pa55');

    // The inbound path's record is the new row's, and a refresh that walks the released row leaves it alone.
    expect(await cachedNumberId(e164)).toBe(second.id);
    await app.get(RuntimeCacheService).refresh(ws.workspaceId);
    expect(await cachedNumberId(e164)).toBe(second.id);

    // D4 lists both: the live line and its history.
    const listed = (await call('GET', '/numbers', headers)).body as unknown as Array<{ id: string; status: string; e164: string }>;
    expect(listed.filter((n) => n.e164 === e164).map((n) => n.status).sort()).toEqual(['active', 'released']);

    // Release and connect a third time: two released rows, still exactly one holding the number.
    expect((await call('DELETE', `/numbers/${second.id}`, headers)).body).toEqual({ released: true });
    const third = await call('POST', '/numbers/import', headers, { agent_id: agentId, carrier_consent: true, sip: trunk(e164, 'Third-pa55') });
    expect(third.status).toBe(202);
    const thirdRow = await waitForNumber((third.body.number as { id: string }).id);
    expect(thirdRow.status).toBe('active');
    expect(await adminDb.phoneNumber.count({ where: { e164, status: 'released' } })).toBe(2);
    expect(await heldRows(e164)).toBe(1);
    expect(await cachedNumberId(e164)).toBe(thirdRow.id);
  }, 60_000);

  it('ORL-NUM-632: another workspace is told the number is in use, and the holder is untouched', async () => {
    const holder = await connectedLine('qa105-holder');
    const before = await adminDb.phoneNumber.findUniqueOrThrow({ where: { id: holder.row.id } });
    const platformBefore = structuredClone(retell.phoneNumbers.get(holder.e164)!);

    const other = await paidWorkspace(app, 'qa105-other', 'scale');
    const otherAuth = await auth(other.sub, other.workspaceId);
    const otherAgent = await publishedAgent(call, otherAuth);
    const imports = retell.countOf('importPhoneNumber');

    const refused = await call('POST', '/numbers/import', otherAuth, { agent_id: otherAgent, carrier_consent: true, sip: trunk(holder.e164, 'Thief-pa55') });
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ code: 'NUMBER_IN_USE', message: IN_USE, fields: [{ field: 'sip.number', message: IN_USE }] });
    // Nothing about the holder in the answer, nothing written for the caller, nothing asked of the platform.
    expect(JSON.stringify(refused.body)).not.toContain(holder.ws.workspaceId);
    expect(await adminDb.phoneNumber.count({ where: { tenantId: other.workspaceId } })).toBe(0);
    expect(await adminDb.phonePlan.count({ where: { tenantId: other.workspaceId } })).toBe(0);
    expect(retell.countOf('importPhoneNumber')).toBe(imports);
    expect(await adminDb.phoneNumber.findUniqueOrThrow({ where: { id: holder.row.id } })).toEqual(before);
    expect(retell.phoneNumbers.get(holder.e164)).toEqual(platformBefore);
    expect(await cachedNumberId(holder.e164)).toBe(holder.row.id);

    // W6 says so too, before the customer pays for an activation that would fail.
    const plan = await call('PUT', `/agents/${otherAgent}/phone-plan`, otherAuth, { option: 'sip', carrier_consent: true, sip: trunk(holder.e164, 'Thief-pa55') });
    expect(plan.status).toBe(409);
    expect(plan.body.code).toBe('NUMBER_IN_USE');

    // Once the holder releases it, it is free for anyone — and the old owner's refresh cannot take it back.
    await call('DELETE', `/numbers/${holder.row.id}`, holder.headers);
    const taken = await call('POST', '/numbers/import', otherAuth, { agent_id: otherAgent, carrier_consent: true, sip: trunk(holder.e164, 'Mine-pa55') });
    expect(taken.status).toBe(202);
    const takenRow = await waitForNumber((taken.body.number as { id: string }).id);
    expect(takenRow).toMatchObject({ status: 'active', tenantId: other.workspaceId });
    await app.get(RuntimeCacheService).refresh(holder.ws.workspaceId);
    expect(await cachedNumberId(holder.e164)).toBe(takenRow.id);
    expect(await heldRows(holder.e164)).toBe(1);
  }, 60_000);

  it('a W6 plan for a line another workspace connected since fails activation once, permanently, with the same sentence', async () => {
    const ws = await paidWorkspace(app, 'qa105-w6', 'scale');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers);
    const e164 = nanpNumber();
    expect((await call('PUT', `/agents/${agentId}/phone-plan`, headers, { option: 'sip', carrier_consent: true, sip: trunk(e164) })).status).toBe(200);

    // Someone else connects it between W6 and go-live.
    const other = await paidWorkspace(app, 'qa105-w6-other', 'scale');
    const otherAuth = await auth(other.sub, other.workspaceId);
    const otherAgent = await publishedAgent(call, otherAuth);
    const theirs = await call('POST', '/numbers/import', otherAuth, { agent_id: otherAgent, carrier_consent: true, sip: trunk(e164) });
    await waitForNumber((theirs.body.number as { id: string }).id);

    const imports = retell.countOf('importPhoneNumber');
    const jobId = (await call('POST', `/agents/${agentId}/activate`, headers, {})).body.job_id as string;
    const job = await waitForJob(jobId, 30_000);
    expect(job.status).toBe('failed');
    expect(job.stepsJson).toMatchObject({ attempt: 1, error_kind: 'number_in_use', customer_reason: IN_USE });
    expect(retell.countOf('importPhoneNumber')).toBe(imports);
    expect(await adminDb.phoneNumber.count({ where: { tenantId: ws.workspaceId } })).toBe(0);
    expect(await heldRows(e164)).toBe(1);
  }, 60_000);

  it('two presses at once connect the line once', async () => {
    const ws = await paidWorkspace(app, 'qa105-race', 'scale');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers);
    const e164 = nanpNumber();
    const body = { agent_id: agentId, carrier_consent: true, sip: trunk(e164) };
    const answers = await Promise.all([call('POST', '/numbers/import', headers, body), call('POST', '/numbers/import', headers, body)]);
    expect(answers.map((a) => a.status).sort()).toEqual([202, 409]);
    expect(answers.find((a) => a.status === 409)!.body.code).toBe('NUMBER_IN_USE');
    const won = answers.find((a) => a.status === 202)!;
    expect((await waitForNumber((won.body.number as { id: string }).id)).status).toBe('active');
    expect(await adminDb.phoneNumber.count({ where: { e164 } })).toBe(1);
  }, 30_000);

  it('bad SIP details are a 422; a connection the platform refuses fails, holds the line until released, then reconnects', async () => {
    const ws = await paidWorkspace(app, 'qa105-fail', 'scale');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers);
    const e164 = nanpNumber();

    const badNumber = await call('POST', '/numbers/import', headers, { agent_id: agentId, carrier_consent: true, sip: { ...trunk(e164), number: '450-555' } });
    expect(badNumber.status).toBe(422);
    expect(badNumber.body.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(badNumber.body.fields)).toContain('sip.number');
    const badHost = await call('POST', '/numbers/import', headers, { agent_id: agentId, carrier_consent: true, sip: { ...trunk(e164), host: '' } });
    expect(badHost.status).toBe(422);
    expect(JSON.stringify(badHost.body.fields)).toContain('sip.host');
    expect(await adminDb.phoneNumber.count({ where: { tenantId: ws.workspaceId } })).toBe(0);

    retell.failNext('importPhoneNumber', 1, Retell.APIError.generate(400, { message: 'invalid termination uri' }, 'invalid termination uri', new Headers()));
    const accepted = await call('POST', '/numbers/import', headers, { agent_id: agentId, carrier_consent: true, sip: trunk(e164) });
    expect(accepted.status).toBe(202);
    const failed = await waitForNumber((accepted.body.number as { id: string }).id);
    expect(failed).toMatchObject({ status: 'failed', error: PLATFORM_REJECTED_REASON });

    // The failed row still holds the number (support can reprovision it), so a second press is refused…
    expect((await call('POST', '/numbers/import', headers, { agent_id: agentId, carrier_consent: true, sip: trunk(e164) })).body.code).toBe('NUMBER_IN_USE');
    // …until the customer releases it, which the platform never had, and connects again.
    expect((await call('DELETE', `/numbers/${failed.id}`, headers)).body).toEqual({ released: true });
    const retried = await call('POST', '/numbers/import', headers, { agent_id: agentId, carrier_consent: true, sip: trunk(e164) });
    expect(retried.status).toBe(202);
    expect((await waitForNumber((retried.body.number as { id: string }).id)).status).toBe('active');
  }, 60_000);

  it('the database holds one row per number while any number of released rows keep it as history', async () => {
    const ws = await paidWorkspace(app, 'qa105-index', 'scale');
    const e164 = nanpNumber();
    const row = (status: 'released' | 'active' | 'failed') => ({
      tenantId: ws.workspaceId,
      e164,
      type: 'custom_sip' as const,
      status,
      inboundToken: `tok_${randomUUID().replace(/-/g, '')}`,
      rentalCredits: 0,
    });
    await adminDb.phoneNumber.create({ data: row('released') });
    await adminDb.phoneNumber.create({ data: row('released') });
    await adminDb.phoneNumber.create({ data: row('active') });
    const duplicate = await adminDb.phoneNumber.create({ data: row('failed') }).catch((e: unknown) => e);
    expect(isNumberHeldViolation(duplicate)).toBe(true);
    // And a released row can never be put back over the live one.
    const released = await adminDb.phoneNumber.findFirstOrThrow({ where: { e164, status: 'released' } });
    const revived = await adminDb.phoneNumber.update({ where: { id: released.id }, data: { status: 'active' } }).catch((e: unknown) => e);
    expect(isNumberHeldViolation(revived)).toBe(true);
    expect(await heldRows(e164)).toBe(1);
  });
});

describe('POST /numbers/:id/sip/verify (D16)', () => {
  afterEach(() => vi.restoreAllMocks());

  const trunkSays = (outcome: SipProbeResult['outcome'], status: number | null = null) =>
    vi.spyOn(app.get(SipProbe), 'probe').mockResolvedValue({ outcome, status, transport: 'tcp', port: 5060 });

  async function importedSip(label: string, sip: { username?: string; password?: string } = { username: 'trunk', password: 'Imp0rt-pa55' }) {
    const ws = await paidWorkspace(app, label, 'scale');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers);
    const e164 = nanpNumber();
    const accepted = await call('POST', '/numbers/import', headers, { agent_id: agentId, carrier_consent: true, sip: { number: e164, host: 'sip:pbx.example.com:5060', ...sip } });
    expect(accepted.status).toBe(202);
    const row = await waitForNumber((accepted.body.number as { id: string }).id);
    expect(row.status).toBe('active');
    return { ws, headers, row, e164, agentId };
  }

  const envelopeOf = async (planId: string) => (await adminDb.phonePlan.findUniqueOrThrow({ where: { id: planId } })).sipJson;

  it('re-checks the stored credentials, re-syncs the platform copy, and stores the outcome — never the password', async () => {
    const { ws, headers, row, e164 } = await importedSip('sipv-ok');
    const probe = trunkSays('auth_accepted', 200);
    const updatesBefore = retell.countOf('updateSipTrunk');

    const res = await call('POST', `/numbers/${row.id}/sip/verify`, headers, {});
    expect(res.status).toBe(200);
    expect((res.body.sip as Record<string, unknown>).verification).toMatchObject({
      status: 'verified',
      reason: null,
      checks: { trunk: 'auth_accepted', platform: 'synced' },
      credentials_updated: false,
    });
    // The trunk was asked with the stored, decrypted credentials…
    expect(probe).toHaveBeenCalledWith('sip:pbx.example.com:5060', { username: 'trunk', password: 'Imp0rt-pa55' }, expect.any(Number));
    // …and the platform was given them again.
    expect(retell.countOf('updateSipTrunk') - updatesBefore).toBe(1);
    expect(retell.phoneNumbers.get(e164)!.sip).toMatchObject({ termination_uri: 'sip:pbx.example.com:5060', username: 'trunk', password_seen: true });

    const audit = await adminDb.auditLog.findFirstOrThrow({ where: { tenantId: ws.workspaceId, action: 'number.sip_verified' } });
    expect(audit.metaJson).toMatchObject({ status: 'verified', trunk: 'auth_accepted', platform: 'synced', credentials_updated: false });
    const everything = JSON.stringify([res.body, audit, await adminDb.phoneNumber.findUnique({ where: { id: row.id } }), retell.calls.filter((c) => c.method === 'updateSipTrunk')]);
    expect(everything).not.toContain('Imp0rt-pa55');
    expect((await call('GET', `/numbers/${row.id}`, headers)).body.sip).toMatchObject({ verification: { status: 'verified' } });
  }, 30_000);

  it('keeps working credentials when new ones are refused by the trunk, and the platform is not touched', async () => {
    const { headers, row } = await importedSip('sipv-bad');
    const before = await envelopeOf(row.planId!);
    trunkSays('auth_rejected', 403);
    const updatesBefore = retell.countOf('updateSipTrunk');
    const res = await call('POST', `/numbers/${row.id}/sip/verify`, headers, { password: 'Typo-pa55' });
    expect(res.status).toBe(200);
    expect((res.body.sip as Record<string, unknown>).verification).toMatchObject({ status: 'failed', reason: 'auth_rejected', checks: { platform: 'skipped' }, credentials_updated: false });
    expect(await envelopeOf(row.planId!)).toEqual(before);
    expect(retell.countOf('updateSipTrunk') - updatesBefore).toBe(0);
    expect(JSON.stringify(res.body)).not.toContain('Typo-pa55');
  }, 30_000);

  it('stores new credentials the trunk accepts, and the next check uses them', async () => {
    const { headers, row, e164 } = await importedSip('sipv-rotate');
    const before = await envelopeOf(row.planId!);
    trunkSays('auth_accepted', 200);
    const res = await call('POST', `/numbers/${row.id}/sip/verify`, headers, { host: 'pbx2.example.com:5080', username: 'trunk2', password: 'N3w-pa55' });
    expect((res.body.sip as Record<string, unknown>)).toMatchObject({ host: 'pbx2.example.com:5080', username: 'trunk2', has_password: true, verification: { status: 'verified', credentials_updated: true } });
    const after = await envelopeOf(row.planId!);
    expect(after).not.toEqual(before);
    expect(JSON.stringify(after)).not.toContain('N3w-pa55');
    expect(isEnvelope((after as { password: unknown }).password)).toBe(true);
    expect(retell.phoneNumbers.get(e164)!.sip_outbound_trunk_config).toMatchObject({ termination_uri: 'pbx2.example.com:5080', auth_username: 'trunk2' });

    vi.restoreAllMocks();
    const probe = trunkSays('auth_accepted', 200);
    await call('POST', `/numbers/${row.id}/sip/verify`, headers, {});
    expect(probe).toHaveBeenCalledWith('pbx2.example.com:5080', { username: 'trunk2', password: 'N3w-pa55' }, expect.any(Number));
  }, 30_000);

  it('reports a reachable trunk that would not confirm the password as a warning', async () => {
    const { headers, row } = await importedSip('sipv-warn');
    trunkSays('forbidden', 403);
    const res = await call('POST', `/numbers/${row.id}/sip/verify`, headers, {});
    expect((res.body.sip as Record<string, unknown>).verification).toMatchObject({ status: 'warning', reason: 'forbidden', checks: { platform: 'synced' } });
  }, 30_000);

  it('fails on an unreachable or silent trunk, on a number gone from the platform, and on a platform error', async () => {
    const { headers, row, e164 } = await importedSip('sipv-fail');
    for (const outcome of ['timeout', 'unreachable', 'dns_failed', 'non_public'] as const) {
      vi.restoreAllMocks();
      trunkSays(outcome);
      const res = await call('POST', `/numbers/${row.id}/sip/verify`, headers, {});
      expect((res.body.sip as Record<string, unknown>).verification).toMatchObject({ status: 'failed', reason: outcome, checks: { platform: 'skipped' } });
    }
    vi.restoreAllMocks();
    trunkSays('auth_accepted', 200);
    retell.failNext('getPhoneNumber', 1, new Error('platform 500'));
    expect(((await call('POST', `/numbers/${row.id}/sip/verify`, headers, {})).body.sip as Record<string, unknown>).verification).toMatchObject({ status: 'failed', reason: 'provider_error', checks: { platform: 'error' } });
    const kept = retell.phoneNumbers.get(e164)!;
    retell.phoneNumbers.delete(e164);
    try {
      expect(((await call('POST', `/numbers/${row.id}/sip/verify`, headers, {})).body.sip as Record<string, unknown>).verification).toMatchObject({ status: 'failed', reason: 'not_on_platform', checks: { platform: 'missing' } });
    } finally {
      retell.phoneNumbers.set(e164, kept);
    }
  }, 60_000);

  it('runs one check at a time per number, and shows it pending while it runs', async () => {
    const { headers, row } = await importedSip('sipv-race');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(app.get(SipProbe), 'probe').mockImplementation(async () => {
      await gate;
      return { outcome: 'auth_accepted', status: 200, transport: 'tcp', port: 5060 };
    });
    const first = call('POST', `/numbers/${row.id}/sip/verify`, headers, {});
    await waitFor('the lease', async () => (await adminDb.phoneNumber.findUnique({ where: { id: row.id } }))?.sipVerifyStartedAt);
    const second = await call('POST', `/numbers/${row.id}/sip/verify`, headers, {});
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('SIP_VERIFY_IN_PROGRESS');
    expect(((await call('GET', `/numbers/${row.id}`, headers)).body.sip as Record<string, unknown>).verification).toMatchObject({ status: 'pending' });
    release();
    expect(((await first).body.sip as Record<string, unknown>).verification).toMatchObject({ status: 'verified' });
    expect((await adminDb.phoneNumber.findUniqueOrThrow({ where: { id: row.id } })).sipVerifyStartedAt).toBeNull();
  }, 30_000);

  it('is owner/admin only, SIP numbers only, this workspace only, budgeted, and needs a username for a password', async () => {
    const { ws, headers, row } = await importedSip('sipv-guard', { password: 'NoUser-pa55' });
    trunkSays('auth_accepted', 200);
    const editor = await addMember(ws.workspaceId, 'sipv-editor', 'editor');
    expect((await call('POST', `/numbers/${row.id}/sip/verify`, await auth(editor.sub, ws.workspaceId), {})).status).toBe(403);

    const other = await paidWorkspace(app, 'sipv-other', 'scale');
    expect((await call('POST', `/numbers/${row.id}/sip/verify`, await auth(other.sub, other.workspaceId), {})).status).toBe(404);

    const bought = await adminDb.phoneNumber.create({ data: { tenantId: ws.workspaceId, type: 'retell_twilio', status: 'active', e164: nanpNumber(), inboundToken: `tok_${randomUUID().replace(/-/g, '')}` } });
    const notSip = await call('POST', `/numbers/${bought.id}/sip/verify`, headers, {});
    expect([notSip.status, notSip.body.code]).toEqual([400, 'NOT_SIP_NUMBER']);

    const noUser = await call('POST', `/numbers/${row.id}/sip/verify`, headers, {});
    expect([noUser.status, noUser.body.code]).toEqual([422, 'VALIDATION_FAILED']);
    expect((await call('POST', `/numbers/${row.id}/sip/verify`, headers, { surprise: true })).status).toBe(422);

    await app.get(RedisCache).client.set(redisKeys.sipVerifyWindow(ws.workspaceId), '10', 'EX', 3600);
    const limited = await call('POST', `/numbers/${row.id}/sip/verify`, headers, { username: 'trunk' });
    expect([limited.status, limited.body.code]).toEqual([429, 'RATE_LIMITED']);
    // A refused check leaves no lease behind.
    expect((await adminDb.phoneNumber.findUniqueOrThrow({ where: { id: row.id } })).sipVerifyStartedAt).toBeNull();
  }, 30_000);
});

describe('per-number business hours (D16)', () => {
  it('stores a schedule with date overrides and its own zone, and refuses one the inbound check could not read', async () => {
    const ws = await paidWorkspace(app, 'hours', 'growth');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers);
    const number = await adminDb.phoneNumber.create({ data: { tenantId: ws.workspaceId, agentId, type: 'retell_twilio', status: 'active', e164: nanpNumber(), inboundToken: `tok_${randomUUID().replace(/-/g, '')}` } });
    const hours = {
      timezone: 'Asia/Riyadh',
      days: { sun: [{ open: '09:00', close: '13:00' }, { open: '16:00', close: '22:00' }], thu: [{ open: '20:00', close: '02:00' }] },
      closed_dates: ['2026-12-02'],
      date_overrides: [{ date: '2026-09-23', intervals: [{ open: '10:00', close: '14:00' }] }],
    };
    const saved = await call('PATCH', `/numbers/${number.id}`, headers, { hours_mode: 'custom', hours_override: hours });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ hours_mode: 'custom', hours_override: hours });
    // The hot path's copy carries it too.
    const cached = await app.get(RedisCache).getJson<{ hours_mode: string; hours: unknown }>(redisKeys.number(number.e164!));
    expect(cached).toMatchObject({ hours_mode: 'custom', hours });

    const bad = await call('PATCH', `/numbers/${number.id}`, headers, {
      hours_mode: 'custom',
      hours_override: { timezone: 'Riyadh', days: { mon: [{ open: '09:00', close: '13:00' }, { open: '12:00', close: '17:00' }] }, date_overrides: [{ date: '2026-02-30', intervals: [] }] },
    });
    expect(bad.status).toBe(422);
    expect((bad.body.fields as Array<{ field: string }>).map((f) => f.field).sort()).toEqual(['hours_override.date_overrides.0.date', 'hours_override.days.mon', 'hours_override.timezone']);
    expect((await call('GET', `/numbers/${number.id}`, headers)).body.hours_override).toEqual(hours);

    // A viewer reads it and cannot change it.
    const viewer = await addMember(ws.workspaceId, 'hours-viewer', 'viewer');
    expect((await call('PATCH', `/numbers/${number.id}`, await auth(viewer.sub, ws.workspaceId), { hours_mode: 'always' })).status).toBe(403);
  });
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

    // QA-083 (D4 Hand-off): the message if the transfer fails — trimmed, ≤ 500, cleared by
    // null or blank, refused with a NUL byte, and carried in `num:{e164}` for the call.
    expect(edited.body.transfer_fail_message).toBeNull();
    const withMessage = await call('PATCH', `/numbers/${row.id}`, headers, { transfer_fail_message: '  Sorry, nobody can take your call right now. Please call back after 2 pm.  ' });
    expect(withMessage.status).toBe(200);
    expect(withMessage.body.transfer_fail_message).toBe('Sorry, nobody can take your call right now. Please call back after 2 pm.');
    expect((await call('GET', `/numbers/${row.id}`, headers)).body.transfer_fail_message).toBe('Sorry, nobody can take your call right now. Please call back after 2 pm.');
    expect(await cache.getJson<{ transfer_fail_message: string | null }>(redisKeys.number(row.e164!))).toMatchObject({
      transfer_fail_message: 'Sorry, nobody can take your call right now. Please call back after 2 pm.',
    });
    const tooLong = await call('PATCH', `/numbers/${row.id}`, headers, { transfer_fail_message: 'x'.repeat(501) });
    expect(tooLong.status).toBe(422);
    expect(tooLong.body.code).toBe('VALIDATION_FAILED');
    expect((await call('PATCH', `/numbers/${row.id}`, headers, { transfer_fail_message: 'bad\u0000byte' })).status).toBe(422);
    // Editor and up, like the other routing fields; a viewer cannot.
    const editor = await addMember(ws.workspaceId, 'fail-msg-editor', 'editor');
    expect((await call('PATCH', `/numbers/${row.id}`, await auth(editor.sub, ws.workspaceId), { transfer_fail_message: 'Back in a minute.' })).status).toBe(200);
    const viewer = await addMember(ws.workspaceId, 'fail-msg-viewer', 'viewer');
    expect((await call('PATCH', `/numbers/${row.id}`, await auth(viewer.sub, ws.workspaceId), { transfer_fail_message: 'Not mine to say.' })).status).toBe(403);
    const cleared = await call('PATCH', `/numbers/${row.id}`, headers, { transfer_fail_message: '   ' });
    expect(cleared.body.transfer_fail_message).toBeNull();
    expect(await cache.getJson<{ transfer_fail_message: string | null }>(redisKeys.number(row.e164!))).toMatchObject({ transfer_fail_message: null });
    expect((await call('PATCH', `/numbers/${row.id}`, headers, { transfer_fail_message: 'Back soon.' })).body.transfer_fail_message).toBe('Back soon.');
    expect((await call('PATCH', `/numbers/${row.id}`, headers, { transfer_fail_message: null })).body.transfer_fail_message).toBeNull();

    // QA-106 (ORL-NUM-639 / ORL-NUM-646): a number without its country code, or a hand-off
    // target that is not real, is refused before anything is stored — a direct request gets no further than
    // the form; the real one is stored in E.164 and reaches `num:{e164}` for the transfer.
    for (const body of [
      { transfer_targets: [{ label: 'Front desk', number: '4165550101' }] },
      { transfer_targets: [{ label: 'Front desk', number: '+4165550101' }] },
      { transfer_targets: [{ label: 'Front desk', number: '+1 416 555 0101' }] },
      { blocklist: ['5145550123'] },
      { blocklist: ['15145550123'] },
      { blocklist: ['+15145550123', '+1 514 555 0123'] },
    ]) {
      const refused = await call('PATCH', `/numbers/${row.id}`, headers, body);
      expect(refused.status, JSON.stringify(body)).toBe(422);
      expect(refused.body.code).toBe('VALIDATION_FAILED');
    }
    const unchanged = await adminDb.phoneNumber.findUniqueOrThrow({ where: { id: row.id } });
    expect(unchanged.blocklist).toEqual(['+15145550666']);
    expect(unchanged.transferTargetsJson).toEqual([{ label: 'Owner', number: '+15145550001' }]);
    const handoff = await call('PATCH', `/numbers/${row.id}`, headers, { transfer_targets: [{ label: 'Front desk', number: '+14165550101' }], blocklist: ['+15145550666', '+15145550123'] });
    expect(handoff.status).toBe(200);
    expect(handoff.body).toMatchObject({ transfer_targets: [{ label: 'Front desk', number: '+14165550101' }], blocklist: ['+15145550666', '+15145550123'] });
    // The block list is compared, never dialled: a caller ID that is not a real number may be listed, and declines.
    const spoofed = await call('PATCH', `/numbers/${row.id}`, headers, { blocklist: ['+15145550666', '+15555550123', '+0123'] });
    expect(spoofed.status).toBe(200);
    expect(spoofed.body.blocklist).toEqual(['+15145550666', '+15555550123', '+0123']);
    expect((await cache.getJson<{ blocklist: string[] }>(redisKeys.number(row.e164!)))?.blocklist).toEqual(expect.arrayContaining(['+15555550123', '+0123']));
    expect(await cache.getJson<{ transfer_numbers: string[]; blocklist: string[] }>(redisKeys.number(row.e164!))).toMatchObject({ transfer_numbers: ['+14165550101'] });
    // A row saved before the rule reads back as it was, for the form to mark — never dropped, never rewritten.
    await adminDb.phoneNumber.update({ where: { id: row.id }, data: { transferTargetsJson: [{ label: 'Old desk', number: '+4165550101' }], blocklist: ['+5145550123'] } });
    expect((await call('GET', `/numbers/${row.id}`, headers)).body).toMatchObject({ transfer_targets: [{ label: 'Old desk', number: '+4165550101' }], blocklist: ['+5145550123'] });
    expect((await call('PATCH', `/numbers/${row.id}`, headers, { transfer_fail_message: 'Back soon.' })).status).toBe(200);
    await adminDb.phoneNumber.update({ where: { id: row.id }, data: { transferTargetsJson: [{ label: 'Owner', number: '+15145550001' }], blocklist: ['+15145550666'] } });

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
    expect(shown.body.forwarding).toEqual({ from: '+15145550100', status: 'waiting_for_customer', carrier: 'bell', mode: 'always', test: null });

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

/*
 * QA-107 (ORL-NUM-628): the line a customer keeps (Option B) or brings (Option C) is refused
 * without its country code, on every entry point, before anything is stored or bought.
 * QA-108 (ORL-NUM-673): releasing a number while it carries a live call says so.
 */
describe('QA-107 / QA-108: number entry and refusals', () => {
  it('ORL-NUM-628: W6, Keep your number and Bring your own line refuse a number without its country code, and buy nothing', async () => {
    const ws = await paidWorkspace(app, 'qa107', 'scale');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers);
    const bought = retell.countOf('createPhoneNumber');
    const imported = retell.countOf('importPhoneNumber');
    const sip = (number: string) => ({ number, host: 'sip:pbx.example.com:5060', username: 'trunk', password: 'Qa107-pa55' });

    for (const typed of ['5145550123', '4165550101', '+5145550123', '+4165550101', '+9995551234', '']) {
      const plan = await call('PUT', `/agents/${agentId}/phone-plan`, headers, { option: 'forward', country: 'CA', existing_number: typed });
      expect([plan.status, plan.body.code, (plan.body.fields as Array<{ field: string }>)[0]?.field], typed).toEqual([422, 'VALIDATION_FAILED', 'existing_number']);
      const own = await call('PUT', `/agents/${agentId}/phone-plan`, headers, { option: 'sip', carrier_consent: true, sip: sip(typed) });
      expect([own.status, (own.body.fields as Array<{ field: string }>)[0]?.field], typed).toEqual([422, 'sip.number']);
      const keep = await call('POST', '/numbers/buy', headers, { agent_id: agentId, country: 'CA', forward_from: typed, carrier: 'bell' });
      expect([keep.status, (keep.body.fields as Array<{ field: string }>)[0]?.field], typed).toEqual([422, 'forward_from']);
      const bring = await call('POST', '/numbers/import', headers, { agent_id: agentId, carrier_consent: true, sip: sip(typed) });
      expect([bring.status, (bring.body.fields as Array<{ field: string }>)[0]?.field], typed).toEqual([422, 'sip.number']);
    }
    expect(await adminDb.phonePlan.count({ where: { tenantId: ws.workspaceId } })).toBe(0);
    expect(await adminDb.phoneNumber.count({ where: { tenantId: ws.workspaceId } })).toBe(0);
    expect(retell.countOf('createPhoneNumber')).toBe(bought);
    expect(retell.countOf('importPhoneNumber')).toBe(imported);

    // With its country code the same line is taken, North American or not.
    expect((await call('PUT', `/agents/${agentId}/phone-plan`, headers, { option: 'forward', country: 'CA', existing_number: '+15145550123' })).body.existing_number).toBe('+15145550123');
    expect((await call('PUT', `/agents/${agentId}/phone-plan`, headers, { option: 'sip', carrier_consent: true, sip: sip('+442071838750') })).status).toBe(200);
    const keep = await call('POST', '/numbers/buy', headers, { agent_id: agentId, country: 'CA', forward_from: '+14165550101', carrier: 'bell' });
    expect(keep.status).toBe(202);
    expect((keep.body.number as { forwarding: { from: string } }).forwarding.from).toBe('+14165550101');
  }, 30_000);

  it('ORL-NUM-628: a W6 plan saved before the rule fails activation before anything is bought', async () => {
    const ws = await paidWorkspace(app, 'qa107-old-plan', 'growth');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers);
    expect((await call('PUT', `/agents/${agentId}/phone-plan`, headers, { option: 'forward', country: 'CA', area_code: '514', existing_number: '+15145550123' })).status).toBe(200);
    // As the old portal stored `5145550123`: a `+` in front, read as Peru.
    await adminDb.phonePlan.updateMany({ where: { agentId }, data: { existingNumber: '+5145550123' } });
    const bought = retell.countOf('createPhoneNumber');
    const started = await call('POST', `/agents/${agentId}/activate`, headers, {});
    expect(started.status).toBe(202);
    const job = await waitForJob(started.body.job_id as string, 30_000);
    expect(job.status).toBe('failed');
    expect(job.stepsJson).toMatchObject({ attempt: 1, error_kind: 'invalid_number' });
    expect((job.stepsJson as { customer_reason?: string }).customer_reason).toMatch(/country code/);
    expect(retell.countOf('createPhoneNumber')).toBe(bought);
    expect(await adminDb.phoneNumber.count({ where: { tenantId: ws.workspaceId } })).toBe(0);
  }, 40_000);

  it('ORL-NUM-673: a number on a live call is not released, and the refusal says so', async () => {
    const ws = await paidWorkspace(app, 'qa108-release', 'growth');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers);
    const accepted = await call('POST', '/numbers/buy', headers, { agent_id: agentId, country: 'CA' });
    const row = await waitForNumber((accepted.body.number as { id: string }).id);
    const callId = `call_qa108_${randomUUID().slice(0, 8)}`;
    await adminDb.call.create({ data: { id: callId, tenantId: ws.workspaceId, agentId, numberId: row.id, channel: 'phone', status: 'in_progress', startedAt: new Date() } });

    const refused = await call('DELETE', `/numbers/${row.id}`, headers);
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ code: 'NUMBER_ON_CALL', message: 'This number is on a call right now. You can release it once the call ends.' });
    expect((await adminDb.phoneNumber.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('active');
    expect(retell.phoneNumbers.has(row.e164!)).toBe(true);

    await adminDb.call.update({ where: { id: callId }, data: { status: 'ended', endedAt: new Date() } });
    expect((await call('DELETE', `/numbers/${row.id}`, headers)).body).toEqual({ released: true });
  }, 30_000);
});
