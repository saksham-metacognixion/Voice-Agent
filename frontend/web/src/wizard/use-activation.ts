'use client';

import { isApiError, useApi, useGetAgentActivation, useWorkspaceEvents, type StreamState } from '@portal/api-client';
import { activationView } from '@portal/schemas';
import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { activationFollow, activationForCheckout, type CheckoutSince } from './activation-follow';

export { isActivationTerminal } from './activation-follow';

/**
 * The agent's latest activation (§13.8), as the backend says it is.
 *
 * `GET /agents/:id/activation` is the source of truth — 404 until a job exists, which is
 * the normal state between Stripe's redirect and the paid webhook starting the job — and
 * it is polled every 3 s while one is in flight. Once an id is known the
 * `activation:{id}` topic is subscribed as well and each frame's `activationView`
 * replaces the cached one, so progress moves without waiting for the next poll. One
 * subscription per page: the topic only changes when a new activation starts.
 *
 * A failed activation is not the end of the story (QA-018): a late webhook can still
 * credit the pack and start a new one. So after a failure the poll slows to 15 s rather
 * than stopping, and the `wallet` and `agent:{id}` topics stay subscribed beside the old
 * activation's; any frame on them re-reads the latest activation.
 *
 * `since` ignores an activation older than the checkout that brought the customer here
 * (a failed attempt from yesterday is not this payment's activation) — see
 * `activationForCheckout`; it is a server time, never the browser's clock (QA-020).
 */
export function useActivation(agentId: string | null, opts: { enabled?: boolean; since?: CheckoutSince } = {}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const enabled = Boolean(agentId) && (opts.enabled ?? true);
  const queryKey = React.useMemo(() => ['getAgentActivation', { id: agentId ?? '' }], [agentId]);

  const latest = useGetAgentActivation(api, { id: agentId ?? '' }, { enabled, staleTime: 0 });
  const raw = latest.data ?? null;
  const current = activationForCheckout(raw, opts.since ?? null);
  const notFound = latest.isError && isApiError(latest.error, 'NOT_FOUND');
  const follow = activationFollow(agentId ?? '', current);

  const refetch = latest.refetch;
  React.useEffect(() => {
    if (!enabled || follow.pollMs === null) return;
    const timer = setInterval(() => void refetch(), follow.pollMs);
    return () => clearInterval(timer);
  }, [enabled, follow.pollMs, refetch]);

  const currentId = current?.activation_id ?? null;
  const stream: StreamState = useWorkspaceEvents(
    follow.topics ?? undefined,
    (event) => {
      // This activation's own frame carries its view; anything else (a credited pack, the
      // agent going live, a new attempt) only says "look again".
      const parsed = event.topic === `activation:${currentId}` ? activationView.safeParse(event.data) : null;
      if (parsed?.success) queryClient.setQueryData(queryKey, parsed.data);
      else void refetch();
    },
    enabled && follow.topics !== null,
  );

  return {
    view: current,
    /** No activation for this checkout yet (404, or only an older one). */
    none: !current && (notFound || Boolean(raw)),
    loading: latest.isPending && enabled,
    error: latest.isError && !notFound ? latest.error : null,
    stream,
    refetch: () => void refetch(),
  };
}
