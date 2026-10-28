import { adminDb, withWorkspace } from '@portal/db';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { localClock } from '@portal/schemas';
import { randomUUID } from 'node:crypto';
import Retell from 'retell-sdk';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PlatformConfigService } from '../src/modules/config';
import { OutboundCallService, UNCONFIRMED_ATTEMPT_MS, callingWindowVerdict, insideCallingWindow } from '../src/modules/outbound';
import { REDIS, type RedisLike, redisKeys } from '../src/modules/redis';
import { RuntimeCacheService } from '../src/modules/runtime-cache';
import { WalletService } from '../src/modules/wallet';
import { type D5Harness, type FakeRetellGateway, addMember, startD5Harness, waitFor } from './d5-fixtures';
import { authFor, caller, paidWorkspace, publishedAgent } from './d6-fixtures';

/*
 * D18 end to end: click-to-call from the D2 call detail, behind the compliance gates
 * (ADR 0031). Every refusal is checked for the same four things — the code, no platform
 * request, an audit row with the reason, and no call or ledger row — and the placed call
 * is followed through the lifecycle webhooks to one ledger row.
 *
 * The exit check is the first describe: outbound is blocked for a workspace without
 * business verification and a verified caller ID.
 *
 * The calling window depends on the clock, so the service's clock is pinned to an instant
 * the Canadian window is open (or closed, where that is the point) — computed from now,
 * so the prior-contact window and the local day stay real.
 *
 * Needs Postgres, Redis and the seed (pnpm infra:up && pnpm db:deploy && pnpm db:seed).
 */

let h: D5Harness;
let app: NestFastifyApplication;
let retell: FakeRetellGateway;
let auth: ReturnType<typeof authFor>;
let call: ReturnType<typeof caller>;
let redis: RedisLike;
let config: PlatformConfigService;
let staffOps: string;
let staffSupport: string;
let openAt: Date;
let closedAt: Date;

const KYC = {
  legal_name: 'Maple Dental Clinic Inc.',
  registration_number: 'BN 123456789',
  registration_country: 'CA',
  address: '1 King St W, Toronto ON',
  contact_name: 'Dana Smith',
  dnc_registration: null,
};

beforeAll(async () => {
  h = await startD5Harness();
  app = h.app;
  retell = h.retell;
  auth = authFor(h.customerTenant);
  call = caller(app);
  redis = app.get<RedisLike>(REDIS);
  config = app.get(PlatformConfigService);

  const run = randomUUID().slice(0, 8);
  const staff = async (label: string, role: 'ops' | 'support') => {
    const row = await adminDb.staffUser.create({ data: { authProviderId: `google-oauth2|${label}-${run}`, email: `${label}-${run}@metacognixion.test`, role } });
    return h.staffTenant.mint(row.authProviderId, { mfa: true });
  };
  staffOps = await staff('d18-ops', 'ops');
  staffSupport = await staff('d18-sup', 'support');

  // An instant the Canadian window is open, and one it is shut, both from now on.
  const rule = (await config.outboundPolicy()).policy.countries.CA!;
  const now = new Date();
  const v = callingWindowVerdict(rule, now);
  openAt = v.open ? now : v.nextAt!;
  let t = openAt.getTime();
  while (insideCallingWindow(rule, new Date(t))) t += 15 * 60_000;
  closedAt = new Date(t);
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await h?.stop();
  await adminDb.$disconnect();
});

/** Pins the instant every gate is judged at. */
function clockAt(at: Date) {
  vi.spyOn(app.get(OutboundCallService) as unknown as { now: () => Date }, 'now').mockReturnValue(at);
}

/**
 * A Canadian caller for this suite only. Its own prefix (647-555, used by no other suite) and
 * never twice in a run: a random 416-555 number collided with a forwarded line other suites
 * leave on the platform and read as DESTINATION_IS_AGENT.
 */
const usedNumbers = new Set<string>();
function caNumber(): string {
  for (;;) {
    const n = `+1647555${String(Math.floor(Math.random() * 9_000) + 1_000)}`;
    if (!usedNumbers.has(n)) {
      usedNumbers.add(n);
      return n;
    }
  }
}
const lastArgs = <T>(method: string) => retell.calls.filter((c) => c.method === method).at(-1)!.args[0] as T;

async function setFlag(workspaceId: string, on: boolean) {
  await adminDb.tenantOverride.upsert({ where: { tenantId: workspaceId }, create: { tenantId: workspaceId, flagsJson: { outbound_calls: on } }, update: { flagsJson: { outbound_calls: on } } });
  await config.invalidateWorkspace(workspaceId);
}

