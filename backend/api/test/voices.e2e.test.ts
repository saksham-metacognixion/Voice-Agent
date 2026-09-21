import { adminDb } from '@portal/db';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ScheduledJobsService } from '../src/modules/scheduled';
import { PREVIEW_RATE_LIMIT, VoicesService } from '../src/modules/voices';
import type { FakeAuth0Tenant } from './auth0-double';
import { type FakeRetellGateway, type TestWorkspace, createWorkspace, startD5Harness } from './d5-fixtures';

/*
 * W3 voices: the §13.11 daily cache job and the two routes it feeds.
 *
 * The cache is the whole design — "voices cached server-side daily; if the voice API is
 * down, serve cache with a banner" — so most of what matters here is what happens when
 * the provider misbehaves.
 */

let app: NestFastifyApplication;
let stop: () => Promise<void>;
let customerTenant: FakeAuth0Tenant;
let retell: FakeRetellGateway;
let voices: VoicesService;
let scheduled: ScheduledJobsService;
let ws: TestWorkspace;

beforeAll(async () => {
  const harness = await startD5Harness({ workers: false });
  app = harness.app;
  stop = harness.stop;
  customerTenant = harness.customerTenant;
  retell = harness.retell;
  voices = app.get(VoicesService);
  scheduled = app.get(ScheduledJobsService);
  ws = await createWorkspace('voices');
});

afterAll(async () => {
  await stop?.();
  await adminDb.$disconnect();
});

beforeEach(() => retell.reset());

