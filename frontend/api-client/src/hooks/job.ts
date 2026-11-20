'use client';

import { jobResponse, type JobResponse } from '@portal/schemas';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../provider';

export const JOB_POLL_MS = 3_000;

/**
 * `GET /jobs/:id` every 3 s while the job is queued or running (§16: "the client subscribes
 * to SSE and falls back to GET /jobs/:id every 3 s"). It runs *alongside* the stream, not
 * only when the stream is down: a frame can be missed on a reconnect and the server never
 * replays, so the poll is what guarantees the terminal state is seen. It stops itself on
 * success or failure.
 */
export function useJobWatch(jobId: string | null | undefined, opts: { pollMs?: number; enabled?: boolean } = {}) {
  const api = useApi();
  return useQuery<JobResponse>({
    queryKey: ['getJob', { id: jobId }],
    queryFn: () => api.get(`/jobs/${encodeURIComponent(jobId!)}`, jobResponse),
    enabled: Boolean(jobId) && (opts.enabled ?? true),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === 'succeeded' || status === 'failed') return false;
      return opts.pollMs ?? JOB_POLL_MS;
    },
    refetchIntervalInBackground: true,
    staleTime: 0,
    gcTime: 60_000,
  });
}

export function isJobDone(job: JobResponse | undefined): boolean {
  return job?.status === 'succeeded' || job?.status === 'failed';
}