/** A live number on the agent, as activation leaves one; `verified: false` = a SIP import staff have not confirmed. */
async function liveNumber(workspaceId: string, agentId: string, options: { verified?: boolean; type?: 'retell_twilio' | 'custom_sip' } = {}) {
  const e164 = `+1450${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
  const verified = options.verified ?? true;
  const number = await adminDb.phoneNumber.create({
    data: {
      tenantId: workspaceId,
      agentId,
      e164,
      type: options.type ?? (verified ? 'retell_twilio' : 'custom_sip'),
      status: 'active',
      inboundToken: `tok_${randomUUID().replace(/-/g, '')}`,
      country: 'CA',
      ...(verified ? { callerIdVerifiedAt: new Date(), callerIdVerifiedVia: 'purchase' } : {}),
    },
  });
  await adminDb.agent.update({ where: { id: agentId }, data: { status: 'live' } });
  await app.get(RuntimeCacheService).refresh(workspaceId);
  return { id: number.id, e164 };
}

/** A D2 call: by default a real inbound call from `from` that the agent answered just now. */
async function d2Call(
  workspaceId: string,
  agentId: string,
  number: { id: string; e164: string },
  options: { from?: string | null; to?: string; direction?: 'inbound' | 'outbound'; channel?: 'phone' | 'web'; isTest?: boolean; createdAt?: Date } = {},
) {
  const id = `call_d2_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const direction = options.direction ?? 'inbound';
  await adminDb.call.create({
    data: {
      id,
      tenantId: workspaceId,
      agentId,
      numberId: options.channel === 'web' ? null : number.id,
      channel: options.channel ?? 'phone',
      direction,
      isTest: options.isTest ?? false,
      fromNumber: direction === 'inbound' ? (options.from === undefined ? caNumber() : options.from) : number.e164,
      toNumber: direction === 'inbound' ? number.e164 : (options.to ?? caNumber()),
      startedAt: options.createdAt ?? new Date(),
      endedAt: options.createdAt ?? new Date(),
      durationS: 42,
      status: 'analyzed',
      creditsCharged: 0.7,
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    },
  });
  return (await adminDb.call.findUniqueOrThrow({ where: { id } })) as { id: string; fromNumber: string | null; toNumber: string | null };
}

/** A workspace every gate allows by default: paid, verified, flag on, a verified number, a recent caller. */
async function setup(label: string, options: { kyc?: 'none' | 'pending' | 'verified' | 'rejected'; verified?: boolean; flag?: boolean } = {}) {
  const ws = await paidWorkspace(app, label, 'starter');
  const headers = await auth(ws.sub, ws.workspaceId);
  const agentId = await publishedAgent(call, headers);
  const number = await liveNumber(ws.workspaceId, agentId, { verified: options.verified ?? true });
  const kyc = options.kyc ?? 'verified';
  await adminDb.tenant.update({
    where: { id: ws.workspaceId },
    data: { kycStatus: kyc, kycJson: kyc === 'none' ? undefined : KYC, kycSubmittedAt: kyc === 'none' ? null : new Date(), kycReason: kyc === 'rejected' ? 'We could not match the registration number.' : null },
  });
  await setFlag(ws.workspaceId, options.flag ?? true);
  const source = await d2Call(ws.workspaceId, agentId, number);
  return { ws, headers, agentId, number, source };
}

const press = (id: string, headers: Record<string, string>, body: Record<string, unknown> = {}) =>
  call('POST', `/calls/${id}/callback`, headers, { idempotency_key: randomUUID(), ...body });

/** Every refusal: the code, nothing placed, nothing written but the audit row naming the reason. */
async function expectRefused(workspaceId: string, sourceId: string, res: { status: number; body: Record<string, unknown> }, code: string, status: number, placedBefore: number) {
  expect(res.body.code, JSON.stringify(res.body)).toBe(code);
  expect(res.status).toBe(status);
  expect(retell.countOf('createPhoneCall')).toBe(placedBefore);
  const audit = await adminDb.auditLog.findFirst({ where: { tenantId: workspaceId, action: 'call.outbound_blocked', targetId: sourceId }, orderBy: { createdAt: 'desc' } });
  expect(audit?.metaJson).toMatchObject({ reason: code });
  expect((audit?.metaJson as { request_id?: unknown }).request_id).toEqual(expect.any(String));
  expect(await adminDb.outboundCall.count({ where: { tenantId: workspaceId, status: { in: ['pending', 'placed'] } } })).toBe(0);
  expect(await adminDb.call.count({ where: { tenantId: workspaceId, direction: 'outbound', id: { not: sourceId } } })).toBe(0);
  expect(await adminDb.creditLedger.count({ where: { tenantId: workspaceId, reason: 'call' } })).toBe(0);
}

