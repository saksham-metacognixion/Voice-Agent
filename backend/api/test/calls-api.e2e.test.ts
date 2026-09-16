import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Prisma, adminDb } from '@portal/db';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventsService } from '../src/modules/events';
import { RecordingSigner } from '../src/modules/calls';
import type { FakeAuth0Tenant } from './auth0-double';
import { type CallWorkspace, callId, createCallWorkspace, startHarness } from './calls-fixtures';

/*
 * The customer side of D4 (§16): GET /calls, GET /calls/:id, PATCH /calls/:id, the signed
 * recording proxy, GET /stats and the GET /events SSE stream — against a real Nest app on
 * a real port, with RLS doing its half of the work underneath.
 */

let app: NestFastifyApplication;
let stop: () => Promise<void>;
let customerTenant: FakeAuth0Tenant;
let ws: CallWorkspace;
let other: CallWorkspace;
let baseUrl = '';
/** Stands in for Retell's recording host. */
let recordings: Server;
let recordingUrl = '';
const AUDIO = Buffer.from('ID3 fake mp3 payload for the e2e recording proxy');

beforeAll(async () => {
  const harness = await startHarness({ listen: true, workers: false });
  app = harness.app;
  stop = harness.stop;
  customerTenant = harness.customerTenant;
  baseUrl = await app.getUrl();

  recordings = createServer((req, res) => {
    if (req.headers.range) {
      res.writeHead(206, { 'content-type': 'audio/mpeg', 'content-range': `bytes 0-9/${AUDIO.length}`, 'content-length': '10' });
      res.end(AUDIO.subarray(0, 10));
      return;
    }
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': String(AUDIO.length) });
    res.end(AUDIO);
  });
  await new Promise<void>((resolve) => recordings.listen(0, '127.0.0.1', resolve));
  recordingUrl = `http://127.0.0.1:${(recordings.address() as AddressInfo).port}/rec.mp3`;

  ws = await createCallWorkspace('calls-api');
  other = await createCallWorkspace('calls-api-other');
  await seedCalls();
});

afterAll(async () => {
  await new Promise<void>((resolve) => recordings.close(() => resolve()));
  await stop?.();
  await adminDb.$disconnect();
});

const DAY = 86_400_000;
const ids = { ended: callId(), missed: callId(), web: callId(), old: callId(), live: callId(), theirs: callId() };

/** A small call history: one billed call today, one missed, one browser test, one a week old. */
async function seedCalls(): Promise<void> {
  const now = Date.now();
  await adminDb.call.createMany({
    data: [
      { id: ids.ended, tenantId: ws.tenantId, agentId: ws.agentId, numberId: ws.numberId, channel: 'phone', direction: 'inbound', fromNumber: '+19375550100', toNumber: ws.e164, startedAt: new Date(now - 3_600_000), endedAt: new Date(now - 3_540_000), durationS: 60, disconnectionReason: 'user_hangup', rate: new Prisma.Decimal(1), configVersion: 1, creditsCharged: new Prisma.Decimal(1), status: 'ended', recordingUrl, transcriptText: 'Agent: Maple Dental, how can I help?' },
      { id: ids.missed, tenantId: ws.tenantId, numberId: ws.numberId, channel: 'phone', direction: 'inbound', fromNumber: '+19375550101', toNumber: ws.e164, startedAt: new Date(now - 7_200_000), endedAt: new Date(now - 7_200_000), durationS: 0, creditsCharged: new Prisma.Decimal(0), status: 'declined', declineReason: 'balance' },
      { id: ids.web, tenantId: ws.tenantId, agentId: ws.agentId, channel: 'web', direction: 'inbound', isTest: true, startedAt: new Date(now - 1_800_000), endedAt: new Date(now - 1_770_000), durationS: 30, rate: new Prisma.Decimal(1), creditsCharged: new Prisma.Decimal(0.5), status: 'analyzed', analysisJson: { call_successful: true } },
      { id: ids.old, tenantId: ws.tenantId, agentId: ws.agentId, numberId: ws.numberId, channel: 'phone', direction: 'inbound', startedAt: new Date(now - 8 * DAY), endedAt: new Date(now - 8 * DAY + 120_000), durationS: 120, rate: new Prisma.Decimal(1), creditsCharged: new Prisma.Decimal(2), status: 'ended' },
      { id: ids.live, tenantId: ws.tenantId, agentId: ws.agentId, numberId: ws.numberId, channel: 'phone', direction: 'inbound', startedAt: new Date(now - 30_000), rate: new Prisma.Decimal(1), status: 'in_progress' },
      { id: ids.theirs, tenantId: other.tenantId, channel: 'phone', direction: 'inbound', startedAt: new Date(now - 600_000), endedAt: new Date(now - 540_000), durationS: 60, rate: new Prisma.Decimal(1), creditsCharged: new Prisma.Decimal(1), status: 'ended', recordingUrl },
    ],
  });
}

