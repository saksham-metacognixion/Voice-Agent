'use client';

import type { StreamState } from '@portal/api-client';
import * as React from 'react';
import { DashboardLiveContext, type NewCallFrame } from './dashboard-live';

export type { NewCallFrame } from './dashboard-live';

/**
 * A page's view of the dashboard's one SSE subscription (§16 `GET /events`), which
 * `DashboardLiveProvider` opens once in the shell for every `/app` page — so the balance
 * pill, the wallet and the page all hear the same frames over one connection.
 *
 * Returns the stream state for the "live" dot. `onNewCall` fires once per call, on its
 * first frame, and only for a phone call; it is unregistered when the page unmounts.
 * `enabled: false` only stops this page's callback — the shell's stream stays open.
 */
export function useDashboardLive(opts: { enabled?: boolean; onNewCall?: (call: NewCallFrame) => void } = {}): StreamState {
  const live = React.useContext(DashboardLiveContext);
  const onNewCall = React.useRef(opts.onNewCall);
  onNewCall.current = opts.onNewCall;
  const enabled = opts.enabled ?? true;
  const wantsCalls = Boolean(opts.onNewCall);
  const subscribe = live?.subscribeNewCall;

  React.useEffect(() => {
    if (!subscribe || !enabled || !wantsCalls) return;
    return subscribe((call) => onNewCall.current?.(call));
  }, [subscribe, enabled, wantsCalls]);

  return live?.state ?? 'offline';
}