describe('D18 exit check — outbound is blocked without business verification and a verified caller ID', () => {
  it('refuses a workspace with neither, then one verified without a verified number, and places nothing', async () => {
    clockAt(openAt);
    const { ws, headers, source } = await setup('d18-exit', { kyc: 'none', verified: false });
    const before = retell.countOf('createPhoneCall');

    await expectRefused(ws.workspaceId, source.id, await press(source.id, headers), 'KYC_REQUIRED', 403, before);
    const check = await call('GET', `/calls/${source.id}/callback`, headers);
    expect(check.body).toMatchObject({ allowed: false, reason: 'KYC_REQUIRED' });

    await adminDb.tenant.update({ where: { id: ws.workspaceId }, data: { kycStatus: 'verified', kycJson: KYC } });
    await expectRefused(ws.workspaceId, source.id, await press(source.id, headers), 'CALLER_ID_REQUIRED', 409, before);
  });
});

describe('business verification (KYC)', () => {
  it('is submitted by the customer, decided by staff only, and each state refuses until verified', async () => {
    clockAt(openAt);
    const { ws, headers, source } = await setup('d18-kyc', { kyc: 'none' });
    const before = retell.countOf('createPhoneCall');

    const submitted = await call('POST', '/outbound/kyc', headers, KYC);
    expect(submitted.status).toBe(200);
    expect((submitted.body.kyc as { status: string }).status).toBe('pending');
    expect((await call('POST', '/outbound/kyc', headers, KYC)).status).toBe(409);
    await expectRefused(ws.workspaceId, source.id, await press(source.id, headers), 'KYC_PENDING', 403, before);

    // The customer's own connection cannot set a verdict, whatever the code path.
    await expect(withWorkspace(ws.workspaceId, (db) => db.tenant.update({ where: { id: ws.workspaceId }, data: { kycStatus: 'verified' } }))).rejects.toThrow();

    // Support may not decide; ops may, with a reason, and it is audited.
    const path = `/admin/customers/${ws.workspaceId}/kyc`;
    const staffHeaders = (token: string) => ({ authorization: `Bearer ${token}` });
    expect((await call('POST', path, staffHeaders(staffSupport), { reason_code: 'customer_request', decision: 'verified' })).status).toBe(403);
    expect((await call('POST', path, staffHeaders(staffOps), { reason_code: 'customer_request', decision: 'rejected' })).status).toBe(422);
    const rejected = await call('POST', path, staffHeaders(staffOps), { reason_code: 'customer_request', decision: 'rejected', customer_reason: 'The registration number does not match.' });
    expect(rejected.body).toMatchObject({ status: 'rejected', reason: 'The registration number does not match.' });
    await expectRefused(ws.workspaceId, source.id, await press(source.id, headers), 'KYC_REJECTED', 403, before);
    expect(((await call('GET', '/outbound', headers)).body.kyc as { reason: string }).reason).toBe('The registration number does not match.');

    const verified = await call('POST', path, staffHeaders(staffOps), { reason_code: 'customer_request', decision: 'verified' });
    expect(verified.body).toMatchObject({ status: 'verified' });
    expect(await adminDb.staffAuditLog.count({ where: { tenantId: ws.workspaceId, action: { in: ['workspace.kyc_verified', 'workspace.kyc_rejected'] } } })).toBe(2);
    expect((await press(source.id, headers)).status).toBe(201);
  });
});

describe('caller ID', () => {
  it('uses only a verified number of this workspace: another workspace’s or an unconfirmed SIP import is refused until staff verify it', async () => {
    clockAt(openAt);
    const { ws, headers, agentId, source } = await setup('d18-cid');
    const other = await setup('d18-cid-other');
    const sip = await liveNumber(ws.workspaceId, agentId, { verified: false, type: 'custom_sip' });
    const before = retell.countOf('createPhoneCall');

    for (const numberId of [other.number.id, sip.id]) {
      const res = await press(source.id, headers, { number_id: numberId });
      expect(res.body.code).toBe('CALLER_ID_UNVERIFIED');
      expect((res.body.fields as Array<{ field: string }>)[0]!.field).toBe('number_id');
    }
    expect(retell.countOf('createPhoneCall')).toBe(before);

    // The customer's connection cannot verify a caller ID; staff can.
    await expect(withWorkspace(ws.workspaceId, (db) => db.phoneNumber.update({ where: { id: sip.id }, data: { callerIdVerifiedAt: new Date() } }))).rejects.toThrow();
    // Nor create a number that arrives verified.
    await expect(
      withWorkspace(ws.workspaceId, (db) =>
        db.phoneNumber.create({
          data: { tenantId: ws.workspaceId, type: 'custom_sip', status: 'provisioning', inboundToken: `tok_${randomUUID().replace(/-/g, '')}`, callerIdVerifiedAt: new Date(), callerIdVerifiedVia: 'staff' },
        }),
      ),
    ).rejects.toThrow(/may only be set by staff/);
    const verified = await call('POST', `/admin/numbers/${sip.id}/caller-id`, { authorization: `Bearer ${staffOps}` }, { reason_code: 'customer_request', verified: true });
    expect(verified.body).toMatchObject({ caller_id_verified: true, caller_id_verified_via: 'staff' });
    const placed = await press(source.id, headers, { number_id: sip.id });
    expect(placed.status).toBe(201);
    expect(placed.body.from_number).toBe(sip.e164);
  });
});

