'use client';

import { useWorkspaceEvents, type StreamState } from '@portal/api-client';
import type { SseEvent } from '@portal/schemas';
import * as React from 'react';
import { DashboardLiveContext } from './dashboard-live';

/**
 * `useWorkspaceEvents` that shares the dashboard's stream when there is one (ADR 0019 §1).
 *
 * Under `/app` the shell's `DashboardLiveProvider` already holds the workspace's one
 * `GET /events`; a D3 generation, feedback round or test call registers a listener on it
 * for its topics instead of opening another connection (each one is a socket of the six
 * a host gets on HTTP/1.1). Outside the shell — the wizard — there is no provider and the
 * hook opens its own stream exactly as before. Same arguments, same returned state.
 */
export function useLiveEvents(topics: string[] | undefined, handler: (event: SseEvent) => void, enabled = true): StreamState {
  const live = React.useContext(DashboardLiveContext);
  const handlerRef = React.useRef(handler);
  handlerRef.current = handler;
  const key = topics ? topics.join(',') : '*';
  const subscribe = live?.subscribeEvents;

  React.useEffect(() => {
    if (!subscribe || !enabled) return;
    return subscribe(key === '*' ? undefined : key.split(','), (event) => handlerRef.current(event));
  }, [subscribe, key, enabled]);

  // Opens nothing while the shell's stream is there to listen to.
  const own = useWorkspaceEvents(topics, handler, enabled && !live);
  if (!live) return own;
  return enabled ? live.state : 'offline';
}
