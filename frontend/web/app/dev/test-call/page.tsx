'use client';

import { useEffect, useRef, useState } from 'react';
import { RetellWebClient } from 'retell-client-js-sdk';

/**
 * D2 bare browser test call. Not W5 — no design system, no auth, no wallet. It exists to
 * prove `retell-client-js-sdk` connects from this app and to see what the SDK emits so
 * the §12.3 client flow is written against observed events. Talks to the dev-only
 * `POST /dev/retell/web-call` on the API, which is a 404 outside APP_ENV=dev.
 */

type Line = { at: string; kind: 'event' | 'transcript' | 'error'; text: string };

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
  const client = useRef<RetellWebClient | null>(null);
  // Two latches, both refs so they survive React's StrictMode double-mount (the effect
  // runs, is cleaned up, and runs again on the *same* instance, so state would be reset
  // but refs are not). Without them `?auto=1` mints two web calls — two Retell calls on
  // the bill — and `startCall` is issued twice.
  const autoStarted = useRef(false);
  const starting = useRef(false);

  const log = (kind: Line['kind'], text: string) => {
    console.info(`[test-call] ${kind} ${text}`);
    setLines((prev) => [...prev, { at: new Date().toISOString().slice(11, 23), kind, text }]);
  };

  useEffect(() => {
    const c = new RetellWebClient();
    client.current = c;
    c.on('call_started', () => {
      setStatus('in_call');
      log('event', 'call_started');
    });
    c.on('call_ready', () => log('event', 'call_ready'));
    c.on('call_ended', () => {
      setStatus('ended');
      setAgentTalking(false);
      log('event', 'call_ended');
    });
    c.on('agent_start_talking', () => setAgentTalking(true));
    c.on('agent_stop_talking', () => setAgentTalking(false));
    c.on('update', (update: { transcript?: Array<{ role: string; content: string }> }) => {
      const last = update.transcript?.at(-1);
      if (last) log('transcript', `${last.role}: ${last.content}`);
    });
    c.on('metadata', (m: unknown) => log('event', `metadata ${JSON.stringify(m)}`));
    c.on('error', (e: unknown) => {
      log('error', String(e instanceof Error ? e.message : JSON.stringify(e)));
      setStatus('ended');
    });
    if (params.get('auto') === '1' && params.get('agent') && !autoStarted.current) {
      autoStarted.current = true;
      void start();
    }
    return () => c.stopCall();
  }, []);

  async function start() {
    // `status` is state and is stale inside the mount effect's closure, so the guard on
    // the button is not enough — the ref is what actually makes this single-flight.
    if (starting.current) return;
    starting.current = true;
    setLines([]);
    setStatus('connecting');
    try {
      const res = await fetch(`${apiBase}/dev/retell/web-call`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agent_id: agentId,
          agent_version: Number(agentVersion),
          ...(maxMs ? { max_call_duration_ms: Number(maxMs) } : {}),
        }),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const { access_token, call_id, transport, ice_servers } = (await res.json()) as {
        access_token: string;
        call_id: string;
        transport?: 'gateway' | 'livekit';
        ice_servers?: RTCIceServer[];
      };
      setCallId(call_id);
      log('event', `token minted for ${call_id} (transport ${transport ?? 'default'})`);
      // §12.3: the API's create-web-call response decides the transport; the SDK must be
      // told, or a `gateway` token is sent down the LiveKit path and rejected.
      await client.current!.startCall({ accessToken: access_token, callId: call_id, transport, iceServers: ice_servers });
    } catch (error) {
      log('error', error instanceof Error ? error.message : String(error));
      setStatus('idle');
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
        <button onClick={() => client.current?.stopCall()} disabled={status !== 'in_call'}>
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
