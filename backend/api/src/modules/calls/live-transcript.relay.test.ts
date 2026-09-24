import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import type { RetellGateway } from '../retell';
import { LiveTranscriptRelay, forwardable } from './live-transcript.relay';
import { RecordingSigner } from './recording';

const SECRET = 'x'.repeat(40);
const WORKSPACE = '5b0c3f3e-0000-4000-8000-000000000001';

/*
 * The W5 live-transcript relay: who may open it, what it forwards, and that it tears
 * both sockets down. A real HTTP server and a real stand-in for the platform's monitor
 * socket, so the handshake (subprotocol echo included) is what a browser would meet.
 */

let upstreamServer: WebSocketServer;
let upstreamUrl: string;
let upstreamSockets: WebSocket[];
let server: Server;
let base: string;
let signer: RecordingSigner;
let opened: string[];

beforeEach(async () => {
  upstreamSockets = [];
  opened = [];
  upstreamServer = new WebSocketServer({ port: 0, handleProtocols: () => 'bearer' });
  await new Promise<void>((resolve) => upstreamServer.once('listening', () => resolve()));
  upstreamUrl = `ws://127.0.0.1:${(upstreamServer.address() as AddressInfo).port}`;
  upstreamServer.on('connection', (ws) => upstreamSockets.push(ws));

  signer = new RecordingSigner({ RECORDING_SIGNING_SECRET: SECRET });
  const gateway = {
    openCallMonitor: (callId: string) => {
      opened.push(callId);
      return new WebSocket(`${upstreamUrl}/v2/monitor-call/${callId}`, ['bearer', 'platform-key']);
    },
  } as unknown as RetellGateway;
  const relay = new LiveTranscriptRelay(signer, gateway);
  server = createServer((_req, res) => res.end('ok'));
  relay.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
});

function liveToken(callId: string, purpose: 'live' | 'recording' = 'live', ttlS = 600) {
  return signer.sign({ callId, workspaceId: WORKSPACE }, new Date(), ttlS, purpose).token;
}

function connect(path: string, protocols: string[], origin?: string): Promise<{ ws: WebSocket; status: number | null }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${base}${path}`, protocols, origin ? { origin } : {});
    ws.once('open', () => resolve({ ws, status: 101 }));
    ws.once('unexpected-response', (_req, res) => resolve({ ws, status: res.statusCode ?? null }));
    ws.once('error', () => resolve({ ws, status: null }));
  });
}

const until = async (check: () => boolean, ms = 2_000) => {
  const t0 = Date.now();
  while (!check()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('LiveTranscriptRelay', () => {
  it('relays transcript frames for the call the token was minted for, with the bearer subprotocol echoed', async () => {
    const { ws, status } = await connect('/test-calls/v2/monitor-call/call_abc123', ['bearer', liveToken('call_abc123')]);
    expect(status).toBe(101);
    expect(ws.protocol).toBe('bearer');
    await until(() => upstreamSockets.length === 1);
    expect(opened).toEqual(['call_abc123']);

    const received: unknown[] = [];
    ws.on('message', (m) => received.push(JSON.parse(String(m))));
    const up = upstreamSockets[0]!;
    up.send(JSON.stringify({ type: 'transcript_snapshot', target_watcher_id: 'watcher_x', transcripts: [{ id: 'agent_0', role: 'agent', content: 'Hi, thanks for', time_sec: 0.2, metadata: { response_id: 0 } }] }));
    up.send(JSON.stringify({ type: 'something_internal', secret: 'nope' }));
    up.send(JSON.stringify({ type: 'transcript_updated', transcripts: [{ id: 'agent_0', role: 'agent', content: 'Hi, thanks for calling.', time_sec: 0.2 }, { id: 't1', role: 'tool_call_invocation', name: 'x' }] }));
    await until(() => received.length === 2);
    expect(received).toEqual([
      { type: 'transcript_snapshot', transcripts: [{ id: 'agent_0', role: 'agent', content: 'Hi, thanks for', time_sec: 0.2 }] },
      { type: 'transcript_updated', transcripts: [{ id: 'agent_0', role: 'agent', content: 'Hi, thanks for calling.', time_sec: 0.2 }] },
    ]);

    // The platform ending the stream closes the browser's socket.
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
    up.close();
    expect(await closed).toBe(1000);
  });

  it('refuses a missing, foreign, expired or recording token, a wrong path and a foreign origin — and opens nothing upstream', async () => {
    expect((await connect('/test-calls/v2/monitor-call/call_abc', ['bearer'])).status).toBe(401);
    expect((await connect('/test-calls/v2/monitor-call/call_abc', ['bearer', liveToken('call_other')])).status).toBe(401);
    expect((await connect('/test-calls/v2/monitor-call/call_abc', ['bearer', liveToken('call_abc', 'recording')])).status).toBe(401);
    expect((await connect('/test-calls/v2/monitor-call/call_abc', ['bearer', liveToken('call_abc', 'live', -5)])).status).toBe(401);
    expect((await connect('/test-calls/v2/monitor-call/call_abc', ['bearer', `${liveToken('call_abc')}x`])).status).toBe(401);
    expect((await connect('/v2/monitor-call/call_abc', ['bearer', liveToken('call_abc')])).status).toBe(404);
    expect((await connect('/test-calls/v2/monitor-call/call_abc', ['bearer', liveToken('call_abc')], 'https://evil.example')).status).toBe(403);
    expect(opened).toEqual([]);
  });

  it('closes the upstream when the browser leaves, and a second connection for the call replaces the first', async () => {
    const first = await connect('/test-calls/v2/monitor-call/call_r', ['bearer', liveToken('call_r')]);
    await until(() => upstreamSockets.length === 1);
    const firstUpClosed = new Promise<void>((resolve) => upstreamSockets[0]!.once('close', () => resolve()));
    const firstClosed = new Promise<number>((resolve) => first.ws.once('close', (code) => resolve(code)));

    const second = await connect('/test-calls/v2/monitor-call/call_r', ['bearer', liveToken('call_r')]);
    expect(second.status).toBe(101);
    expect(await firstClosed).toBe(4000);
    await firstUpClosed;
    await until(() => upstreamSockets.length === 2);

    // The replaced relay's late close must not take the new one down.
    await new Promise((r) => setTimeout(r, 50));
    expect(second.ws.readyState).toBe(WebSocket.OPEN);

    const secondUpClosed = new Promise<void>((resolve) => upstreamSockets[1]!.once('close', () => resolve()));
    second.ws.close();
    await secondUpClosed;
  });

  it('a recording link and a live token are not interchangeable', () => {
    const live = liveToken('call_z');
    const recording = liveToken('call_z', 'recording');
    expect(signer.verify(live)).toBeNull();
    expect(signer.verify(recording, new Date(), 'live')).toBeNull();
    expect(signer.verify(recording)?.callId).toBe('call_z');
    expect(signer.verify(live, new Date(), 'live')?.callId).toBe('call_z');
  });
});

describe('forwardable', () => {
  it('keeps the end reason of call_ended and drops non-JSON', () => {
    expect(forwardable(Buffer.from(JSON.stringify({ type: 'call_ended', disconnection_reason: 'user_hangup', call: { secret: 1 } })))).toBe('{"type":"call_ended","disconnection_reason":"user_hangup"}');
    expect(forwardable(Buffer.from('not json'))).toBeNull();
  });
});
