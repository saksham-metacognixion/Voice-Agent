'use client';

import type { SseEvent } from '@portal/schemas';
import * as React from 'react';
import { subscribeEvents } from '../sse';
import { useApi } from '../provider';

export type StreamState = 'connecting' | 'live' | 'offline';

/**
 * Subscribe to the workspace's SSE stream for the lifetime of the component. `handler` is
 * kept in a ref so a re-render never reconnects; `topics` are compared by value.
 *
 * `enabled: false` (no workspace yet, or a screen that does not need live frames) opens
 * nothing. The returned state drives the polling fallback in `useJobWatch`.
 */
export function useWorkspaceEvents(topics: string[] | undefined, handler: (event: SseEvent) => void, enabled = true): StreamState {
  const api = useApi();
  const [state, setState] = React.useState<StreamState>('connecting');
  const handlerRef = React.useRef(handler);
  handlerRef.current = handler;
  const key = topics ? topics.join(',') : '*';

  React.useEffect(() => {
    if (!enabled) {
      setState('offline');
      return;
    }
    setState('connecting');
    const unsubscribe = subscribeEvents(api, {
      topics: key === '*' ? undefined : key.split(','),
      onEvent: (event) => handlerRef.current(event),
      onOpen: () => setState('live'),
      onError: () => setState('offline'),
    });
    return unsubscribe;
  }, [api, key, enabled]);

  return state;
}