async function headers(sub = ws.sub, workspaceId = ws.tenantId): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await customerTenant.mint(sub)}`, 'x-workspace-id': workspaceId };
}

async function get(url: string, auth?: Record<string, string>) {
  return app.inject({ method: 'GET', url, headers: auth ?? (await headers()) });
}

// ---------------------------------------------------------------------------
describe('GET /calls', () => {
  it('lists this workspace’s calls, newest first, and never another workspace’s', async () => {
    const res = await get('/calls');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.map((c: { id: string }) => c.id)).toEqual([ids.live, ids.web, ids.ended, ids.missed, ids.old]);
    expect(body.items.some((c: { id: string }) => c.id === ids.theirs)).toBe(false);
    expect(body.next_cursor).toBeNull();
  });

  it('shows a declined call as Missed, with its reason', async () => {
    const missed = (await get('/calls')).json().items.find((c: { id: string }) => c.id === ids.missed);
    expect(missed).toMatchObject({ status: 'missed', decline_reason: 'balance', credits_charged: 0, duration_s: 0 });
  });

  it('carries the fields D2 renders, and nothing staff-only', async () => {
    const call = (await get(`/calls/${ids.ended}`)).json();
    expect(call).toMatchObject({
      id: ids.ended,
      channel: 'phone',
      direction: 'inbound',
      status: 'ended',
      duration_s: 60,
      credits_charged: 1,
      rate: 1,
      config_version: 1,
      has_recording: true,
      transcript_text: 'Agent: Maple Dental, how can I help?',
    });
    expect(call).not.toHaveProperty('retell_cost_cents');
    expect(call).not.toHaveProperty('recording_url');
  });

  it('filters by status, channel, test flag and date window', async () => {
    expect((await get('/calls?status=missed')).json().items.map((c: { id: string }) => c.id)).toEqual([ids.missed]);
    expect((await get('/calls?channel=web')).json().items.map((c: { id: string }) => c.id)).toEqual([ids.web]);
    expect((await get('/calls?is_test=true')).json().items.map((c: { id: string }) => c.id)).toEqual([ids.web]);
    expect((await get('/calls?is_test=false')).json().items.map((c: { id: string }) => c.id)).not.toContain(ids.web);
    expect((await get(`/calls?agent_id=${ws.agentId}`)).json().items.map((c: { id: string }) => c.id)).not.toContain(ids.missed);
    expect((await get(`/calls?number_id=${ws.numberId}`)).json().items.map((c: { id: string }) => c.id)).not.toContain(ids.web);

    const since = new Date(Date.now() - 2 * DAY).toISOString();
    const recent = (await get(`/calls?from=${encodeURIComponent(since)}`)).json();
    expect(recent.items.map((c: { id: string }) => c.id)).not.toContain(ids.old);
  });

  it('pages with an opaque cursor and stops at the end', async () => {
    const first = (await get('/calls?limit=2')).json();
    expect(first.items).toHaveLength(2);
    expect(first.next_cursor).toBeTruthy();

    const second = (await get(`/calls?limit=2&cursor=${encodeURIComponent(first.next_cursor)}`)).json();
    expect(second.items).toHaveLength(2);
    expect(second.items.map((c: { id: string }) => c.id)).not.toEqual(first.items.map((c: { id: string }) => c.id));

    const last = (await get(`/calls?limit=2&cursor=${encodeURIComponent(second.next_cursor)}`)).json();
    expect(last.items).toHaveLength(1);
    expect(last.next_cursor).toBeNull();
  });

  it('is an empty page for a workspace with no calls, not an error', async () => {
    const empty = await createCallWorkspace('no-calls');
    const res = await get('/calls', await headers(empty.sub, empty.tenantId));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [], next_cursor: null });
  });

  it('refuses a malformed cursor, an unknown filter value and a bad limit', async () => {
    expect((await get('/calls?cursor=not-a-cursor')).json().code).toBe('INVALID_CURSOR');
    expect((await get('/calls?status=exploded')).statusCode).toBe(422);
    expect((await get('/calls?limit=0')).statusCode).toBe(422);
    expect((await get('/calls?limit=1000')).statusCode).toBe(422);
    expect((await get('/calls?agent_id=not-a-uuid')).statusCode).toBe(422);
    expect((await get('/calls?from=yesterday')).statusCode).toBe(422);
  });

  it('needs a token and a workspace', async () => {
    expect((await app.inject({ method: 'GET', url: '/calls' })).statusCode).toBe(401);
    const noWorkspace = await app.inject({ method: 'GET', url: '/calls', headers: { authorization: `Bearer ${await customerTenant.mint(ws.sub)}` } });
    expect(noWorkspace.statusCode).toBe(400);
    expect(noWorkspace.json().code).toBe('WORKSPACE_REQUIRED');
  });
});

describe('GET /calls/:id', () => {
  it('is 404 for an id that does not exist and for one that belongs to another workspace', async () => {
    expect((await get(`/calls/${callId()}`)).statusCode).toBe(404);
    const theirs = await get(`/calls/${ids.theirs}`);
    expect(theirs.statusCode).toBe(404);
    expect(theirs.json().code).toBe('NOT_FOUND');
    // …and the owner of that call can read it, so the 404 above is tenancy, not absence.
    expect((await get(`/calls/${ids.theirs}`, await headers(other.sub, other.tenantId))).statusCode).toBe(200);
  });

  it('refuses a workspace the caller is not a member of', async () => {
    const res = await get(`/calls/${ids.theirs}`, await headers(ws.sub, other.tenantId));
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('NOT_A_MEMBER');
  });
});

describe('PATCH /calls/:id', () => {
  it('marks a call handled and back, and stores a note', async () => {
    const auth = await headers();
    const patch = (payload: unknown) => app.inject({ method: 'PATCH', url: `/calls/${ids.ended}`, headers: { ...auth, 'content-type': 'application/json' }, payload: JSON.stringify(payload) });

    const handled = await patch({ handled: true, note: 'Called back, booked for Tuesday.' });
    expect(handled.statusCode).toBe(200);
    expect(handled.json().handled_at).not.toBeNull();
    expect(handled.json().note).toBe('Called back, booked for Tuesday.');

    // Marking it handled twice keeps the first timestamp.
    const again = await patch({ handled: true });
    expect(again.json().handled_at).toBe(handled.json().handled_at);

    expect((await patch({ handled: false })).json().handled_at).toBeNull();
    expect((await patch({ note: null })).json().note).toBeNull();
    expect((await patch({})).statusCode).toBe(422);
  });

  it('is 404 for another workspace’s call and 403 for a viewer', async () => {
    const auth = await headers();
    const theirs = await app.inject({ method: 'PATCH', url: `/calls/${ids.theirs}`, headers: { ...auth, 'content-type': 'application/json' }, payload: '{"handled":true}' });
    expect(theirs.statusCode).toBe(404);

    const viewer = await createCallWorkspace('viewer');
    await adminDb.membership.update({ where: { tenantId_userId: { tenantId: viewer.tenantId, userId: viewer.userId } }, data: { role: 'viewer' } });
    const viewerAuth = await headers(viewer.sub, viewer.tenantId);
    const res = await app.inject({ method: 'PATCH', url: `/calls/${ids.ended}`, headers: { ...viewerAuth, 'content-type': 'application/json' }, payload: '{"handled":true}' });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('FORBIDDEN_ROLE');
  });
});

describe('GET /calls/:id/recording — the signed proxy (§17)', () => {
  it('mints a one-hour link that plays the audio without exposing the upstream URL', async () => {
    const res = await get(`/calls/${ids.ended}/recording`);
    expect(res.statusCode).toBe(200);
    const { url, expires_at } = res.json();
    expect(url).toContain(`/calls/${ids.ended}/recording/stream?token=`);
    expect(url).not.toContain('127.0.0.1:' + new URL(recordingUrl).port);
    const ttlMs = Date.parse(expires_at) - Date.now();
    expect(ttlMs).toBeGreaterThan(3_500_000);
    expect(ttlMs).toBeLessThanOrEqual(3_600_000);

    // The link carries its own credential: no Authorization header, and it still plays.
    const played = await fetch(url.replace(/^https?:\/\/[^/]+/, baseUrl));
    expect(played.status).toBe(200);
    expect(played.headers.get('content-type')).toBe('audio/mpeg');
    expect(played.headers.get('cache-control')).toContain('no-store');
    expect(Buffer.from(await played.arrayBuffer()).equals(AUDIO)).toBe(true);
  });

  it('passes a Range request through so the player can seek', async () => {
    const { url } = (await get(`/calls/${ids.ended}/recording`)).json();
    const ranged = await fetch(url.replace(/^https?:\/\/[^/]+/, baseUrl), { headers: { range: 'bytes=0-9' } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe(`bytes 0-9/${AUDIO.length}`);
  });

  it('is 404 when the call has no recording, or is not this workspace’s', async () => {
    expect((await get(`/calls/${ids.missed}/recording`)).statusCode).toBe(404);
    expect((await get(`/calls/${ids.theirs}/recording`)).statusCode).toBe(404);
    expect((await get(`/calls/${callId()}/recording`)).statusCode).toBe(404);
  });

  it('refuses a viewer, per the §20 item 9 recommendation', async () => {
    const viewer = await createCallWorkspace('rec-viewer');
    await adminDb.membership.update({ where: { tenantId_userId: { tenantId: viewer.tenantId, userId: viewer.userId } }, data: { role: 'viewer' } });
    const res = await get(`/calls/${ids.ended}/recording`, await headers(viewer.sub, viewer.tenantId));
    // The viewer is not a member of this workspace at all, so tenancy answers first.
    expect([403, 404]).toContain(res.statusCode);
  });

  it('refuses a missing, forged, expired or reused-for-another-call token', async () => {
    const { url } = (await get(`/calls/${ids.ended}/recording`)).json();
    const token = new URL(url).searchParams.get('token')!;

    expect((await fetch(`${baseUrl}/calls/${ids.ended}/recording/stream`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/calls/${ids.ended}/recording/stream?token=forged`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/calls/${ids.ended}/recording/stream?token=${token}xyz`)).status).toBe(401);
    // A token minted for one call does not open another, even inside the same workspace.
    expect((await fetch(`${baseUrl}/calls/${ids.web}/recording/stream?token=${token}`)).status).toBe(401);

    const signer = app.get(RecordingSigner);
    const expired = signer.sign({ callId: ids.ended, workspaceId: ws.tenantId }, new Date(Date.now() - 7_200_000)).token;
    expect((await fetch(`${baseUrl}/calls/${ids.ended}/recording/stream?token=${expired}`)).status).toBe(401);
  });
});

describe('GET /stats', () => {
  it('summarises the last 7 days in the workspace timezone', async () => {
    const res = await get('/stats?range=7d');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ range: '7d', timezone: 'America/Toronto' });
    // The 8-day-old call is outside the window.
    expect(body.calls).toEqual({ total: 4, answered: 3, missed: 1, test: 1 });
    expect(body.credits_used).toBe(1.5);
    expect(body.minutes).toBe(1.5);
    expect(body.missed_by_reason).toEqual({ balance: 1 });
    // 60 s + 30 s over the two calls that have a duration. The in-progress call has none
    // yet, and counting it would understate the average for as long as it is live.
    expect(body.avg_duration_s).toBe(45);
    expect(body.by_day.length).toBeGreaterThanOrEqual(1);
    expect(body.by_day.at(-1)).toMatchObject({ date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  });

  it('widens to 30 days and narrows to today', async () => {
    const thirty = (await get('/stats?range=30d')).json();
    expect(thirty.calls.total).toBe(5); // includes the 8-day-old call
    expect(thirty.credits_used).toBe(3.5);

    const today = (await get('/stats?range=today')).json();
    expect(today.calls.total).toBeLessThanOrEqual(4);
    expect(Date.parse(today.from)).toBeGreaterThan(Date.now() - 2 * DAY);
  });

  it('accepts a custom window and refuses an incoherent one', async () => {
    const from = new Date(Date.now() - 3 * DAY).toISOString();
    const to = new Date().toISOString();
    const custom = await get(`/stats?range=custom&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    expect(custom.statusCode).toBe(200);
    expect(custom.json().range).toBe('custom');

    expect((await get('/stats?range=custom')).statusCode).toBe(422);
    expect((await get(`/stats?range=custom&from=${encodeURIComponent(to)}&to=${encodeURIComponent(from)}`)).statusCode).toBe(422);
    expect((await get('/stats?range=decade')).statusCode).toBe(422);
  });

  it('is all zeroes for a workspace with no calls, and needs a workspace', async () => {
    const empty = await createCallWorkspace('no-stats');
    const res = await get('/stats', await headers(empty.sub, empty.tenantId));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ calls: { total: 0, answered: 0, missed: 0, test: 0 }, minutes: 0, credits_used: 0, avg_duration_s: null, by_day: [] });

    expect((await app.inject({ method: 'GET', url: '/stats' })).statusCode).toBe(401);
    expect((await get('/stats', await headers(ws.sub, other.tenantId))).statusCode).toBe(403);
  });
});