describe('destination', () => {
  it('refuses a withheld or browser caller, a country without calling rules, and a number answered by an agent', async () => {
    clockAt(openAt);
    const { ws, headers, agentId, number } = await setup('d18-dest');
    const other = await setup('d18-dest-agent');
    const before = retell.countOf('createPhoneCall');
    const cases: Array<[{ id: string }, string]> = [
      [await d2Call(ws.workspaceId, agentId, number, { from: 'anonymous' }), 'DESTINATION_INVALID'],
      [await d2Call(ws.workspaceId, agentId, number, { channel: 'web', from: null }), 'DESTINATION_INVALID'],
      [await d2Call(ws.workspaceId, agentId, number, { from: '+966501234567' }), 'DESTINATION_COUNTRY'],
      [await d2Call(ws.workspaceId, agentId, number, { from: other.number.e164 }), 'DESTINATION_IS_AGENT'],
    ];
    for (const [source, code] of cases) {
      const res = await press(source.id, headers);
      expect(res.body.code, code).toBe(code);
      expect(res.status).toBe(422);
    }
    expect(retell.countOf('createPhoneCall')).toBe(before);
  });
});

describe('do-not-call', () => {
  it('blocks a number on the workspace’s own list (editor adds, only owner/admin removes) and on the platform list', async () => {
    clockAt(openAt);
    const { ws, headers, source, agentId, number } = await setup('d18-dnc');
    const editor = await addMember(ws.workspaceId, 'd18-dnc-editor', 'editor');
    const editorHeaders = await auth(editor.sub, ws.workspaceId);
    const before = retell.countOf('createPhoneCall');

    const added = await call('POST', '/dnc', editorHeaders, { call_id: source.id, reason: 'Asked not to be called' });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ e164: source.fromNumber, source: 'call' });
    expect((await call('POST', '/dnc', editorHeaders, { call_id: source.id })).body.id).toBe(added.body.id);
    await expectRefused(ws.workspaceId, source.id, await press(source.id, headers), 'DNC_LISTED', 409, before);
    const audit = await adminDb.auditLog.findFirstOrThrow({ where: { tenantId: ws.workspaceId, action: 'dnc.added' } });
    expect(JSON.stringify(audit.metaJson)).not.toContain(source.fromNumber!.slice(2, 10));

    expect((await call('DELETE', `/dnc/${added.body.id}`, editorHeaders)).status).toBe(403);
    expect((await call('DELETE', `/dnc/${added.body.id}`, headers)).status).toBe(200);
    expect((await call('GET', `/calls/${source.id}/callback`, headers)).body).toMatchObject({ allowed: true });

    // Stored as staff typed it, not as E.164: matched the way the inbound path matches it.
    const listed = await d2Call(ws.workspaceId, agentId, number);
    const n = listed.fromNumber!;
    const typed = `+1 ${n.slice(2, 5)}-${n.slice(5, 8)}-${n.slice(8)}`;
    await adminDb.blocklist.create({ data: { type: 'phone', value: typed, reason: 'national registry' } });
    try {
      const res = await press(listed.id, headers);
      expect(res.body.code).toBe('DNC_LISTED');
    } finally {
      await adminDb.blocklist.delete({ where: { type_value: { type: 'phone', value: typed } } });
    }
  });
});

describe('prior contact and the calling window', () => {
  it('calls back only someone who called in within the window — not a number we rang, nor a caller from months ago', async () => {
    clockAt(openAt);
    const { ws, headers, agentId, number } = await setup('d18-prior');
    const before = retell.countOf('createPhoneCall');
    const ours = await d2Call(ws.workspaceId, agentId, number, { direction: 'outbound', isTest: true });
    await expectRefused(ws.workspaceId, ours.id, await press(ours.id, headers), 'NO_PRIOR_CONTACT', 409, before);
    const old = await d2Call(ws.workspaceId, agentId, number, { createdAt: new Date(Date.now() - 100 * 86_400_000) });
    expect((await press(old.id, headers)).body.code).toBe('NO_PRIOR_CONTACT');
  });

  it('refuses outside the destination’s hours in every zone of its country and names the next allowed minute', async () => {
    clockAt(closedAt);
    const { ws, headers, source } = await setup('d18-window');
    const rule = (await config.outboundPolicy()).policy.countries.CA!;
    const check = await call('GET', `/calls/${source.id}/callback`, headers);
    expect(check.body).toMatchObject({ allowed: false, reason: 'OUTSIDE_CALLING_WINDOW', next_allowed_at: callingWindowVerdict(rule, closedAt).nextAt!.toISOString() });
    await expectRefused(ws.workspaceId, source.id, await press(source.id, headers), 'OUTSIDE_CALLING_WINDOW', 409, retell.countOf('createPhoneCall'));
  });
});

