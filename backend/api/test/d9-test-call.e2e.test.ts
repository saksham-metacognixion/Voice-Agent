import { adminDb } from '@portal/db';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RecordingSigner, TEST_CALLS_PER_HOUR, encodeActive } from '../src/modules/calls';
import { PlatformConfigService } from '../src/modules/config';
import { REDIS, RedisCache, type RedisLike, redisKeys } from '../src/modules/redis';
import { WalletService } from '../src/modules/wallet';
import { type FakeRetellGateway, addMember, createWorkspace, startD5Harness } from './d5-fixtures';
import { authFor, caller, publishedAgent } from './d6-fixtures';

/*
 * §13.4 `POST /agents/:id/test/web` (W5, D9): the browser test call's request half.
 * It mints against the *version's* platform copy with the tenant metadata the lifecycle
 * handlers bill from, refuses what the spec says it refuses (no credits, the hourly
 * limit, the SA12 switch, a version not yet synced), and is workspace-scoped.
 */

let app: NestFastifyApplication;
let retell: FakeRetellGateway;
let stop: () => Promise<void>;
let auth: ReturnType<typeof authFor>;
let call: ReturnType<typeof caller>;

beforeAll(async () => {
  const harness = await startD5Harness();
  app = harness.app;
  retell = harness.retell;
  stop = harness.stop;
  auth = authFor(harness.customerTenant);
  call = caller(app);
});

/** A trial workspace as sign-up leaves it: the owner and the 20-credit grant (§5.4). */
async function trialWorkspace(label: string) {
  const ws = await createWorkspace(label);
  await app.get(WalletService).grantTrial(ws.workspaceId);
  return ws;
}

afterAll(async () => {
  await stop?.();
  await adminDb.$disconnect();
});

