import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import WebSocket, { WebSocketServer } from 'ws';
import { portalUrl } from '../../common/env';
import { RetellGateway } from '../retell';
import { RecordingSigner, type RecordingClaims } from './recording';

/**
 * The path the browser SDK opens when its `baseURL` is `${API}/test-calls`: it appends
 * `/v2/monitor-call/{call_id}` itself.
 */
export const LIVE_TRANSCRIPT_PATH = /^\/test-calls\/v2\/monitor-call\/([A-Za-z0-9_-]{1,80})$/;

/** Frame types the SDK consumes from a monitor socket; everything else is dropped. */
const FORWARDED = new Set(['transcript_snapshot', 'transcript_updated', 'call_ended']);

/**
 * W5's live transcript (ADR 0003, D9 addendum).
 *
 * v3 web calls run on the platform's `gateway` transport, whose data channel carries
 * status frames only; the transcript streams from the monitor socket, which takes our
 * API key. So the API stands in for that socket: the browser SDK connects to
 * `wss://api…/test-calls/v2/monitor-call/{call_id}` with the `live` token minted by
 * `POST /agents/:id/test/web` as its bearer subprotocol, and this relay opens the real
 * socket through `RetellGateway` and forwards transcript frames one way, down.
 *
 * The token is bound to one call and one workspace and dies with the call's ceiling, so
 * it can open nothing else; one relay per call (a reconnect replaces the old one). The
 * browser never holds a platform key and never learns the platform's host. The relay
 * runs in the API process only — the worker never binds a server — and a relay that
 * fails is a transcript that does not scroll, never a dropped call: the audio does not
 * pass through here.
 */
@Injectable()
export class LiveTranscriptRelay implements OnModuleDestroy {
  private readonly log = new Logger(LiveTranscriptRelay.name);
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: 4 * 1024,
    // The SDK offers ["bearer", token]; answering with a subprotocol is required, or the
    // browser drops a connection that asked for one.
    handleProtocols: (protocols) => (protocols.has('bearer') ? 'bearer' : false),
  });
  private readonly live = new Map<string, { client: WebSocket; upstream: WebSocket; timer: NodeJS.Timeout }>();
  private readonly allowedOrigin = safeOrigin(portalUrl());

  constructor(
    private readonly signer: RecordingSigner,
    private readonly retell: RetellGateway,
  ) {}

  /** Called once from `main.ts` with the HTTP server; the worker never calls it. */
  attach(server: Server): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => this.onUpgrade(req, socket, head));
    this.log.log('live transcript relay listening on /test-calls/v2/monitor-call/:call_id');
  }

  /** Visible for tests: the claims an upgrade would be accepted with, or why not. */
  authorise(req: Pick<IncomingMessage, 'url' | 'headers'>): { claims: RecordingClaims } | { status: 400 | 401 | 403 | 404 } {
    const path = (req.url ?? '').split('?')[0] ?? '';
    const match = LIVE_TRANSCRIPT_PATH.exec(path);
    if (!match) return { status: 404 };
    const origin = req.headers.origin;
    if (origin && this.allowedOrigin && origin !== this.allowedOrigin) return { status: 403 };
    const offered = String(req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (offered[0] !== 'bearer' || !offered[1]) return { status: 401 };
    const claims = this.signer.verify(offered[1], new Date(), 'live');
    if (!claims || claims.callId !== match[1]) return { status: 401 };
    return { claims };
  }

  onModuleDestroy(): void {
    for (const [callId] of this.live) this.close(callId, 1001, 'server shutting down');
    this.wss.close();
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const decision = this.authorise(req);
    if ('status' in decision) {
      socket.end(`HTTP/1.1 ${decision.status} ${STATUS_TEXT[decision.status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (client) => this.relay(client, decision.claims));
  }

  private relay(client: WebSocket, claims: RecordingClaims): void {
    const { callId } = claims;
    this.close(callId, 4000, 'replaced'); // one relay per call

    let upstream: WebSocket;
    try {
      upstream = this.retell.openCallMonitor(callId);
    } catch (error) {
      this.log.warn(`call ${callId}: live transcript unavailable: ${String(error)}`);
      client.close(1011, 'unavailable');
      return;
    }
    const timer = setTimeout(() => this.close(callId, 1000, 'expired', entry), Math.max(0, claims.exp * 1000 - Date.now()));
    const entry = { client, upstream, timer };
    this.live.set(callId, entry);

    upstream.on('message', (data) => {
      const frame = forwardable(data);
      if (frame && client.readyState === WebSocket.OPEN) client.send(frame);
    });
    upstream.on('close', () => this.close(callId, 1000, 'ended', entry));
    upstream.on('error', (error) => {
      this.log.warn(`call ${callId}: monitor socket error: ${error.message}`);
      this.close(callId, 1011, 'unavailable', entry);
    });
    // The browser sends nothing we act on; closing it closes the upstream.
    client.on('close', () => this.close(callId, 1000, 'client closed', entry));
    client.on('error', () => this.close(callId, 1011, 'client error', entry));
  }

  /** Closes the relay for `callId` — only `expected` when given, so a replaced relay's late events cannot close its successor. */
  private close(callId: string, code: number, reason: string, expected?: { client: WebSocket; upstream: WebSocket; timer: NodeJS.Timeout }): void {
    const entry = this.live.get(callId);
    if (!entry || (expected && entry !== expected)) {
      if (expected) for (const ws of [expected.client, expected.upstream]) if (ws.readyState === WebSocket.OPEN) ws.close(code, reason);
      return;
    }
    this.live.delete(callId);
    clearTimeout(entry.timer);
    for (const ws of [entry.client, entry.upstream]) {
      if (ws.readyState === WebSocket.OPEN) ws.close(code, reason);
      else if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
    }
  }
}

/**
 * A monitor frame reduced to what the SDK reads: its type and the transcript lines (or
 * the end reason). Watcher ids and anything else the platform adds stay here.
 */
export function forwardable(data: WebSocket.RawData): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(data));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const frame = parsed as Record<string, unknown>;
  const type = frame.type;
  if (typeof type !== 'string' || !FORWARDED.has(type)) return null;
  if (type === 'call_ended') {
    return JSON.stringify({ type, ...(typeof frame.disconnection_reason === 'string' ? { disconnection_reason: frame.disconnection_reason } : {}) });
  }
  return JSON.stringify({
    type,
    transcripts: lines(frame.transcripts),
    ...(Array.isArray(frame.pre_session_transcripts) ? { pre_session_transcripts: lines(frame.pre_session_transcripts) } : {}),
  });
}

function lines(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((u): u is Record<string, unknown> => Boolean(u) && typeof u === 'object')
    .filter((u) => u.role === 'agent' || u.role === 'user')
    .map((u) => ({ id: u.id, role: u.role, content: typeof u.content === 'string' ? u.content : '', time_sec: typeof u.time_sec === 'number' ? u.time_sec : 0 }));
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

const STATUS_TEXT = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found' } as const;
