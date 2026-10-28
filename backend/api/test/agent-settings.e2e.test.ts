import { randomUUID } from 'node:crypto';
import { adminDb } from '@portal/db';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PlatformConfigService } from '../src/modules/config';
import { applyGuardrails } from '../src/modules/prompting';
import { RedisCache, redisKeys } from '../src/modules/redis';
import { RuntimeCacheService, type NumberRecord } from '../src/modules/runtime-cache';
import { VoicesService } from '../src/modules/voices';
import type { FakeAuth0Tenant } from './auth0-double';
import {
  type FakeRetellGateway,
  READY_BRIEF,
  type TestWorkspace,
  createWorkspace,
  startD5Harness,
  waitForJob,
} from './d5-fixtures';

/*
 * D5 review finding 1: a draft must never change what is live.
 *
 * `agents.tier` is what a call is billed at (`calls.rate` derives from it), `num:{e164}`
 * carries the tier, the rate and the agent's duration ceiling for the §13.9 hot path, and
 * Retell runs whatever was last published. Before this fix the D3 Voice tab wrote tier,
 * voice and duration straight onto `agents`, so a live Premium agent flipped to Standard
 * in the draft was billed at 1 credit/min while Retell kept running the Premium stack.
 *
 * Now the settings travel with the version and reach `agents` — and the runtime cache —
 * only through a publish. This file proves each half of that.
 */

let app: NestFastifyApplication;
let stop: () => Promise<void>;
let customerTenant: FakeAuth0Tenant;
let retell: FakeRetellGateway;
let ws: TestWorkspace;
let cache: RedisCache;
let runtimeCache: RuntimeCacheService;
let standardRate = 0;
let premiumRate = 0;
let premiumStackMaxMs = 0;

beforeAll(async () => {
  const harness = await startD5Harness({ workers: true });
  app = harness.app;
  stop = harness.stop;
  customerTenant = harness.customerTenant;
  retell = harness.retell;
  ws = await createWorkspace('settings');
  cache = app.get(RedisCache);
  runtimeCache = app.get(RuntimeCacheService);

  if ((await adminDb.agentStackConfig.count()) === 0) {
    throw new Error('agent_stack_configs is empty — run `pnpm db:seed` before the e2e suites');
  }
  const stack = await adminDb.agentStackConfig.findFirstOrThrow({ orderBy: { version: 'desc' } });
  premiumStackMaxMs = (stack.tiersJson as { premium: { max_call_duration_ms: number } }).premium
    .max_call_duration_ms;

  const config = app.get(PlatformConfigService);
  standardRate = (await config.rateFor('standard')).rate;
  premiumRate = (await config.rateFor('premium')).rate;
  expect(premiumRate).toBeGreaterThan(standardRate);

  // The W3 catalogue, so `voice_id` choices pass the foreign key.
  await app.get(VoicesService).refreshCache();
});

afterAll(async () => {
  await stop?.();
  await adminDb.$disconnect();
});

beforeEach(() => retell.reset());

async function headers(): Promise<Record<string, string>> {
  return {
    authorization: `Bearer ${await customerTenant.mint(ws.sub)}`,
    'x-workspace-id': ws.workspaceId,
  };
}