describe('POST /agents/:id/test/web', () => {
  it('mints a call for the version under test, with the tenant metadata billing needs and no platform ids in the answer', async () => {
    const ws = await trialWorkspace('tw-mint');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers);
    const agent = await adminDb.agent.findUniqueOrThrow({ where: { id: agentId } });
    const version = await adminDb.agentVersion.findUniqueOrThrow({ where: { agentId_versionNo: { agentId, versionNo: 1 } } });

    const res = await call('POST', `/agents/${agentId}/test/web`, headers, { version_no: 1 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ access_token: 'fake-access-token', version_no: 1, transport: 'livekit' });
    expect(typeof res.body.call_id).toBe('string');
    expect(res.body.balance).toBe(20); // the trial grant
    expect(res.body.rate).toBeGreaterThan(0);
    const { access_token: _a, live_token: liveToken, ...rest } = res.body as Record<string, unknown>;
    expect(JSON.stringify(rest)).not.toMatch(/retell|agent_/i);
    // The live-transcript credential: this call, this workspace, and nothing a recording link accepts.
    const signer = app.get(RecordingSigner);
    expect(signer.verify(liveToken as string, new Date(), 'live')).toMatchObject({ callId: res.body.call_id, workspaceId: ws.workspaceId });
    expect(signer.verify(liveToken as string)).toBeNull();

    const minted = retell.calls.filter((c) => c.method === 'createWebCall').at(-1)!.args[0] as {
      agentId: string;
      agentVersion: number;
      metadata: Record<string, unknown>;
      maxCallDurationMs: number;
    };
    expect(minted.agentId).toBe(agent.retellAgentId);
    expect(minted.agentVersion).toBe(version.retellAgentVersion);
    expect(minted.metadata).toEqual({ tenant_id: ws.workspaceId, agent_id: agentId, version_no: 1, tier: agent.tier, test: true });
    // min(the version's ceiling, what 20 credits cover at this rate)
    const covered = (20 / (res.body.rate as number)) * 60_000;
    expect(minted.maxCallDurationMs).toBe(Math.round(Math.min(agent.maxCallDurationS * 1_000, covered)));
    expect(res.body.max_call_duration_s).toBe(Math.floor(minted.maxCallDurationMs / 1_000));
  });

  it('syncs the draft to the platform before testing it, so W3 edits are what rings', async () => {
    const ws = await trialWorkspace('tw-draft');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers, { publish: false });
    // W3: a voice and a language chosen after the last generation, saved on the draft only.
    const voice = await adminDb.voice.findFirst({ where: { provider: 'cartesia' } }) ?? await adminDb.voice.findFirstOrThrow();
    expect((await call('PATCH', `/agents/${agentId}/draft`, headers, { voice_id: voice.retellVoiceId, tier: voice.tier })).status).toBe(200);

    const updatesBefore = retell.countOf('updateAgent') + retell.countOf('createAgent');
    const res = await call('POST', `/agents/${agentId}/test/web`, headers, {});
    expect(res.status).toBe(201);
    expect(retell.countOf('updateAgent') + retell.countOf('createAgent')).toBeGreaterThan(updatesBefore);
    const spec = retell.calls.filter((c) => c.method === 'createAgent' || c.method === 'updateAgent').at(-1)!.args.at(-1) as { voiceId: string };
    expect(spec.voiceId).toBe(voice.retellVoiceId);
    const version = await adminDb.agentVersion.findUniqueOrThrow({ where: { agentId_versionNo: { agentId, versionNo: 1 } } });
    const minted = retell.calls.filter((c) => c.method === 'createWebCall').at(-1)!.args[0] as { agentVersion: number };
    expect(version.retellAgentVersion).not.toBeNull();
    expect(minted.agentVersion).toBe(version.retellAgentVersion);
  });

  it('refuses a draft with no prompt yet, and a version that does not exist', async () => {
    const ws = await trialWorkspace('tw-noprompt');
    const headers = await auth(ws.sub, ws.workspaceId);
    const created = await call('POST', '/agents', headers, { template_id: 'receptionist', industry: 'dental' });
    const agentId = created.body.id as string;
    const res = await call('POST', `/agents/${agentId}/test/web`, headers, {});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BRIEF_INCOMPLETE');
    expect((await call('POST', `/agents/${agentId}/test/web`, headers, { version_no: 99 })).status).toBe(404);
  });

  it('answers 402 NO_CREDITS on an empty wallet and mints nothing', async () => {
    const ws = await trialWorkspace('tw-empty');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers);
    await app.get(WalletService).debit(ws.workspaceId, { credits: 20, reason: 'adjustment', refType: 'e2e', refId: 'drain' });
    const before = retell.countOf('createWebCall');
    const res = await call('POST', `/agents/${agentId}/test/web`, headers, {});
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('NO_CREDITS');
    expect(retell.countOf('createWebCall')).toBe(before);
  });

  it('sizes the ceiling from what the other live calls leave, and refuses when they hold it all or fill the plan’s lines (ADR 0011 §1)', async () => {
    const ws = await trialWorkspace('tw-headroom');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers);
    const redis = app.get<RedisLike>(REDIS);
    const key = redisKeys.activeCalls(ws.workspaceId);
    const inAnHour = Date.now() + 3_600_000;

    // Another call holds 15 of the 20 trial credits: this one may run what 5 cover, not 20.
    await redis.hset(key, 'call_other_1', encodeActive(15, inAnHour));
    const res = await call('POST', `/agents/${agentId}/test/web`, headers, {});
    expect(res.status).toBe(201);
    const rate = res.body.rate as number;
    const minted = retell.calls.filter((c) => c.method === 'createWebCall').at(-1)!.args[0] as { maxCallDurationMs: number };
    expect(minted.maxCallDurationMs).toBe(Math.round((5 / rate) * 60_000));
    expect(res.body.balance).toBe(20); // the wallet itself is untouched

    // Holding all of it: no credits for this call, and nothing minted.
    await redis.hset(key, 'call_other_1', encodeActive(20, inAnHour));
    const before = retell.countOf('createWebCall');
    const none = await call('POST', `/agents/${agentId}/test/web`, headers, {});
    expect(none.status).toBe(402);
    expect(none.body.code).toBe('NO_CREDITS');
    expect(retell.countOf('createWebCall')).toBe(before);

    // Every line of the plan on a call: 409, whatever the wallet holds.
    await redis.hdel(key, 'call_other_1');
    const cap = (await app.get(PlatformConfigService).capsFor(ws.workspaceId)).concurrency_cap;
    expect(cap).toBeGreaterThan(0);
    for (let i = 0; i < cap; i += 1) await redis.hset(key, `call_busy_${i}`, encodeActive(1, inAnHour));
    const full = await call('POST', `/agents/${agentId}/test/web`, headers, {});
    expect(full.status).toBe(409);
    expect(full.body.code).toBe('CONCURRENCY_LIMIT');
    expect(retell.countOf('createWebCall')).toBe(before);

    // An expired entry is not a live call.
    await redis.del(key);
    await redis.hset(key, 'call_stale', encodeActive(20, Date.now() - 1_000));
    expect((await call('POST', `/agents/${agentId}/test/web`, headers, {})).status).toBe(201);
  });

  it(`allows ${TEST_CALLS_PER_HOUR} calls an hour per workspace, then 429 TEST_RATE_LIMIT — a fixed window that a refused mint does not spend`, async () => {
    const ws = await trialWorkspace('tw-limit');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers);
    const key = redisKeys.testCallWindow(ws.workspaceId);
    await app.get(RedisCache).del(key);
    const redis = app.get(REDIS) as RedisLike & { ttl(key: string): Promise<number> };

    // A mint the platform refuses is not one of the ten.
    retell.failNext('createWebCall', 1, new Error('retell answered 503'));
    expect((await call('POST', `/agents/${agentId}/test/web`, headers, {})).status).toBe(503);
    expect(await redis.get(key)).toBeNull();

    for (let i = 0; i < TEST_CALLS_PER_HOUR; i += 1) {
      expect((await call('POST', `/agents/${agentId}/test/web`, headers, {})).status).toBe(201);
    }
    const over = await call('POST', `/agents/${agentId}/test/web`, headers, {});
    expect(over.status).toBe(429);
    expect(over.body.code).toBe('TEST_RATE_LIMIT');

    // The window is the hour after the first call: later calls did not push it out.
    expect(await redis.get(key)).toBe(String(TEST_CALLS_PER_HOUR));
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(3_500);
    expect(ttl).toBeLessThanOrEqual(3_600);
    // …and once it lapses the count starts over rather than carrying on.
    await redis.expire(key, 1);
    await new Promise((r) => setTimeout(r, 1_100));
    expect((await call('POST', `/agents/${agentId}/test/web`, headers, {})).status).toBe(201);
    expect(await redis.get(key)).toBe('1');
  });

  it('is refused while the SA12 pause_web_tests switch is on', async () => {
    const ws = await trialWorkspace('tw-paused');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers);
    const config = app.get(PlatformConfigService);
    await config.setKillSwitch('pause_web_tests', { on: true, reason: 'e2e' });
    try {
      const res = await call('POST', `/agents/${agentId}/test/web`, headers, {});
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('TESTS_PAUSED');
    } finally {
      await config.setKillSwitch('pause_web_tests', { on: false });
    }
  });

  it('is editor-and-up and workspace-scoped', async () => {
    const ws = await trialWorkspace('tw-roles');
    const headers = await auth(ws.sub, ws.workspaceId);
    const agentId = await publishedAgent(call, headers);
    const viewer = await addMember(ws.workspaceId, 'tw-viewer', 'viewer');
    expect((await call('POST', `/agents/${agentId}/test/web`, await auth(viewer.sub, ws.workspaceId), {})).status).toBe(403);
    const editor = await addMember(ws.workspaceId, 'tw-editor', 'editor');
    expect((await call('POST', `/agents/${agentId}/test/web`, await auth(editor.sub, ws.workspaceId), {})).status).toBe(201);

    const other = await createWorkspace('tw-other');
    expect((await call('POST', `/agents/${agentId}/test/web`, await auth(other.sub, other.workspaceId), {})).status).toBe(404);
  });
});