describe('workspace state and configuration', () => {
  it('refuses with the flag off, a paused workspace, unusable settings, an agent that is not live, no paid pack and no credits', async () => {
    clockAt(openAt);
    const { ws, headers, source, agentId } = await setup('d18-config');
    const before = retell.countOf('createPhoneCall');

    await setFlag(ws.workspaceId, false);
    await expectRefused(ws.workspaceId, source.id, await press(source.id, headers), 'OUTBOUND_DISABLED', 403, before);
    await setFlag(ws.workspaceId, true);

    await adminDb.tenant.update({ where: { id: ws.workspaceId }, data: { pausedAt: new Date() } });
    expect((await press(source.id, headers)).body.code).toBe('WORKSPACE_PAUSED');
    await adminDb.tenant.update({ where: { id: ws.workspaceId }, data: { pausedAt: null } });

    await adminDb.tenant.update({ where: { id: ws.workspaceId }, data: { outboundSettingsJson: { voicemail_detection: 'leave_message' } } });
    expect((await press(source.id, headers)).body.code).toBe('OUTBOUND_NOT_CONFIGURED');
    await adminDb.tenant.update({ where: { id: ws.workspaceId }, data: { outboundSettingsJson: { voicemail_detection: 'hang_up', voicemail_message: null } } });

    await adminDb.agent.update({ where: { id: agentId }, data: { status: 'paused' } });
    expect((await press(source.id, headers)).body.code).toBe('AGENT_NOT_PUBLISHED');
    await adminDb.agent.update({ where: { id: agentId }, data: { status: 'live' } });

    await adminDb.purchase.updateMany({ where: { tenantId: ws.workspaceId }, data: { status: 'abandoned' } });
    expect((await press(source.id, headers)).body.code).toBe('PURCHASE_REQUIRED');
    await adminDb.purchase.updateMany({ where: { tenantId: ws.workspaceId }, data: { status: 'paid' } });

    const wallet = app.get(WalletService);
    await wallet.withWallet(ws.workspaceId, (_tx, w) => w.debit({ credits: 150, reason: 'adjustment', refType: 'test' }));
    const broke = await press(source.id, headers);
    expect(broke.status).toBe(402);
    expect(broke.body.code).toBe('NO_CREDITS');
    expect(retell.countOf('createPhoneCall')).toBe(before);
  });

  it('is editor and up to place, any member to check, and another workspace’s call is not found', async () => {
    clockAt(openAt);
    const { ws, source } = await setup('d18-roles');
    const viewer = await addMember(ws.workspaceId, 'd18-viewer', 'viewer');
    const viewerHeaders = await auth(viewer.sub, ws.workspaceId);
    expect((await call('GET', `/calls/${source.id}/callback`, viewerHeaders)).status).toBe(200);
    expect((await press(source.id, viewerHeaders)).status).toBe(403);

    const other = await setup('d18-roles-other');
    expect((await call('GET', `/calls/${source.id}/callback`, other.headers)).status).toBe(404);
    expect((await press(source.id, other.headers)).status).toBe(404);
    expect((await call('POST', '/dnc', other.headers, { call_id: source.id })).status).toBe(404);
  });
});

