'use client';

import { useEffect, useRef, useState } from 'react';
import { RetellClient, type WebCallSession } from 'retell-client-js-sdk';

/**
 * D2 bare browser test call. Not W5 — no design system, no auth, no wallet. It exists to
 * prove `retell-client-js-sdk` connects from this app and to see what the SDK emits so
 * the §12.3 client flow is written against observed events. Talks to the dev-only
 * `POST /dev/retell/web-call` on the API, which is a 404 outside APP_ENV=dev.
 *
 * SDK 3's `RetellClient.createWebCall()` wants to POST `/v3/create-web-call` from the
 * browser with a public key. We never do that: the token is minted by our API, which is
 * where §13.4's authz, balance, rate limit and `metadata.tenant_id` live, and the agent id
 * never has to be a browser secret. So the client gets a `fetch` that answers that one
 * request from our API and refuses everything else — the placeholder key below cannot
 * reach the platform. The deprecated `RetellWebClient` (removed in SDK 4) is not used.
 */

type Line = { at: string; kind: 'event' | 'transcript' | 'error'; text: string };

const CREATE_WEB_CALL = '/v3/create-web-call';

/** A `fetch` for `RetellClient` that swaps the platform's create-web-call for our mint. */
function mintThroughApi(apiBase: string): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!new URL(url).pathname.endsWith(CREATE_WEB_CALL)) {
      // stop-call on a cancelled start, listen/monitor: nothing on this page needs them,
      // and forwarding would send the placeholder key to the platform.
      throw new Error(`test-call: ${new URL(url).pathname} is not proxied`);
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return fetch(`${apiBase}/dev/retell/web-call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: body.agent_id,
        agent_version: body.agent_version,
        ...(body.max_call_duration_ms !== undefined ? { max_call_duration_ms: body.max_call_duration_ms } : {}),
      }),
    });
  };
}

export default function DevTestCallPage() {
  // `?auto=1&agent=agent_…&version=0&max_ms=60000` starts the call on load — used by the
  // headless-Chrome run on D2 (fake microphone) to prove the SDK path without a person.
  const params = typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search);
  const [apiBase, setApiBase] = useState(params.get('api') ?? 'http://localhost:4000');
  const [agentId, setAgentId] = useState(params.get('agent') ?? '');
  const [agentVersion, setAgentVersion] = useState(params.get('version') ?? '0');
  const maxMs = params.get('max_ms');
  const [status, setStatus] = useState<'idle' | 'connecting' | 'in_call' | 'ended'>('idle');
  const [callId, setCallId] = useState<string | null>(null);
  const [agentTalking, setAgentTalking] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const session = useRef<WebCallSession | null>(null);
  // Two latches, both refs so they survive React's StrictMode double-mount (the effect
  // runs, is cleaned up, and runs again on the *same* instance, so state would be reset
  // but refs are not). Without them `?auto=1` mints two web calls — two calls on the
  // bill — and the transport is joined twice.
  const autoStarted = useRef(false);
  const starting = useRef(false);

  const log = (kind: Line['kind'], text: string) => {
    console.info(`[test-call] ${kind} ${text}`);
    setLines((prev) => [...prev, { at: new Date().toISOString().slice(11, 23), kind, text }]);
  };

  useEffect(() => {
    if (params.get('auto') === '1' && params.get('agent') && !autoStarted.current) {
      autoStarted.current = true;
      void start();
    }
    return () => session.current?.disconnect();
  }, []);

  async function start() {
    // `status` is state and is stale inside the mount effect's closure, so the guard on
    // the button is not enough — the ref is what actually makes this single-flight.
    if (starting.current) return;
    starting.current = true;
    setLines([]);
    setCallId(null);
    setStatus('connecting');
    const client = new RetellClient({ key: 'minted-by-our-api', fetch: mintThroughApi(apiBase) });
    const s = client.createWebCall({
      agent_id: agentId,
      agent_version: Number(agentVersion),
      ...(maxMs ? { extra: { max_call_duration_ms: Number(maxMs) } } : {}),
      hooks: {
        // connecting → live → ended. `live` is the old `call_started`.
        onStatus: (next) => {
          log('event', `status ${next}`);
          if (next === 'live') {
            setCallId(s.callId ?? null);
            setStatus('in_call');
          }
          if (next === 'ended') {
            setStatus('ended');
            setAgentTalking(false);
          }
        },
        onAgentStartTalking: () => setAgentTalking(true),
        onAgentStopTalking: () => setAgentTalking(false),
        // The data channel's `update` still carries the transcript; `transcript: true`
        // (the monitor socket) would need a key with Call.Write in the browser.
        onUpdate: (update) => {
          const last = update.transcript?.at(-1);
          if (last) log('transcript', `${last.role}: ${last.content}`);
        },
        onMetadata: (m) => log('event', `metadata ${JSON.stringify(m.metadata)}`),
        onEnd: (e) => log('event', `ended${e.disconnection_reason ? ` (${e.disconnection_reason})` : ''}`),
        onError: (e) => log('error', e.message),
      },
    });
    session.current = s;
    try {
      await s.ready;
      log('event', `joined ${s.callId}`);
    } catch {
      // onError has logged it; `ready` also rejects on an ordinary hang-up before joining.
    } finally {
      starting.current = false;
    }
  }

  return (
    <main style={{ fontFamily: 'system-ui', maxWidth: 720, margin: '2rem auto', padding: '0 1rem' }}>
      <h1>Dev · browser test call</h1>
      <p style={{ color: '#666' }}>
        Mints a token from the API and connects with <code>retell-client-js-sdk</code>. Allow the microphone.
      </p>
      <label style={row}>
        API base <input style={input} value={apiBase} onChange={(e) => setApiBase(e.target.value)} />
      </label>
      <label style={row}>
        Agent id <input style={input} value={agentId} onChange={(e) => setAgentId(e.target.value)} placeholder="agent_…" />
      </label>
      <label style={row}>
        Version <input style={input} value={agentVersion} onChange={(e) => setAgentVersion(e.target.value)} />
      </label>
      <div style={{ display: 'flex', gap: 8, margin: '1rem 0' }}>
        <button onClick={start} disabled={!agentId || status === 'connecting' || status === 'in_call'}>
          Start call
        </button>
        <button onClick={() => void session.current?.end()} disabled={status !== 'in_call'}>
          Hang up
        </button>
        <span style={{ alignSelf: 'center' }}>
          {status}
          {callId ? ` · ${callId}` : ''}
          {agentTalking ? ' · agent talking' : ''}
        </span>
      </div>
      <pre style={{ background: '#111', color: '#eee', padding: 12, minHeight: 240, fontSize: 12, overflowX: 'auto' }}>
        {lines.map((l) => `${l.at} ${l.kind.padEnd(10)} ${l.text}`).join('\n') || 'events and transcript appear here'}
      </pre>
    </main>
  );
}

const row: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', margin: '0.5rem 0' };
const input: React.CSSProperties = { flex: 1, padding: 6, fontFamily: 'monospace' };