async function req(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
) {
  const base = await headers();
  return app.inject({
    method,
    url,
    headers: body === undefined ? base : { ...base, 'content-type': 'application/json' },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** A live Standard agent with a phone number bound, so `num:{e164}` exists for it. */
async function liveAgentWithNumber() {
  const agentId = (await req('POST', '/agents', { template_id: 'receptionist' })).json()
    .id as string;
  await adminDb.agentVersion.update({
    where: { agentId_versionNo: { agentId, versionNo: 1 } },
    data: {
      promptText: applyGuardrails(
        'You are Sophie, the receptionist for Maple Dental. Greet the caller and take a message.',
      ),
      greeting: 'Thank you for calling Maple Dental.',
      closing: 'Thanks, goodbye.',
    },
  });
  const published = await req('POST', `/agents/${agentId}/publish`, {});
  expect(published.statusCode).toBe(201);

  const e164 = `+1438${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
  await adminDb.phoneNumber.create({
    data: {
      tenantId: ws.workspaceId,
      agentId,
      e164,
      type: 'retell_twilio',
      status: 'active',
      inboundToken: `tok_${randomUUID().replace(/-/g, '')}`,
      country: 'CA',
    },
  });
  await runtimeCache.refresh(ws.workspaceId);
  return { agentId, e164 };
}

async function numberRecord(e164: string): Promise<NumberRecord> {
  const record = await cache.getJson<NumberRecord>(redisKeys.number(e164));
  if (!record) throw new Error(`no num:{${e164}} record`);
  return record;
}

// ---------------------------------------------------------------------------
describe('a draft edit changes nothing that is live', () => {
  it('a draft tier change does not change the billing rate or the runtime record', async () => {
    const { agentId, e164 } = await liveAgentWithNumber();
    const before = await numberRecord(e164);
    expect(before).toMatchObject({
      tier: 'standard',
      rate_per_min: standardRate,
      agent_live: true,
    });

    const res = await req('PATCH', `/agents/${agentId}/draft`, { tier: 'premium' });
    expect(res.statusCode).toBe(200);

    // The draft carries it, forked because v1 is published.
    expect(res.json().draft.settings.tier).toBe('premium');
    expect(res.json()).toMatchObject({
      draft_version: 2,
      published_version: 1,
      has_unpublished_changes: true,
    });
    // The live agent — and therefore the rate every call bills at — has not moved.
    expect(res.json().tier).toBe('standard');
    expect(res.json().published.settings.tier).toBe('standard');
    expect((await adminDb.agent.findUniqueOrThrow({ where: { id: agentId } })).tier).toBe(
      'standard',
    );

    // Neither has what the §13.9 hot path reads, even after a full refresh.
    await runtimeCache.refresh(ws.workspaceId);
    const after = await numberRecord(e164);
    expect(after).toMatchObject({ tier: 'standard', rate_per_min: standardRate });
  });

  it('a draft duration change does not change the runtime duration ceiling', async () => {
    const { agentId, e164 } = await liveAgentWithNumber();
    const before = await numberRecord(e164);
    expect(before.plan_max_ms).toBe(600_000);

    const res = await req('PATCH', `/agents/${agentId}/draft`, { max_call_duration_s: 1_500 });
    expect(res.json().draft.settings.max_call_duration_s).toBe(1_500);
    expect(res.json().max_call_duration_s).toBe(600);
    expect(
      (await adminDb.agent.findUniqueOrThrow({ where: { id: agentId } })).maxCallDurationS,
    ).toBe(600);

    await runtimeCache.refresh(ws.workspaceId);
    expect((await numberRecord(e164)).plan_max_ms).toBe(600_000);
  });

  it('a draft voice change does not touch the published agent, on our side or on Retell', async () => {
    const { agentId } = await liveAgentWithNumber();
    retell.calls.length = 0;

    const res = await req('PATCH', `/agents/${agentId}/draft`, { voice_id: 'cartesia-Cleo' });
    expect(res.statusCode).toBe(200);
    expect(res.json().draft.settings.voice_id).toBe('cartesia-Cleo');
    expect(res.json().voice_id).toBeNull();
    expect((await adminDb.agent.findUniqueOrThrow({ where: { id: agentId } })).voiceId).toBeNull();
    // No Retell call of any kind: the draft is not on the phone.
    expect(retell.calls).toEqual([]);
  });

  it('a draft edit on an unpublished agent still keeps the live columns at their defaults', async () => {
    const agentId = (await req('POST', '/agents', { template_id: 'receptionist' })).json()
      .id as string;
    await req('PATCH', `/agents/${agentId}/draft`, {
      tier: 'premium',
      max_call_duration_s: 1_200,
      primary_language: 'fr-CA',
    });
    const row = await adminDb.agent.findUniqueOrThrow({ where: { id: agentId } });
    expect(row).toMatchObject({
      tier: 'standard',
      maxCallDurationS: 600,
      primaryLanguage: 'en-US',
    });
    const v1 = await adminDb.agentVersion.findUniqueOrThrow({
      where: { agentId_versionNo: { agentId, versionNo: 1 } },
    });
    expect(v1.settingsJson).toMatchObject({
      tier: 'premium',
      max_call_duration_s: 1_200,
      primary_language: 'fr-CA',
    });
  });
});

// ---------------------------------------------------------------------------
describe('publish is what activates a version’s settings', () => {
  it('copies the version’s settings onto the agent, sends them to Retell and refreshes the runtime record', async () => {
    const { agentId, e164 } = await liveAgentWithNumber();
    await req('PATCH', `/agents/${agentId}/draft`, {
      tier: 'premium',
      max_call_duration_s: 1_200,
      voice_id: 'cartesia-Cleo',
    });
    // Clear the call log only: `reset()` would also forget the Retell agent v1 created.
    retell.calls.length = 0;

    const res = await req('POST', `/agents/${agentId}/publish`, {});
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ version_no: 2, status: 'live' });

    // Live now — all of it, in one transaction with published_version.
    const row = await adminDb.agent.findUniqueOrThrow({ where: { id: agentId } });
    expect(row).toMatchObject({
      publishedVersion: 2,
      tier: 'premium',
      maxCallDurationS: 1_200,
      voiceId: 'cartesia-Cleo',
    });
    const shown = await req('GET', `/agents/${agentId}`);
    expect(shown.json()).toMatchObject({
      tier: 'premium',
      max_call_duration_s: 1_200,
      voice_id: 'cartesia-Cleo',
      has_unpublished_changes: false,
    });

    // Retell was given the version's settings, not the old live row's.
    const update = retell.calls.find((c) => c.method === 'updateAgent')!;
    expect(update.args[1]).toMatchObject({
      voiceId: 'cartesia-Cleo',
      maxCallDurationMs: Math.min(1_200_000, premiumStackMaxMs),
    });
    expect(retell.countOf('publishAgent')).toBe(1);

    // And the hot path sees the new tier, rate and ceiling without waiting for the schedule.
    const record = await numberRecord(e164);
    expect(record).toMatchObject({
      tier: 'premium',
      rate_per_min: premiumRate,
      plan_max_ms: Math.min(1_200_000, premiumStackMaxMs),
    });
  });

  it('publishing an older version rolls its settings back too', async () => {
    const { agentId, e164 } = await liveAgentWithNumber();
    await req('PATCH', `/agents/${agentId}/draft`, { tier: 'premium' });
    expect((await req('POST', `/agents/${agentId}/publish`, {})).statusCode).toBe(201);
    expect((await numberRecord(e164)).tier).toBe('premium');

    const back = await req('POST', `/agents/${agentId}/publish`, { version_no: 1 });
    expect(back.statusCode).toBe(201);
    expect((await adminDb.agent.findUniqueOrThrow({ where: { id: agentId } })).tier).toBe(
      'standard',
    );
    expect(await numberRecord(e164)).toMatchObject({
      tier: 'standard',
      rate_per_min: standardRate,
    });
  });

  it('a rename is the one live write a draft patch makes, and it refreshes the runtime record', async () => {
    const { agentId, e164 } = await liveAgentWithNumber();
    const res = await req('PATCH', `/agents/${agentId}/draft`, {
      name: `Front desk ${randomUUID().slice(0, 4)}`,
    });
    expect(res.statusCode).toBe(200);
    expect((await numberRecord(e164)).agent_name).toBe(res.json().name);
    // A label is not content: no new version was forked for it.
    expect(res.json().draft_version).toBe(1);
  });

  it('refuses to publish a version whose voice has left the catalogue, before touching Retell', async () => {
    const { agentId } = await liveAgentWithNumber();
    await req('PATCH', `/agents/${agentId}/draft`, { voice_id: 'cartesia-Margot' });
    await adminDb.voice
      .delete({ where: { retellVoiceId: 'cartesia-Margot' } })
      .catch(() => undefined);
    retell.calls.length = 0;
    try {
      const res = await req('POST', `/agents/${agentId}/publish`, {});
      expect(res.statusCode).toBe(400);
      expect(res.json().fields?.[0]?.field).toBe('voice_id');
      expect(retell.calls).toEqual([]);
      expect(
        (await adminDb.agent.findUniqueOrThrow({ where: { id: agentId } })).publishingSince,
      ).toBeNull();
    } finally {
      await app.get(VoicesService).refreshCache();
    }
  });
});

// ---------------------------------------------------------------------------
describe('generation follows the draft’s settings', () => {
  it('writes the draft settings onto the generated version and syncs the Retell draft with that tier’s stack', async () => {
    const agentId = (await req('POST', '/agents', { template_id: 'receptionist' })).json()
      .id as string;
    await req('PATCH', `/agents/${agentId}/draft`, {
      brief: READY_BRIEF,
      tier: 'premium',
      voice_id: 'cartesia-Cleo',
    });
    retell.reset();

    const accepted = await req('POST', `/agents/${agentId}/generate`, {});
    expect(accepted.statusCode).toBe(202);
    const job = await waitForJob(accepted.json().job_id);
    expect(job.status).toBe('succeeded');

    const v2 = await adminDb.agentVersion.findUniqueOrThrow({
      where: { agentId_versionNo: { agentId, versionNo: 2 } },
    });
    expect(v2.settingsJson).toMatchObject({ tier: 'premium', voice_id: 'cartesia-Cleo' });

    const stack = await adminDb.agentStackConfig.findFirstOrThrow({ orderBy: { version: 'desc' } });
    const premiumModel = (stack.tiersJson as { premium: { model: string } }).premium.model;
    const llm = retell.calls.find((c) => c.method === 'createLlm')!;
    expect((llm.args[0] as { model: string }).model).toBe(premiumModel);
    const agent = retell.calls.find((c) => c.method === 'createAgent')!;
    expect((agent.args[0] as { voiceId: string }).voiceId).toBe('cartesia-Cleo');

    // Still nothing live.
    expect((await adminDb.agent.findUniqueOrThrow({ where: { id: agentId } })).tier).toBe(
      'standard',
    );
  });
});

// ---------------------------------------------------------------------------
// QA-079 / QA-081: the D3 add-ons, the analysis-fields editor, "Save as new version" and
// the D6 privacy settings. The plan gates come from a tenant override (admin §5.3), which
// `GET /flags` and the API both read through `PlatformConfigService`.
describe('denoise, PII removal and analysis fields travel with the version, behind their gates', () => {
  const config = () => app.get(PlatformConfigService);

  async function setGates(gates: Record<string, boolean> | null) {
    if (gates === null) await adminDb.tenantOverride.deleteMany({ where: { tenantId: ws.workspaceId } });
    else {
      await adminDb.tenantOverride.upsert({
        where: { tenantId: ws.workspaceId },
        create: { tenantId: ws.workspaceId, gatesJson: gates, reason: 'e2e QA-079 gates' },
        update: { gatesJson: gates },
      });
    }
    await config().invalidateWorkspace(ws.workspaceId);
  }

  const FIELDS = [
    { name: 'caller_name', type: 'text', description: 'The name the caller gave.' },
    { name: 'callback_number', type: 'text', description: 'The number to call back on.' },
    { name: 'preferred_day', type: 'enum', description: 'The day they would like to come in.', enum: ['weekday', 'weekend'] },
  ];

  afterAll(async () => {
    await setGates(null);
    await adminDb.tenant.update({
      where: { id: ws.workspaceId },
      data: { piiRemovalDefault: false, recordingNotice: true, recordingNoticeText: null },
    });
  });

  it('refuses turning an add-on on, or editing the fields, without the plan gate — and changes nothing', async () => {
    await setGates({ denoise: false, pii_removal: false, analysis_fields: false });
    const agentId = (await req('POST', '/agents', { template_id: 'receptionist' })).json().id as string;

    for (const body of [{ denoise: true }, { pii_removal: true }, { analysis_fields: FIELDS }]) {
      const res = await req('PATCH', `/agents/${agentId}/draft`, body);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('PLAN_LIMIT');
      expect(res.json().fields?.[0]?.field).toBe(Object.keys(body)[0]);
    }
    // Turning one off never needs the gate.
    expect((await req('PATCH', `/agents/${agentId}/draft`, { denoise: false })).statusCode).toBe(200);

    const v1 = await adminDb.agentVersion.findUniqueOrThrow({ where: { agentId_versionNo: { agentId, versionNo: 1 } } });
    expect(v1.settingsJson).toMatchObject({ denoise: false, pii_removal: false, analysis_fields_edited: false });
    expect((v1.analysisSchemaJson as Array<{ name: string }>).map((f) => f.name)).not.toContain('preferred_day');
  });

  it('writes them into the draft, keeps the live agent as it is, and publish sends them to the platform', async () => {
    await setGates({ denoise: true, pii_removal: true, analysis_fields: true });
    const { agentId } = await liveAgentWithNumber();

    const res = await req('PATCH', `/agents/${agentId}/draft`, { denoise: true, pii_removal: true, analysis_fields: FIELDS });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ draft_version: 2, published_version: 1 });
    expect(res.json().draft.settings).toMatchObject({ denoise: true, pii_removal: true, analysis_fields_edited: true });
    expect(res.json().draft.analysis_fields).toEqual(FIELDS);
    expect(res.json().published.settings).toMatchObject({ denoise: false, pii_removal: false });

    retell.calls.length = 0;
    const published = await req('POST', `/agents/${agentId}/publish`, {});
    expect(published.statusCode).toBe(201);
    const spec = retell.calls.find((c) => c.method === 'updateAgent')!.args[1] as {
      denoisingMode: string;
      piiRemoval: boolean;
      postCallAnalysis: Array<{ name: string; description: string; choices?: string[] }>;
    };
    expect(spec.denoisingMode).toBe('noise-and-background-speech-cancellation');
    expect(spec.piiRemoval).toBe(true);
    expect(spec.postCallAnalysis.map((f) => f.name)).toEqual(['caller_name', 'callback_number', 'preferred_day']);
    // A customer's phone field still gets the phone rule (PHONE_FIELD_RULE is by name).
    expect(spec.postCallAnalysis[1]!.description).toContain('Copy the digits exactly');
    expect(spec.postCallAnalysis[2]!.choices).toEqual(['weekday', 'weekend']);

    const shown = (await req('GET', `/agents/${agentId}`)).json();
    expect(shown.published.settings).toMatchObject({ denoise: true, pii_removal: true });
    expect(shown.published.analysis_fields).toEqual(FIELDS);
  });

  it('sends an add-on off at the next publish once the plan has lost its gate, and the version keeps the choice', async () => {
    await setGates({ denoise: true, pii_removal: true, analysis_fields: true });
    const { agentId } = await liveAgentWithNumber();
    await req('PATCH', `/agents/${agentId}/draft`, { denoise: true, pii_removal: true });
    expect((await req('POST', `/agents/${agentId}/publish`, {})).statusCode).toBe(201);

    await setGates({ denoise: false, pii_removal: false });
    await req('PATCH', `/agents/${agentId}/draft`, { max_call_duration_s: 900 });
    retell.calls.length = 0;
    expect((await req('POST', `/agents/${agentId}/publish`, {})).statusCode).toBe(201);
    const spec = retell.calls.find((c) => c.method === 'updateAgent')!.args[1] as { denoisingMode?: string; piiRemoval: boolean };
    expect(spec.piiRemoval).toBe(false);
    expect(spec.denoisingMode).not.toBe('noise-and-background-speech-cancellation');
    const v3 = await adminDb.agentVersion.findUniqueOrThrow({ where: { agentId_versionNo: { agentId, versionNo: 3 } } });
    expect(v3.settingsJson).toMatchObject({ denoise: true, pii_removal: true });
  });

  it('refuses two fields with one name', async () => {
    await setGates({ analysis_fields: true });
    const agentId = (await req('POST', '/agents', { template_id: 'receptionist' })).json().id as string;
    const res = await req('PATCH', `/agents/${agentId}/draft`, { analysis_fields: [FIELDS[0], FIELDS[0]] });
    expect(res.statusCode).toBe(422);
  });

  it('a regenerate keeps fields the customer edited instead of rebuilding them from the template', async () => {
    await setGates({ analysis_fields: true });
    const agentId = (await req('POST', '/agents', { template_id: 'receptionist' })).json().id as string;
    await req('PATCH', `/agents/${agentId}/draft`, { brief: READY_BRIEF, analysis_fields: FIELDS });

    const accepted = await req('POST', `/agents/${agentId}/generate`, {});
    expect(accepted.statusCode).toBe(202);
    expect((await waitForJob(accepted.json().job_id)).status).toBe('succeeded');

    const v2 = await adminDb.agentVersion.findUniqueOrThrow({ where: { agentId_versionNo: { agentId, versionNo: 2 } } });
    expect(v2.analysisSchemaJson).toEqual(FIELDS);
    expect(v2.settingsJson).toMatchObject({ analysis_fields_edited: true });
  });
});

describe('Save as new version (QA-079)', () => {
  it('freezes the draft as it is and moves edits onto a copy', async () => {
    const agentId = (await req('POST', '/agents', { template_id: 'receptionist' })).json().id as string;
    await req('PATCH', `/agents/${agentId}/draft`, { brief: { agent_name: 'Sophie' } });

    const saved = await req('POST', `/agents/${agentId}/versions`);
    expect(saved.statusCode).toBe(201);
    expect(saved.json()).toEqual({ saved_version: 1, draft_version: 2, created: true });

    // The next edit lands on the copy; v1 is history now and keeps what it had.
    const edited = await req('PATCH', `/agents/${agentId}/draft`, { brief: { agent_name: 'Maya' } });
    expect(edited.json().draft_version).toBe(2);
    const [v1, v2] = await Promise.all(
      [1, 2].map((versionNo) => adminDb.agentVersion.findUniqueOrThrow({ where: { agentId_versionNo: { agentId, versionNo } } })),
    );
    expect(v1!.briefJson).toMatchObject({ agent_name: 'Sophie' });
    expect(v2!.briefJson).toMatchObject({ agent_name: 'Maya' });
    expect(v2!.settingsJson).toEqual(v1!.settingsJson);
    expect(v2!.analysisSchemaJson).toEqual(v1!.analysisSchemaJson);

    // v1 can be brought back, and saving a frozen draft writes nothing.
    expect((await req('POST', `/agents/${agentId}/draft/select`, { version_no: 1 })).statusCode).toBe(201);
    expect((await req('POST', `/agents/${agentId}/versions`)).json()).toEqual({ saved_version: 1, draft_version: 1, created: false });
    expect(await adminDb.agentVersion.count({ where: { agentId } })).toBe(2);

    const audit = await adminDb.auditLog.findFirst({ where: { tenantId: ws.workspaceId, action: 'agent.version_saved', targetId: agentId } });
    expect(audit?.metaJson).toMatchObject({ version_no: 1, draft_version: 2 });
  });
});

describe('D6 privacy: the recording notice and the PII default (QA-081)', () => {
  const config = () => app.get(PlatformConfigService);

  afterAll(async () => {
    await adminDb.tenantOverride.deleteMany({ where: { tenantId: ws.workspaceId } });
    await adminDb.tenant.update({
      where: { id: ws.workspaceId },
      data: { piiRemovalDefault: false, recordingNotice: true, recordingNoticeText: null },
    });
    await config().invalidateWorkspace(ws.workspaceId);
  });

  const beginMessage = () => {
    const llm = retell.calls.filter((c) => c.method === 'createLlm' || c.method === 'updateLlm').at(-1)!;
    return (llm.method === 'createLlm' ? llm.args[0] : llm.args[1]) as { beginMessage: string | null };
  };

  it('a recording agent says the notice before its greeting; the stored greeting never has it', async () => {
    await liveAgentWithNumber();
    expect(beginMessage().beginMessage).toBe('Just so you know, this call is recorded. Thank you for calling Maple Dental.');

    const own = await req('PATCH', '/workspace', { recording_notice_text: '  This call is recorded for training.  ' });
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({ recording_notice: true, recording_notice_text: 'This call is recorded for training.' });
    const { agentId } = await liveAgentWithNumber();
    expect(beginMessage().beginMessage).toBe('This call is recorded for training. Thank you for calling Maple Dental.');
    const v1 = await adminDb.agentVersion.findUniqueOrThrow({ where: { agentId_versionNo: { agentId, versionNo: 1 } } });
    expect(v1.greeting).toBe('Thank you for calling Maple Dental.');

    // Blank goes back to ours; off, or an agent that does not record, says nothing.
    expect((await req('PATCH', '/workspace', { recording_notice_text: '' })).json().recording_notice_text).toBeNull();
    await req('PATCH', `/agents/${agentId}/draft`, { recording_enabled: false });
    retell.calls.length = 0;
    await req('POST', `/agents/${agentId}/publish`, {});
    expect(beginMessage().beginMessage).toBe('Thank you for calling Maple Dental.');

    await req('PATCH', '/workspace', { recording_notice: false });
    await liveAgentWithNumber();
    expect(beginMessage().beginMessage).toBe('Thank you for calling Maple Dental.');
  });

  it('the PII default needs the plan, and a new agent then starts with PII removal on', async () => {
    await adminDb.tenantOverride.deleteMany({ where: { tenantId: ws.workspaceId } });
    await config().invalidateWorkspace(ws.workspaceId);
    const refused = await req('PATCH', '/workspace', { pii_removal_default: true });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().code).toBe('PLAN_LIMIT');

    await adminDb.tenantOverride.upsert({
      where: { tenantId: ws.workspaceId },
      create: { tenantId: ws.workspaceId, gatesJson: { pii_removal: true }, reason: 'e2e QA-081' },
      update: { gatesJson: { pii_removal: true } },
    });
    await config().invalidateWorkspace(ws.workspaceId);
    expect((await req('PATCH', '/workspace', { pii_removal_default: true, recording_default: false })).json()).toMatchObject({
      pii_removal_default: true,
      recording_default: false,
    });

    const created = (await req('POST', '/agents', { template_id: 'receptionist' })).json();
    expect(created.draft.settings).toMatchObject({ pii_removal: true, recording_enabled: false });
    await req('PATCH', '/workspace', { recording_default: true });
  });
});
