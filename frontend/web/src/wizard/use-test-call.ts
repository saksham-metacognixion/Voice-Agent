'use client';

import { ApiError, startTestWebCall, useApi } from '@portal/api-client';
import type { TestWebCallResponse } from '@portal/schemas';
import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { RetellClient, type WebCallSession } from 'retell-client-js-sdk';
import { track } from '@/src/analytics/posthog';
import { config } from '@/src/config';
import { TestCallLifecycle } from './test-call-lifecycle';
import { mergeTranscript, type TranscriptLine } from './transcript';

export type TestCallStatus = 'idle' | 'mic' | 'connecting' | 'live' | 'ended' | 'failed';

/** Why a call did not happen or stopped. `api` carries a §16 code the page turns into copy. */
export type TestCallFailure =
  | { kind: 'mic_denied' }
  | { kind: 'mic_missing' }
  | { kind: 'api'; error: ApiError }
  | { kind: 'connection'; message: string };

export interface TestCallState {
  status: TestCallStatus;
  callId: string | null;
  transcript: TranscriptLine[];
  agentTalking: boolean;
  /** Whole seconds since the call went live. */
  elapsedS: number;
  /** From the mint: the rate, the balance at the start, and the ceiling. */
  mint: Pick<TestWebCallResponse, 'rate' | 'balance' | 'max_call_duration_s' | 'version_no'> | null;
  failure: TestCallFailure | null;
  disconnectionReason: string | null;
}

const IDLE: TestCallState = { status: 'idle', callId: null, transcript: [], agentTalking: false, elapsedS: 0, mint: null, failure: null, disconnectionReason: null };

/** The one request the SDK makes that we answer: its create-web-call, minted by our API instead. */
const CREATE_WEB_CALL = '/v3/create-web-call';

/** Our API's relay for the live transcript (LiveTranscriptRelay), which holds the platform key. */
const LIVE_SOCKET_BASE = `${config.apiUrl.replace(/^http/, 'ws')}/test-calls/v2/monitor-call/`;

/**
 * Points the SDK's live-transcript socket at our relay, and nothing else.
 *
 * The SDK derives two things from one `baseURL`: the WebRTC signalling (which must stay
 * on the platform — the audio's session is negotiated there with the minted token) and
 * the monitor socket `${baseURL}/v2/monitor-call/{id}` (which needs a platform key, so it
 * must come to us). So `baseURL` is left alone and the client's control API gets its own
 * `monitorSocket`. That is an SDK internal (`client.api`, retell-client-js-sdk 3.0.1,
 * pinned): if a release renames it, this returns false and the call still works — only
 * the live transcript is missing, and the after-call card still shows the full one.
 */
function routeMonitorToRelay(client: RetellClient, token: () => string): boolean {
  const api = (client as unknown as { api?: { monitorSocket?: unknown } }).api;
  if (!api || typeof api.monitorSocket !== 'function') return false;
  api.monitorSocket = (callId: string) => ({ url: `${LIVE_SOCKET_BASE}${encodeURIComponent(callId)}`, protocols: ['bearer', token()] });
  return true;
}

/**
 * §12.3 test-call client flow, W5 and the D3 Test tab.
 *
 *   mic permission → POST /agents/:id/test/web → SDK joins with the minted token →
 *   the transcript streams through our relay → hang up → `call_ended` bills it server-side
 *
 * `RetellClient` wants to POST create-web-call to the platform with a key. It never does
 * here: it is given a `fetch` that answers that one request from `POST /agents/:id/test/web`
 * (authz, balance, rate limit and the tenant metadata all live there) and refuses every
 * other URL, so the placeholder key cannot reach anything (the D2 dev page proved the
 * pattern). The platform is not named anywhere a customer can see.
 *
 * The live transcript comes from the SDK's monitor socket (`transcript: true`), routed
 * to our API's relay and opened with the call-bound `live_token` from the mint (v3 web
 * calls carry no transcript on the data channel; ADR 0003, D9 addendum).
 *
 * Start is single-flight through a ref, not state — a double click or a StrictMode
 * re-run must not mint two calls, which would be two calls on the customer's bill.
 *
 * Every await is followed by a check that the page still wants the call
 * (`TestCallLifecycle`, QA-017): leaving W5 with the microphone prompt open stops the
 * tracks and mints nothing, leaving during the mint never joins, and leaving once joined
 * hangs up. A call minted but never joined ends on the platform unconnected and is billed
 * zero (`error_user_not_joined`, metering's not-connected list).
 */