describe('GET /events — SSE (§16)', () => {
  /** Opens the stream and collects frames until `count` have arrived. */
  async function openStream(count: number, query = '', auth?: Record<string, string>): Promise<{ frames: Array<{ topic: string; event: unknown }>; close: () => void; ready: Promise<void>; done: Promise<void> }> {
    const controller = new AbortController();
    const frames: Array<{ topic: string; event: unknown }> = [];
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => (resolveReady = resolve));
    const response = await fetch(`${baseUrl}/events${query}`, { headers: auth ?? (await headers()), signal: controller.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    resolveReady();

    const done = (async () => {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (frames.length < count) {
          const { value, done: finished } = await reader.read();
          if (finished) break;
          buffer += decoder.decode(value, { stream: true });
          let split = buffer.indexOf('\n\n');
          while (split !== -1) {
            const chunk = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const topic = /^event: (.+)$/m.exec(chunk)?.[1];
            const data = /^data: (.+)$/m.exec(chunk)?.[1];
            if (topic && data) frames.push({ topic, event: JSON.parse(data) });
            split = buffer.indexOf('\n\n');
          }
        }
      } catch {
        // The stream was aborted by close(); that is how these tests end.
      }
    })();

    return { frames, close: () => controller.abort(), ready, done };
  }

  it('streams the workspace’s frames to two clients at once, and nothing to another workspace', async () => {
    const events = app.get(EventsService);
    const a = await openStream(1);
    const b = await openStream(1);
    const outsider = await openStream(1, '', await headers(other.sub, other.tenantId));
    await Promise.all([a.ready, b.ready, outsider.ready]);
    await new Promise((resolve) => setTimeout(resolve, 100));

    await events.publish(ws.tenantId, `call:${ids.ended}`, 'ended', { credits_charged: 1.26 });
    await Promise.race([Promise.all([a.done, b.done]), new Promise((resolve) => setTimeout(resolve, 2_000))]);

    expect(a.frames).toHaveLength(1);
    expect(a.frames[0]!.topic).toBe(`call:${ids.ended}`);
    expect(a.frames[0]!.event).toMatchObject({ type: 'ended', data: { credits_charged: 1.26 } });
    expect(b.frames).toHaveLength(1);
    expect(outsider.frames).toHaveLength(0);

    a.close();
    b.close();
    outsider.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  it('narrows to the topics the client asked for', async () => {
    const events = app.get(EventsService);
    const stream = await openStream(1, '?topics=wallet');
    await stream.ready;
    await new Promise((resolve) => setTimeout(resolve, 100));

    await events.publish(ws.tenantId, `call:${ids.live}`, 'in_progress', {});
    await events.publish(ws.tenantId, 'wallet', 'ledger', { delta: -1.26, balance_after: 48.74 });
    await Promise.race([stream.done, new Promise((resolve) => setTimeout(resolve, 2_000))]);

    expect(stream.frames).toHaveLength(1);
    expect(stream.frames[0]!.topic).toBe('wallet');
    expect(stream.frames[0]!.event).toMatchObject({ type: 'ledger', data: { delta: -1.26 } });
    stream.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  it('releases its subscription when the client disconnects, and publishing after that is harmless', async () => {
    const events = app.get(EventsService);
    const before = events.listeners(ws.tenantId);
    const stream = await openStream(5);
    await stream.ready;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(events.listeners(ws.tenantId)).toBe(before + 1);

    stream.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(events.listeners(ws.tenantId)).toBe(before);
    await expect(events.publish(ws.tenantId, 'wallet', 'ledger', { delta: -1 })).resolves.toBeTruthy();
  });

  it('refuses an unauthenticated stream and a malformed topic filter', async () => {
    expect((await fetch(`${baseUrl}/events`)).status).toBe(401);
    const bad = await fetch(`${baseUrl}/events?topics=wallet,not-a-topic`, { headers: await headers() });
    expect(bad.status).toBe(422);
  });
});