describe('placing the call', () => {
  it('rings the caller from a verified number with the agent’s published version and the voicemail setting, and D2 shows it as outbound', async () => {
    clockAt(openAt);
    const { ws, headers, agentId, number, source } = await setup('d18-ok');
    const agent = await adminDb.agent.findUniqueOrThrow({ where: { id: agentId } });
    const version = await adminDb.agentVersion.findUniqueOrThrow({ where: { agentId_versionNo: { agentId, versionNo: agent.publishedVersion! } } });

    // The number's D4 hand-off, which the callback carries as an inbound call to it would.
    await adminDb.phoneNumber.update({
      where: { id: number.id },
      data: { transferTargetsJson: [{ label: 'Manager', number: '+14165550142' }], transferFailMessage: 'Sorry, try 416-555-0142 later.' },
    });

    const check = await call('GET', `/calls/${source.id}/callback`, headers);
    expect(check.body).toMatchObject({ allowed: true, reason: null, to_number: source.fromNumber, from_number: number.e164, voicemail_detection: 'hang_up', used_today: 0, daily_cap: 20 });

    const res = await press(source.id, headers);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ from_number: number.e164, to_number: source.fromNumber, agent_id: agentId, voicemail_detection: 'hang_up', used_today: 1 });
    expect(JSON.stringify(res.body)).not.toMatch(/retell/i);

    const placed = lastArgs<{ fromNumber: string; toNumber: string; agentId: string; agentVersion: number; metadata: Record<string, unknown>; voicemail: unknown }>('createPhoneCall');
    expect(placed).toMatchObject({ fromNumber: number.e164, toNumber: source.fromNumber, agentId: agent.retellAgentId, agentVersion: version.retellAgentVersion, voicemail: { action: 'hang_up' } });
    expect(placed.metadata).toMatchObject({ tenant_id: ws.workspaceId, agent_id: agentId, version_no: agent.publishedVersion, tier: agent.tier, test: false, number_id: number.id });
    expect((placed as { dynamicVariables?: Record<string, string> }).dynamicVariables).toEqual({
      transfer_number_1: '+14165550142',
      transfer_fail_message: 'Sorry, try our staff later.',
    });

    const callId = res.body.call_id as string;
    const detail = await call('GET', `/calls/${callId}`, headers);
    expect(detail.body).toMatchObject({ id: callId, direction: 'outbound', channel: 'phone', is_test: false, status: 'registered', from_number: number.e164, to_number: source.fromNumber, number_id: number.id });
    const outbound = await call('GET', '/calls?direction=outbound', headers);
    expect((outbound.body.items as Array<{ id: string }>).map((c) => c.id)).toEqual([callId]);

    const audit = await adminDb.auditLog.findFirstOrThrow({ where: { tenantId: ws.workspaceId, action: 'call.outbound_placed' } });
    expect(audit.metaJson).toMatchObject({ call_id: callId, to_country: 'CA', voicemail_detection: 'hang_up' });
    expect(JSON.stringify(audit.metaJson)).not.toContain(source.fromNumber!.slice(2, 10));
    expect(await adminDb.outboundCall.findFirstOrThrow({ where: { tenantId: ws.workspaceId } })).toMatchObject({ status: 'placed', callId });
    await redis.del(redisKeys.activeCalls(ws.workspaceId));
  });

  it('passes the voicemail setting through: leave a message with its text, or detection off', async () => {
    clockAt(openAt);
    const { ws, headers, agentId, number, source } = await setup('d18-vm');
    const editor = await addMember(ws.workspaceId, 'd18-vm-editor', 'editor');
    expect((await call('PUT', '/outbound/settings', await auth(editor.sub, ws.workspaceId), { voicemail_detection: 'off' })).status).toBe(403);
    expect((await call('PUT', '/outbound/settings', headers, { voicemail_detection: 'leave_message' })).status).toBe(422);

    const saved = await call('PUT', '/outbound/settings', headers, { voicemail_detection: 'leave_message', voicemail_message: 'Hi, it is Maple Dental returning your call.' });
    expect(saved.body.settings).toEqual({ voicemail_detection: 'leave_message', voicemail_message: 'Hi, it is Maple Dental returning your call.' });
    expect((await press(source.id, headers)).status).toBe(201);
    expect(lastArgs<{ voicemail: unknown }>('createPhoneCall').voicemail).toEqual({ action: 'leave_message', text: 'Hi, it is Maple Dental returning your call.' });

    await call('PUT', '/outbound/settings', headers, { voicemail_detection: 'off' });
    await redis.del(redisKeys.activeCalls(ws.workspaceId));
    const again = await d2Call(ws.workspaceId, agentId, number);
    expect((await press(again.id, headers)).status).toBe(201);
    expect(lastArgs<{ voicemail: unknown }>('createPhoneCall').voicemail).toBeNull();
    await redis.del(redisKeys.activeCalls(ws.workspaceId));
  });

  it('is one call per idempotency key — a double click or a retry places nothing new', async () => {
    clockAt(openAt);
    const { ws, headers, source, agentId, number } = await setup('d18-idem');
    const key = randomUUID();
    const before = retell.countOf('createPhoneCall');
    const [a, b] = await Promise.all([
      call('POST', `/calls/${source.id}/callback`, headers, { idempotency_key: key }),
      call('POST', `/calls/${source.id}/callback`, headers, { idempotency_key: key }),
    ]);
    const statuses = [a.status, b.status].sort();
    // Either the second waited for the first (201, the same call) or met it mid-flight (409).
    expect(statuses[0]).toBe(201);
    expect([201, 409]).toContain(statuses[1]);
    const replay = await call('POST', `/calls/${source.id}/callback`, headers, { idempotency_key: key });
    expect(replay.status).toBe(201);
    expect(replay.body.call_id).toBe((a.status === 201 ? a : b).body.call_id);
    expect(retell.countOf('createPhoneCall')).toBe(before + 1);
    expect(await adminDb.outboundCall.count({ where: { tenantId: ws.workspaceId } })).toBe(1);

    // The same key on another call is a client bug.
    const other = await d2Call(ws.workspaceId, agentId, number);
    expect((await call('POST', `/calls/${other.id}/callback`, headers, { idempotency_key: key })).body.code).toBe('CONFLICT');
    await redis.del(redisKeys.activeCalls(ws.workspaceId));
  });

  it('a provider refusal places nothing, counts nothing, frees the line, and the same key may try again', async () => {
    clockAt(openAt);
    const { ws, headers, source } = await setup('d18-upstream');
    const key = randomUUID();
    retell.failNext('createPhoneCall', 1, Retell.APIError.generate(400, { message: 'bad number' }, 'bad number', new Headers()));
    const failed = await call('POST', `/calls/${source.id}/callback`, headers, { idempotency_key: key });
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(JSON.stringify(failed.body)).not.toMatch(/retell|bad number/i);
    expect(await adminDb.outboundCall.findFirstOrThrow({ where: { tenantId: ws.workspaceId } })).toMatchObject({ status: 'failed', failure: 'upstream' });
    expect(await adminDb.call.count({ where: { tenantId: ws.workspaceId, direction: 'outbound' } })).toBe(0);
    expect(Object.keys(await redis.hgetall(redisKeys.activeCalls(ws.workspaceId)))).toEqual([]);
    const audit = await adminDb.auditLog.findFirstOrThrow({ where: { tenantId: ws.workspaceId, action: 'call.outbound_failed' } });
    expect(audit.metaJson).toMatchObject({ outcome: 'rejected' });
    expect((await call('GET', `/calls/${source.id}/callback`, headers)).body.used_today).toBe(0);

    const retried = await call('POST', `/calls/${source.id}/callback`, headers, { idempotency_key: key });
    expect(retried.status).toBe(201);
    expect(await adminDb.outboundCall.count({ where: { tenantId: ws.workspaceId } })).toBe(1);
    await redis.del(redisKeys.activeCalls(ws.workspaceId));
  });

  it('no answer from the provider may have rung the person: the key holds until a webhook names the call, and never rings twice', async () => {
    clockAt(openAt);
    const { ws, headers, source, number } = await setup('d18-unconfirmed');
    const key = randomUUID();
    const before = retell.countOf('createPhoneCall');
    retell.failNext('createPhoneCall'); // a reset: no status, no answer
    const failed = await call('POST', `/calls/${source.id}/callback`, headers, { idempotency_key: key });
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe('UPSTREAM_UNAVAILABLE');
    const attempt = await adminDb.outboundCall.findFirstOrThrow({ where: { tenantId: ws.workspaceId } });
    expect(attempt).toMatchObject({ status: 'pending', failure: 'unconfirmed', callId: null });
    expect(Object.keys(await redis.hgetall(redisKeys.activeCalls(ws.workspaceId)))).toEqual([]);
    // It may be ringing: it counts, and the same key is "being placed", not placed again.
    expect((await call('GET', `/calls/${source.id}/callback`, headers)).body.used_today).toBe(1);
    const again = await call('POST', `/calls/${source.id}/callback`, headers, { idempotency_key: key });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('OUTBOUND_IN_PROGRESS');
    expect(retell.countOf('createPhoneCall')).toBe(before + 1);

    // It did ring: call_started carries the attempt's id and binds it, so the key replays that call.
    const metadata = lastArgs<{ metadata: Record<string, unknown> }>('createPhoneCall').metadata;
    expect(metadata.outbound_id).toBe(attempt.id);
    const callId = `call_d18_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const started = await app.inject({
      method: 'POST',
      url: '/webhooks/retell',
      headers: { 'content-type': 'application/json', 'x-retell-signature': 'fake' },
      payload: JSON.stringify({
        event: 'call_started',
        event_timestamp: Date.now(),
        call: { call_id: callId, call_type: 'phone_call', direction: 'outbound', from_number: number.e164, to_number: source.fromNumber, agent_id: 'agent_whatever', metadata, start_timestamp: Date.now() },
      }),
    });
    expect(started.statusCode).toBeLessThan(300);
    await waitFor('the attempt bound to its call', async () => {
      const row = await adminDb.outboundCall.findUnique({ where: { id: attempt.id } });
      return row?.status === 'placed' ? row : null;
    });
    const replay = await call('POST', `/calls/${source.id}/callback`, headers, { idempotency_key: key });
    expect(replay.status).toBe(201);
    expect(replay.body.call_id).toBe(callId);
    expect(retell.countOf('createPhoneCall')).toBe(before + 1);
    await redis.del(redisKeys.activeCalls(ws.workspaceId));
  });

  it('an attempt no webhook ever named is written off after a while: it stops counting and its key may try again', async () => {
    clockAt(openAt);
    const { ws, headers, source } = await setup('d18-stale');
    const key = randomUUID();
    retell.failNext('createPhoneCall');
    expect((await call('POST', `/calls/${source.id}/callback`, headers, { idempotency_key: key })).status).toBe(503);
    // As a restart between the claim and the answer leaves it, long enough ago.
    await adminDb.outboundCall.updateMany({ where: { tenantId: ws.workspaceId }, data: { updatedAt: new Date(Date.now() - UNCONFIRMED_ATTEMPT_MS - 60_000) } });
    expect((await call('GET', `/calls/${source.id}/callback`, headers)).body.used_today).toBe(0);

    const before = retell.countOf('createPhoneCall');
    const retried = await call('POST', `/calls/${source.id}/callback`, headers, { idempotency_key: key });
    expect(retried.status).toBe(201);
    expect(retell.countOf('createPhoneCall')).toBe(before + 1);
    expect(await adminDb.outboundCall.findFirstOrThrow({ where: { tenantId: ws.workspaceId } })).toMatchObject({ status: 'placed', callId: retried.body.call_id });
    await redis.del(redisKeys.activeCalls(ws.workspaceId));
  });
});

describe('the daily cap', () => {
  it('holds under concurrent presses: with one call left today, exactly one of several is placed', async () => {
    clockAt(openAt);
    const { ws, headers, agentId, number } = await setup('d18-cap');
    const cap = (await config.outboundPolicy()).policy.daily_caps.starter;
    const localDay = localClock(openAt, 'America/Toronto')!.date;
    await adminDb.outboundCall.createMany({
      data: Array.from({ length: cap - 1 }, () => ({
        tenantId: ws.workspaceId,
        idempotencyKey: randomUUID(),
        sourceCallId: 'seeded',
        toNumber: caNumber(),
        fromNumber: number.e164,
        localDay: new Date(`${localDay}T00:00:00Z`),
        status: 'placed' as const,
        voicemail: 'hang_up',
      })),
    });
    const sources = await Promise.all(Array.from({ length: 4 }, () => d2Call(ws.workspaceId, agentId, number)));
    const before = retell.countOf('createPhoneCall');
    const results = await Promise.all(sources.map((s) => press(s.id, headers)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    // The plan's lines are taken before the cap is counted, so a press that lost the race
    // for a line is refused on that instead; at least one met the cap under the lock.
    for (const r of results.filter((x) => x.status !== 201)) {
      expect([`429 OUTBOUND_DAILY_CAP`, `409 CONCURRENCY_LIMIT`]).toContain(`${r.status} ${r.body.code}`);
    }
    expect(results.some((r) => r.body.code === 'OUTBOUND_DAILY_CAP')).toBe(true);
    expect(retell.countOf('createPhoneCall')).toBe(before + 1);
    expect(await adminDb.outboundCall.count({ where: { tenantId: ws.workspaceId, status: { in: ['pending', 'placed'] } } })).toBe(cap);
    await redis.del(redisKeys.activeCalls(ws.workspaceId));
  });
});

describe('metering', () => {
  it('bills the placed call once, from call_ended, at the agent’s rate — a replayed call_ended moves nothing', async () => {
    clockAt(openAt);
    const { ws, headers, source, number } = await setup('d18-bill');
    const res = await press(source.id, headers);
    expect(res.status).toBe(201);
    const callId = res.body.call_id as string;
    const metadata = lastArgs<{ metadata: Record<string, unknown> }>('createPhoneCall').metadata;
    const start = Date.now() - 120_000;
    const event = (name: string, extra: Record<string, unknown>) =>
      JSON.stringify({
        event: name,
        event_timestamp: Date.now(),
        call: { call_id: callId, call_type: 'phone_call', direction: 'outbound', from_number: number.e164, to_number: source.fromNumber, agent_id: 'agent_whatever', metadata, start_timestamp: start, ...extra },
      });
    const post = (payload: string) =>
      app.inject({ method: 'POST', url: '/webhooks/retell', headers: { 'content-type': 'application/json', 'x-retell-signature': 'fake' }, payload });

    expect((await post(event('call_started', {}))).statusCode).toBeLessThan(300);
    const ended = event('call_ended', { end_timestamp: start + 90_000, disconnection_reason: 'user_hangup', call_status: 'ended' });
    expect((await post(ended)).statusCode).toBeLessThan(300);
    const row = await waitFor('the outbound call billed', async () => {
      const r = await adminDb.call.findUnique({ where: { id: callId } });
      return r?.creditsCharged != null ? r : null;
    });
    expect(row).toMatchObject({ direction: 'outbound', isTest: false, durationS: 90, status: 'ended' });
    expect(row.creditsCharged!.toNumber()).toBe(Math.round(1.5 * row.rate.toNumber() * 100) / 100);

    expect((await post(ended)).statusCode).toBeLessThan(300);
    await new Promise((r) => setTimeout(r, 500));
    const ledger = await adminDb.creditLedger.findMany({ where: { tenantId: ws.workspaceId, reason: 'call', refId: callId } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.delta.toNumber()).toBe(-row.creditsCharged!.toNumber());
    expect(await adminDb.call.count({ where: { id: callId } })).toBe(1);
  });
});