export function useTestCall(agentId: string | null, versionNo: number | null) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [state, setState] = React.useState<TestCallState>(IDLE);
  const [lifecycle] = React.useState(() => new TestCallLifecycle<WebCallSession>());
  const liveAt = React.useRef<number | null>(null);

  const patch = React.useCallback(
    (next: Partial<TestCallState> | ((s: TestCallState) => Partial<TestCallState>)) => {
      if (!lifecycle.isMounted()) return;
      setState((s) => ({ ...s, ...(typeof next === 'function' ? next(s) : next) }));
    },
    [lifecycle],
  );

  // Leaving the page hangs up and abandons a start still in flight. A call left running
  // in a detached component would keep spending credits with no button to stop it.
  React.useEffect(() => {
    lifecycle.mount();
    return () => lifecycle.dispose();
  }, [lifecycle]);

  // The timer ticks from "live", not from the click: connecting time is not billed.
  React.useEffect(() => {
    if (state.status !== 'live') return;
    const timer = setInterval(() => {
      if (liveAt.current) patch({ elapsedS: Math.floor((Date.now() - liveAt.current) / 1000) });
    }, 500);
    return () => clearInterval(timer);
  }, [state.status, patch]);

  const settle = React.useCallback(() => {
    // The balance moved server-side (call_ended); the pill and the credit line re-read it.
    void queryClient.invalidateQueries({ queryKey: ['getWallet'] });
  }, [queryClient]);

  const start = React.useCallback(async () => {
    if (!agentId) return;
    const run = lifecycle.begin();
    if (!run) return;
    liveAt.current = null;
    setState({ ...IDLE, status: 'mic' });

    // Ask for the microphone before minting: a refusal then costs nothing and says why.
    // The prompt can outlive the page; an answer that arrives after it stops the tracks
    // and goes no further.
    const mic = await lifecycle.acquireMicrophone(run, () => navigator.mediaDevices.getUserMedia({ audio: true }));
    if (!mic.ok) {
      lifecycle.finish(run);
      if ('inactive' in mic) return;
      const name = mic.error instanceof DOMException ? mic.error.name : '';
      const kind = name === 'NotFoundError' || name === 'OverconstrainedError' ? 'mic_missing' : 'mic_denied';
      patch({ status: 'failed', failure: { kind } });
      track('test_call_failed', { agent_id: agentId, reason: kind });
      return;
    }

    patch({ status: 'connecting' });
    let apiFailure: ApiError | null = null;
    let liveToken = '';
    let held: WebCallSession | null = null;
    const proxiedFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!new URL(url).pathname.endsWith(CREATE_WEB_CALL)) throw new Error('not proxied');
      // The page left between the click and the SDK's request: mint nothing.
      if (!lifecycle.isActive(run)) throw new Error('test call abandoned');
      try {
        const minted = await startTestWebCall(api, { id: agentId }, versionNo ? { version_no: versionNo } : {});
        // ...or during the mint: never join it. Unjoined, the platform ends it unbilled.
        if (!lifecycle.isActive(run)) throw new Error('test call abandoned');
        patch({ mint: { rate: minted.rate, balance: minted.balance, max_call_duration_s: minted.max_call_duration_s, version_no: minted.version_no }, callId: minted.call_id });
        liveToken = minted.live_token;
        const { rate: _r, balance: _b, max_call_duration_s: _m, version_no: _v, live_token: _l, ...forSdk } = minted;
        return new Response(JSON.stringify(forSdk), { status: 200, headers: { 'content-type': 'application/json' } });
      } catch (error) {
        if (error instanceof ApiError) apiFailure = error;
        throw error;
      }
    };

    const client = new RetellClient({ key: 'minted-by-our-api', fetch: proxiedFetch });
    const relayed = routeMonitorToRelay(client, () => liveToken);
    const s = client.createWebCall({
      // Ignored by our proxy — the API resolves the agent and version itself.
      agent_id: agentId,
      // Only with the relay in place: otherwise the SDK would dial the platform with no key.
      transcript: relayed,
      hooks: {
        onStatus: (next) => {
          if (next === 'live') {
            liveAt.current = Date.now();
            patch({ status: 'live', callId: s.callId ?? null, elapsedS: 0 });
            track('test_call_started', { agent_id: agentId, version_no: versionNo });
          }
          if (next === 'ended') {
            if (held) lifecycle.release(held);
            patch((cur) => (cur.status === 'failed' ? { agentTalking: false } : { status: 'ended', agentTalking: false }));
            settle();
          }
        },
        onAgentStartTalking: () => patch({ agentTalking: true }),
        onAgentStopTalking: () => patch({ agentTalking: false }),
        onTranscript: (lines) => patch({ transcript: mergeTranscript([], lines) }),
        onUpdate: (update) => patch((cur) => ({ transcript: mergeTranscript(cur.transcript, update.transcript ?? []) })),
        onEnd: (e) => {
          const elapsed = liveAt.current ? Math.floor((Date.now() - liveAt.current) / 1000) : 0;
          patch({ disconnectionReason: e.disconnection_reason ?? null, elapsedS: elapsed });
          track('test_call_ended', { agent_id: agentId, duration_s: elapsed, reason: e.disconnection_reason ?? null });
        },
        onError: (e) => {
          if (held) lifecycle.release(held);
          const failure: TestCallFailure = apiFailure ? { kind: 'api', error: apiFailure } : { kind: 'connection', message: e.message };
          patch({ status: 'failed', failure, agentTalking: false });
          track('test_call_failed', { agent_id: agentId, reason: apiFailure ? apiFailure.code : 'connection' });
          settle();
        },
      },
    });
    held = s;
    // Unmounted while the SDK was being set up: `attach` hangs it up instead of keeping it.
    if (!lifecycle.attach(run, s)) {
      lifecycle.finish(run);
      return;
    }
    try {
      await s.ready;
    } catch {
      /* onError has the reason; `ready` also rejects on a hang-up before joining */
    } finally {
      lifecycle.finish(run);
    }
  }, [agentId, versionNo, api, patch, settle, lifecycle]);

  const end = React.useCallback(() => {
    const s = lifecycle.session();
    if (!s) return;
    void s.end().catch(() => s.disconnect());
  }, [lifecycle]);

  const reset = React.useCallback(() => {
    if (lifecycle.session()) return;
    setState(IDLE);
  }, [lifecycle]);

  return { state, start, end, reset };
}