async function headers(workspaceId = ws.workspaceId): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await customerTenant.mint(ws.sub)}`, 'x-workspace-id': workspaceId };
}

function get(url: string, auth?: Record<string, string>) {
  return headers().then((base) => app.inject({ method: 'GET', url, headers: auth ?? base }));
}

async function preview(voiceId: string, body: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: `/voices/${voiceId}/preview`,
    headers: { ...(await headers()), 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
describe('the voice-cache job (§13.11)', () => {
  it('fills the catalogue from the provider', async () => {
    const result = await voices.refreshCache();
    expect(result.skipped).toBe(false);
    expect(result.written).toBeGreaterThanOrEqual(3);

    const adrian = await adminDb.voice.findUniqueOrThrow({ where: { retellVoiceId: '11labs-Adrian' } });
    expect(adrian).toMatchObject({ name: 'Adrian', gender: 'male', tier: 'premium' });
    expect(adrian.previewUrl).toBe('https://example.test/adrian.mp3');
  });

  it('marks the ElevenLabs family premium and everything else standard (§4.3)', async () => {
    await voices.refreshCache();
    expect((await adminDb.voice.findUniqueOrThrow({ where: { retellVoiceId: 'cartesia-Cleo' } })).tier).toBe('standard');
    expect((await adminDb.voice.findUniqueOrThrow({ where: { retellVoiceId: '11labs-Adrian' } })).tier).toBe('premium');
  });

  it('is idempotent — running it twice changes nothing but the timestamp', async () => {
    await voices.refreshCache();
    const before = await adminDb.voice.count();
    await voices.refreshCache();
    expect(await adminDb.voice.count()).toBe(before);
  });

  it('retries a transient provider failure in-process', async () => {
    retell.failNext('listVoices', 2);
    const result = await voices.refreshCache();
    expect(result.skipped).toBe(false);
    expect(retell.countOf('listVoices')).toBe(3);
  });

  it('keeps the existing cache when the provider stays down', async () => {
    await voices.refreshCache();
    const before = await adminDb.voice.count();

    retell.failNext('listVoices', 5);
    await expect(voices.refreshCache(2)).rejects.toThrow(/voice-cache failed/);

    // Nothing was deleted: W3 keeps working behind the stale banner.
    expect(await adminDb.voice.count()).toBe(before);
    expect(await adminDb.voice.findUnique({ where: { retellVoiceId: '11labs-Adrian' } })).not.toBeNull();
  });

  it('refuses to empty the catalogue when the provider returns nothing', async () => {
    await voices.refreshCache();
    const before = await adminDb.voice.count();

    const original = retell.listVoices.bind(retell);
    (retell as unknown as { listVoices: () => Promise<unknown[]> }).listVoices = async () => [];
    try {
      const result = await voices.refreshCache();
      expect(result.skipped).toBe(true);
      expect(await adminDb.voice.count()).toBe(before);
    } finally {
      (retell as unknown as { listVoices: typeof original }).listVoices = original;
    }
  });

  it('is wired into the §13.11 schedule', async () => {
    const result = await scheduled.voiceCache();
    expect(result.skipped).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('GET /voices', () => {
  beforeEach(async () => {
    await voices.refreshCache();
  });

  it('lists the cached catalogue with a freshness stamp', async () => {
    const res = await get('/voices');
    expect(res.statusCode).toBe(200);
    expect(res.json().items.length).toBeGreaterThanOrEqual(3);
    expect(res.json().refreshed_at).toBeTruthy();
    expect(res.json().stale).toBe(false);
  });

  it('filters by gender, tier and multilingual', async () => {
    expect((await get('/voices?gender=male')).json().items.every((v: { gender: string }) => v.gender === 'male')).toBe(true);
    expect((await get('/voices?tier=premium')).json().items.every((v: { tier: string }) => v.tier === 'premium')).toBe(true);

    const multilingual = (await get('/voices?multilingual=true')).json().items;
    expect(multilingual.every((v: { is_multilingual: boolean }) => v.is_multilingual)).toBe(true);
  });

  it('matches a language by prefix in both directions', async () => {
    // `cartesia-Margot` is listed as fr-CA + en-CA.
    const french = (await get('/voices?lang=fr')).json().items.map((v: { id: string }) => v.id);
    expect(french).toContain('cartesia-Margot');

    const canadian = (await get('/voices?lang=en-CA')).json().items.map((v: { id: string }) => v.id);
    expect(canadian).toContain('cartesia-Margot');
  });

  it('says it is stale when the daily job has not run for two days', async () => {
    await adminDb.voice.updateMany({ data: { updatedAt: new Date(Date.now() - 3 * 86_400_000) } });
    const res = await get('/voices');
    expect(res.json().stale).toBe(true);
    expect(res.json().items.length).toBeGreaterThan(0); // still served
    await voices.refreshCache();
  });

  it('needs a workspace', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/voices',
      headers: { authorization: `Bearer ${await customerTenant.mint(ws.sub)}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('WORKSPACE_REQUIRED');
  });

  it('needs a membership in the workspace it is asked for', async () => {
    const other = await createWorkspace('voices-outsider');
    const res = await get('/voices', await headers(other.workspaceId));
    expect(res.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
describe('POST /voices/:id/preview', () => {
  beforeEach(async () => {
    await voices.refreshCache();
  });

  it('returns the provider sample without spending a credit or calling out', async () => {
    const res = await preview('11labs-Adrian', { text: 'Thank you for calling Maple Dental.' });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      voice_id: '11labs-Adrian',
      kind: 'sample',
      audio_url: 'https://example.test/adrian.mp3',
    });

    const ledger = await adminDb.creditLedger.count({ where: { tenantId: ws.workspaceId } });
    expect(ledger).toBe(0);
    expect(retell.calls.filter((c) => c.method !== 'listVoices')).toEqual([]);
  });

  it('404s on a voice the catalogue does not have', async () => {
    expect((await preview('made-up-voice')).statusCode).toBe(404);
  });

  it('404s on an id that is not shaped like a voice id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/voices/..%2F..%2Fetc%2Fpasswd/preview',
      headers: { ...(await headers()), 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(404);
  });

  it('rate-limits at 10 a minute per workspace (W3)', async () => {
    const fresh = await createWorkspace('voices-ratelimit');
    const auth = {
      authorization: `Bearer ${await customerTenant.mint(fresh.sub)}`,
      'x-workspace-id': fresh.workspaceId,
      'content-type': 'application/json',
    };

    const statuses: number[] = [];
    for (let i = 0; i < PREVIEW_RATE_LIMIT + 3; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/voices/11labs-Adrian/preview',
        headers: auth,
        payload: '{}',
      });
      statuses.push(res.statusCode);
    }

    expect(statuses.filter((s) => s === 201).length).toBeLessThanOrEqual(PREVIEW_RATE_LIMIT + 1);
    expect(statuses).toContain(429);
  });

  it('refuses a text longer than the schema allows', async () => {
    expect((await preview('11labs-Adrian', { text: 'x'.repeat(301) })).statusCode).toBe(422);
  });
});
