'use client';

import { ApiError, type ApiClient, startWidgetCall } from '@portal/api-client';
import * as React from 'react';
import { RetellClient, type WebCallSession } from 'retell-client-js-sdk';
import { TestCallLifecycle } from '../wizard/test-call-lifecycle';

export type WidgetCallStatus = 'idle' | 'mic' | 'connecting' | 'live' | 'ended' | 'failed';

/** Why a call did not start. `api` carries the §16 code (`WIDGET_UNAVAILABLE`, `RATE_LIMITED`, …). */
export type WidgetCallFailure = { kind: 'mic_denied' } | { kind: 'mic_missing' } | { kind: 'api'; code: string } | { kind: 'connection' };

export interface WidgetCallState {
  status: WidgetCallStatus;
  elapsedS: number;
  agentTalking: boolean;
  failure: WidgetCallFailure | null;
}

const IDLE: WidgetCallState = { status: 'idle', elapsedS: 0, agentTalking: false, failure: null };

/** The one request the SDK makes that we answer: its create-web-call, minted by our API. */
const CREATE_WEB_CALL = '/v3/create-web-call';

/**
 * The site the frame is on: `location.ancestorOrigins` where the browser has it (Chrome,
 * Safari — the embedding page cannot forge it), else the referrer's origin. Null when the
 * frame is opened on its own, or the page withholds its referrer.
 */
export function pageOrigin(): string | null {
  if (window.parent === window) return null;
  const ancestors = (window.location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
  if (ancestors && ancestors.length > 0) return ancestors[0] ?? null;
  try {
    return document.referrer ? new URL(document.referrer).origin : null;
  } catch {
    return null;
  }
}

/**
 * D17 §11.5: a website visitor's browser call — `useTestCall` (W5) without the test
 * parts. The SDK's create-web-call is answered from `POST /widget/:key/call`, which
 * decides everything (live agent, credits, lines, allowed site, budgets); no live
 * transcript, no credits on screen — the caller is a stranger. The same lifecycle guard
 * makes a double click one call and a closed frame a hung-up one.
 */
export function useWidgetCall(api: ApiClient, key: string | null) {
  const [state, setState] = React.useState<WidgetCallState>(IDLE);
  const [lifecycle] = React.useState(() => new TestCallLifecycle<WebCallSession>());
  const liveAt = React.useRef<number | null>(null);

  const patch = React.useCallback(
    (next: Partial<WidgetCallState>) => {
      if (lifecycle.isMounted()) setState((s) => ({ ...s, ...next }));
    },
    [lifecycle],
  );

  React.useEffect(() => {
    lifecycle.mount();
    return () => lifecycle.dispose();
  }, [lifecycle]);

  React.useEffect(() => {
    if (state.status !== 'live') return;
    const timer = setInterval(() => {
      if (liveAt.current) patch({ elapsedS: Math.floor((Date.now() - liveAt.current) / 1000) });
    }, 500);
    return () => clearInterval(timer);
  }, [state.status, patch]);

  const start = React.useCallback(async () => {
    if (!key) return;
    const run = lifecycle.begin();
    if (!run) return;
    liveAt.current = null;
    setState({ ...IDLE, status: 'mic' });

    const mic = await lifecycle.acquireMicrophone(run, () => navigator.mediaDevices.getUserMedia({ audio: true }));
    if (!mic.ok) {
      lifecycle.finish(run);
      if ('inactive' in mic) return;
      const name = mic.error instanceof DOMException ? mic.error.name : '';
      patch({ status: 'failed', failure: { kind: name === 'NotFoundError' || name === 'OverconstrainedError' ? 'mic_missing' : 'mic_denied' } });
      return;
    }

    patch({ status: 'connecting' });
    let apiFailure: ApiError | null = null;
    let held: WebCallSession | null = null;
    const proxiedFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!new URL(url).pathname.endsWith(CREATE_WEB_CALL)) throw new Error('not proxied');
      if (!lifecycle.isActive(run)) throw new Error('call abandoned');
      try {
        const minted = await startWidgetCall(api, { key }, { page_origin: pageOrigin() });
        if (!lifecycle.isActive(run)) throw new Error('call abandoned');
        const { max_call_duration_s: _m, ...forSdk } = minted;
        return new Response(JSON.stringify(forSdk), { status: 200, headers: { 'content-type': 'application/json' } });
      } catch (error) {
        if (error instanceof ApiError) apiFailure = error;
        throw error;
      }
    };

    const client = new RetellClient({ key: 'minted-by-our-api', fetch: proxiedFetch });
    const s = client.createWebCall({
      agent_id: key,
      transcript: false,
      hooks: {
        onStatus: (next) => {
          if (next === 'live') {
            liveAt.current = Date.now();
            patch({ status: 'live', elapsedS: 0 });
          }
          if (next === 'ended') {
            if (held) lifecycle.release(held);
            setState((cur) => (cur.status === 'failed' ? { ...cur, agentTalking: false } : { ...cur, status: 'ended', agentTalking: false }));
          }
        },
        onAgentStartTalking: () => patch({ agentTalking: true }),
        onAgentStopTalking: () => patch({ agentTalking: false }),
        onError: () => {
          if (held) lifecycle.release(held);
          const failed: ApiError | null = apiFailure;
          patch({ status: 'failed', agentTalking: false, failure: failed ? { kind: 'api', code: failed.code } : { kind: 'connection' } });
        },
      },
    });
    held = s;
    if (!lifecycle.attach(run, s)) {
      lifecycle.finish(run);
      return;
    }
    try {
      await s.ready;
    } catch {
      /* onError has the reason */
    } finally {
      lifecycle.finish(run);
    }
  }, [api, key, lifecycle, patch]);

  const end = React.useCallback(() => {
    const s = lifecycle.session();
    if (!s) return;
    void s.end().catch(() => s.disconnect());
  }, [lifecycle]);

  return { state, start, end };
}
