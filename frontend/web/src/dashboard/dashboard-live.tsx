'use client';

import { useWorkspaceEvents, type StreamState } from '@portal/api-client';
import type { SseEvent, WalletResponse } from '@portal/schemas';
import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { createEventBus, type EventBus } from './event-bus';
import { walletFrame } from './wallet-frame';

export interface NewCallFrame {
  callId: string;
  fromNumber: string | null;
  agentId: string | null;
  /** True when the §13.9 checks declined it — shown as Missed. */
  missed: boolean;
  /** D17: a visitor on the customer's website (§11.5), who has no number to show. */
  website: boolean;
}

interface DashboardLive {
  state: StreamState;
  /** Returns the unsubscribe. */
  subscribeNewCall: (listener: (call: NewCallFrame) => void) => () => void;
  /**
   * Every frame of the stream, narrowed to `topics` (undefined = all) — for a screen that
   * would otherwise open a stream of its own (`useLiveEvents`). Returns the unsubscribe.
   */
  subscribeEvents: EventBus['subscribe'];
}

export const DashboardLiveContext = React.createContext<DashboardLive | null>(null);

/**
 * The dashboard's one SSE subscription (§16 `GET /events`, every topic of the workspace),
 * opened once by the shell for as long as any `/app` page is on screen. Before D11 each
 * page opened its own, and the shell had none, so the balance pill only moved on the
 * pages that happened to subscribe.
 *
 * A `call:{id}` frame cannot be subscribed to by id — the id is not known until the call
 * exists — so the stream carries the whole workspace and the reaction keys on the topic
 * prefix. Frames are small and never replayed, so the reaction is "re-read the resource":
 * the calls list, the stats, the call itself, the wallet, the alerts. Bursts (a
 * `registered` and an `in_progress` a second apart) are folded into one refetch.
 *
 * `wallet` frames carry `balance_after`, so the balance is written into the `getWallet`
 * cache at once (the pill and D5 move on the frame, not on the refetch) and then
 * re-read to pick up what the frame does not say — expiry, plan, auto top-up. A frame
 * the parser rejects only triggers the re-read. Frames can arrive out of order across a
 * reconnect, so an older frame never overwrites a newer balance.
 */
export function DashboardLiveProvider({ children, enabled = true }: { children: React.ReactNode; enabled?: boolean }) {
  const queryClient = useQueryClient();
  const seen = React.useRef<Set<string>>(new Set());
  const pending = React.useRef<Set<string>>(new Set());
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastWalletTs = React.useRef<string>('');
  const listeners = React.useRef<Set<(call: NewCallFrame) => void>>(new Set());
  const [bus] = React.useState(createEventBus);

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

  const subscribeNewCall = React.useCallback((listener: (call: NewCallFrame) => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  const state = useWorkspaceEvents(
    undefined,
    (event: SseEvent) => {
      bus.emit(event);
      if (event.topic === 'wallet') {
        const frame = walletFrame(event);
        if (frame && event.ts >= lastWalletTs.current) {
          lastWalletTs.current = event.ts;
          // Every `getWallet` entry (the key carries the hook's query argument).
          queryClient.setQueriesData<WalletResponse>({ queryKey: ['getWallet'] }, (old) => (old ? { ...old, balance: frame.balanceAfter } : old));
        }
        invalidate('getWallet', 'getStats', 'listLedger', 'listCreditLots', 'listInvoices');
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
      if (event.topic.startsWith('activation:')) {
        invalidate('listNumbers', 'getWorkspaceChecklist');
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
          // A browser call is a test unless the frame says otherwise: the website widget
          // (D17) is the one that does, and is news like a phone call.
          const isTest = data.is_test === true || (data.channel === 'web' && data.is_test !== false);
          if (isTest) return;
          const call: NewCallFrame = {
            callId,
            fromNumber: typeof data.from_number === 'string' ? data.from_number : null,
            agentId: typeof data.agent_id === 'string' ? data.agent_id : null,
            missed: event.type === 'missed',
            website: data.channel === 'web',
          };
          for (const listener of listeners.current) listener(call);
        }
      }
    },
    enabled,
  );

  const value = React.useMemo(() => ({ state, subscribeNewCall, subscribeEvents: bus.subscribe }), [state, subscribeNewCall, bus]);
  return <DashboardLiveContext.Provider value={value}>{children}</DashboardLiveContext.Provider>;
}
