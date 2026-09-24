'use client';

import { useWorkspaceEvents, type StreamState } from '@portal/api-client';
import type { SseEvent } from '@portal/schemas';
import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';

export interface NewCallFrame {
  callId: string;
  fromNumber: string | null;
  agentId: string | null;
  /** True when the §13.9 checks declined it — shown as Missed. */
  missed: boolean;
}

/**
 * The dashboard's one SSE subscription (§16 `GET /events`, every topic of the workspace).
 *
 * A `call:{id}` frame cannot be subscribed to by id — the id is not known until the
 * call exists — so D1 and D2 listen to the whole workspace stream and act on the topic
 * prefix. Frames are small and never replayed, so the reaction is always "re-read the
 * resource": the calls list, the stats, the call itself, the wallet, the alerts. Bursts
 * (a `registered` and an `in_progress` a second apart) are folded into one refetch.
 *
 * `onNewCall` fires once per call, on its first frame, and only for a phone call —
 * `is_test` marks the customer's own browser test calls, which are not news.
 */
export function useDashboardLive(opts: { enabled?: boolean; onNewCall?: (call: NewCallFrame) => void } = {}): StreamState {
  const queryClient = useQueryClient();
  const seen = React.useRef<Set<string>>(new Set());
  const pending = React.useRef<Set<string>>(new Set());
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const onNewCall = React.useRef(opts.onNewCall);
  onNewCall.current = opts.onNewCall;

  const flush = React.useCallback(() => {
    timer.current = null;
    const keys = [...pending.current];
    pending.current.clear();
    for (const key of keys) {
      const [name, id] = key.split('|');
      void queryClient.invalidateQueries(id ? { queryKey: [name, { id }] } : { queryKey: [name] });
    }
  }, [queryClient]);

  const invalidate = React.useCallback(
    (...keys: string[]) => {
      for (const k of keys) pending.current.add(k);
      if (!timer.current) timer.current = setTimeout(flush, 400);
    },
    [flush],
  );

  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return useWorkspaceEvents(
    undefined,
    (event: SseEvent) => {
      if (event.topic === 'wallet') {
        invalidate('getWallet', 'getStats', 'listLedger');
        return;
      }
      if (event.topic === 'alerts') {
        invalidate('listActiveAlerts');
        return;
      }
      if (event.topic.startsWith('agent:')) {
        invalidate('listAgents', 'getWorkspaceChecklist', `getAgent|${event.topic.slice('agent:'.length)}`);
        return;
      }
      if (event.topic.startsWith('call:')) {
        const callId = event.topic.slice('call:'.length);
        const data = (event.data ?? {}) as Record<string, unknown>;
        invalidate('listCalls', 'getStats', `getCall|${callId}`);
        if (event.type === 'registered' || event.type === 'in_progress' || event.type === 'missed') {
          if (seen.current.has(callId)) return;
          seen.current.add(callId);
          if (seen.current.size > 500) seen.current.delete(seen.current.values().next().value as string);
          const isTest = data.is_test === true || data.channel === 'web';
          if (!isTest) {
            onNewCall.current?.({
              callId,
              fromNumber: typeof data.from_number === 'string' ? data.from_number : null,
              agentId: typeof data.agent_id === 'string' ? data.agent_id : null,
              missed: event.type === 'missed',
            });
          }
        }
      }
    },
    opts.enabled ?? true,
  );
}
