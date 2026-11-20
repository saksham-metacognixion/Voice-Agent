'use client';

import { isApiError, useApi, useGetCall } from '@portal/api-client';
// The shell's stream under /app (ADR 0019 §1), a stream of its own in the wizard.
import { useLiveEvents } from '../dashboard/use-live-events';
import type { CallDetail } from '@portal/schemas';
import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';

/**
 * How long after hang-up we wait for `call_analyzed` before saying it is not coming. Ten
 * minutes, not two: when the platform drops the webhook, the `call-recovery` schedule
 * settles the call from `get-call` — a 5-minute tick, 3 minutes after the row was written
 * — so a late result is still a result.
 */
export const ANALYSIS_WAIT_MS = 10 * 60_000;
/** Past this the usual webhook has not come; the card says it is taking longer. */
export const ANALYSIS_LATE_MS = 120_000;
/**
 * The poll is only the fallback for a lost webhook — SSE carries `ended` / `analyzed` the
 * moment they land — and a lost webhook is settled by `call-recovery` on a 5-minute tick,
 * so polling faster than this backoff cannot surface the answer any sooner.
 */
const POLL_FIRST_MS = 5_000;
const POLL_MAX_MS = 30_000;

/** 5 s, 10 s, 20 s, then every 30 s. */
export function pollDelay(attempt: number): number {
  return Math.min(POLL_MAX_MS, POLL_FIRST_MS * 2 ** attempt);
}

export type AfterCallStage = 'waiting' | 'ended' | 'analyzed' | 'unavailable' | 'error';

/**
 * The W5 after-call card's data: `GET /calls/:id`, re-read on every `call:{id}` frame
 * (`ended`, `analyzed`) and polled with a backoff as the fallback, until the row is
 * `analyzed` or the wait runs out. Analysis arrives from the platform some seconds after
 * hang-up and is filled in by the `call_analyzed` handler; nothing here invents it.
 *
 * A 404 right after hang-up is normal — `call_started` may still be in the webhook queue
 * — so it is waited on, not shown.
 */
export function useAfterCall(callId: string | null, enabled: boolean) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [endedAt, setEndedAt] = React.useState<number | null>(null);
  const [timedOut, setTimedOut] = React.useState(false);
  const [late, setLate] = React.useState(false);

  React.useEffect(() => {
    setTimedOut(false);
    setLate(false);
    setEndedAt(enabled && callId ? Date.now() : null);
  }, [callId, enabled]);

  // `staleTime` keeps a window-focus refetch from stacking on the poll; SSE invalidation
  // and `refetch()` ignore it.
  const call = useGetCall(api, { id: callId ?? '' }, { enabled: Boolean(callId) && enabled, staleTime: POLL_FIRST_MS });
  const analyzed = call.data?.status === 'analyzed';
  const waiting = Boolean(callId) && enabled && !analyzed && !timedOut;

  // Poll while waiting. `refetchInterval` on the generated hook takes a number, and the
  // 404 case must keep polling too, so it is driven here rather than by the query.
  const refetch = call.refetch;
  React.useEffect(() => {
    if (!waiting) return;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      timer = setTimeout(() => {
        void refetch();
        attempt += 1;
        tick();
      }, pollDelay(attempt));
    };
    tick();
    return () => clearTimeout(timer);
  }, [waiting, refetch]);

  React.useEffect(() => {
    if (!waiting || endedAt === null) return;
    const lateTimer = setTimeout(() => setLate(true), Math.max(0, endedAt + ANALYSIS_LATE_MS - Date.now()));
    const timer = setTimeout(() => setTimedOut(true), Math.max(0, endedAt + ANALYSIS_WAIT_MS - Date.now()));
    return () => {
      clearTimeout(lateTimer);
      clearTimeout(timer);
    };
  }, [waiting, endedAt]);

  useLiveEvents(
    callId ? [`call:${callId}`] : undefined,
    (event) => {
      if (event.type === 'ended' || event.type === 'analyzed') {
        void queryClient.invalidateQueries({ queryKey: ['getCall', { id: callId }] });
        void queryClient.invalidateQueries({ queryKey: ['getWallet'] });
      }
    },
    waiting,
  );

  const notFound = call.isError && isApiError(call.error, 'NOT_FOUND');
  const stage: AfterCallStage = analyzed
    ? 'analyzed'
    : call.isError && !notFound
      ? 'error'
      : timedOut
        ? 'unavailable'
        : call.data && (call.data.status === 'ended' || call.data.status === 'missed')
          ? 'ended'
          : 'waiting';

  const detail: CallDetail | undefined = call.data;
  return { stage, late, call: detail, error: call.error, retry: () => void refetch() };
}
