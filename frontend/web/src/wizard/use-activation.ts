'use client';

import { isApiError, useApi, useGetAgentActivation, useWorkspaceEvents, type StreamState } from '@portal/api-client';
import { activationView, type ActivationView } from '@portal/schemas';
import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';

const POLL_MS = 3_000;

export function isActivationTerminal(view: ActivationView | null | undefined): boolean {
  return view?.status === 'live' || view?.status === 'failed';
}

/**
 * The agent's latest activation (§13.8), as the backend says it is.
 *
 * `GET /agents/:id/activation` is the source of truth — 404 until a job exists, which is
 * the normal state between Stripe's redirect and the paid webhook starting the job — and
 * it is polled every 3 s until the activation is terminal. Once an id is known the
 * `activation:{id}` topic is subscribed as well and each frame's `activationView`
 * replaces the cached one, so progress moves without waiting for the next poll. One
 * subscription per page: the topic only changes when a new activation starts.
 *
 * `since` ignores an activation older than the checkout that brought the customer here
 * (a failed attempt from yesterday is not this payment's activation).
 */
export function useActivation(agentId: string | null, opts: { enabled?: boolean; since?: number | null } = {}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const enabled = Boolean(agentId) && (opts.enabled ?? true);
  const queryKey = React.useMemo(() => ['getAgentActivation', { id: agentId ?? '' }], [agentId]);

  const latest = useGetAgentActivation(api, { id: agentId ?? '' }, { enabled, staleTime: 0 });
  const raw = latest.data ?? null;
  const current = raw && (!opts.since || Date.parse(raw.created_at) >= opts.since - 60_000) ? raw : null;
  const notFound = latest.isError && isApiError(latest.error, 'NOT_FOUND');
  const terminal = isActivationTerminal(current);

  const refetch = latest.refetch;
  React.useEffect(() => {
    if (!enabled || terminal) return;
    const timer = setInterval(() => void refetch(), POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, terminal, refetch]);

  const stream: StreamState = useWorkspaceEvents(
    current ? [`activation:${current.activation_id}`] : undefined,
    (event) => {
      const parsed = activationView.safeParse(event.data);
      if (parsed.success) queryClient.setQueryData(queryKey, parsed.data);
      else void refetch();
    },
    enabled && Boolean(current) && !terminal,
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
