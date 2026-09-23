'use client';

import { isApiError, useApi, useJobWatch, useWorkspaceEvents } from '@portal/api-client';
import { acceptedJob, type AgentDetail } from '@portal/schemas';
import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { storage } from '@/src/lib/storage';

export type GenerationStage = 'idle' | 'queued' | 'started' | 'writing' | 'done' | 'failed';

export interface GenerationState {
  stage: GenerationStage;
  jobId: string | null;
  /** Customer-safe reason on failure (`data.reason` on the frame, `error` on the job). */
  reason: string | null;
  /** The version the generation wrote, once known. */
  versionNo: number | null;
}

const key = (agentId: string) => `portal:gen-job:${agentId}`;

/** How long a generation may run before the panel admits it is unusual. */
const SLOW_AFTER_MS = 60_000;

/**
 * §13.3 as the client sees it: `POST /agents/:id/generate` → `202 {job_id}` → progress on
 * the `agent:{id}` SSE topic (`generation_started`, `generation_progress`, `generated`,
 * `generation_failed`) with `GET /jobs/:id` polled every 3 s as the fallback (§16). Both
 * run at once; whichever says "done" first wins and the other is ignored.
 *
 * The job id is kept in localStorage per agent so a refresh mid-generation re-attaches
 * instead of showing a button that would start a second job (the API refuses a second
 * active job per agent with 409; that is treated as "already running", not an error).
 */
export function useGeneration(agent: AgentDetail | undefined) {
  const api = useApi();
  const queryClient = useQueryClient();
  const agentId = agent?.id ?? null;
  const [state, setState] = React.useState<GenerationState>({ stage: 'idle', jobId: null, reason: null, versionNo: null });
  const startedAt = React.useRef<number | null>(null);

  // Re-attach after a refresh.
  React.useEffect(() => {
    if (!agentId) return;
    const stored = storage.get(key(agentId));
    if (stored) setState({ stage: 'queued', jobId: stored, reason: null, versionNo: null });
  }, [agentId]);

  const active = state.stage === 'queued' || state.stage === 'started' || state.stage === 'writing';

  const finish = React.useCallback(
    (next: Partial<GenerationState> & { stage: 'done' | 'failed' }) => {
      if (agentId) storage.remove(key(agentId));
      setState((s) => ({ ...s, ...next }));
      void queryClient.invalidateQueries({ queryKey: ['getAgent'] });
      void queryClient.invalidateQueries({ queryKey: ['listAgents'] });
      const elapsed = startedAt.current ? Date.now() - startedAt.current : null;
      if (next.stage === 'done') track('generation_completed', { agent_id: agentId, version_no: next.versionNo ?? null, elapsed_ms: elapsed });
      else track('generation_failed', { agent_id: agentId, elapsed_ms: elapsed });
      startedAt.current = null;
    },
    [agentId, queryClient],
  );

  // SSE
  useWorkspaceEvents(
    agentId ? [`agent:${agentId}`] : undefined,
    (event) => {
      if (!active) return;
      const data = (event.data ?? {}) as Record<string, unknown>;
      switch (event.type) {
        case 'generation_started':
          setState((s) => (s.stage === 'queued' ? { ...s, stage: 'started' } : s));
          break;
        case 'generation_progress':
          setState((s) => (s.stage === 'queued' || s.stage === 'started' ? { ...s, stage: 'writing' } : s));
          break;
        case 'generated':
          finish({ stage: 'done', versionNo: typeof data.version_no === 'number' ? data.version_no : null });
          break;
        case 'generation_failed':
          finish({ stage: 'failed', reason: typeof data.reason === 'string' ? data.reason : null });
          break;
        default:
          break;
      }
    },
    Boolean(agentId) && active,
  );

  // Poll fallback
  const job = useJobWatch(active ? state.jobId : null);
  React.useEffect(() => {
    if (!active || !job.data) return;
    if (job.data.status === 'succeeded') finish({ stage: 'done', versionNo: job.data.progress.version_no });
    else if (job.data.status === 'failed') finish({ stage: 'failed', reason: job.data.error });
    else if (job.data.status === 'running') setState((s) => (s.stage === 'queued' ? { ...s, stage: 'started' } : s));
  }, [active, job.data, finish]);
  React.useEffect(() => {
    // A job the API no longer knows (404 after a restart, or a stale stored id) is not running.
    if (active && job.isError && isApiError(job.error, 'NOT_FOUND')) finish({ stage: 'failed', reason: null });
  }, [active, job.isError, job.error, finish]);

  const start = React.useCallback(
    async (mode: 'generate' | 'regenerate') => {
      if (!agentId || active) return;
      track('generate_clicked', { agent_id: agentId, mode });
      startedAt.current = Date.now();
      setState({ stage: 'queued', jobId: null, reason: null, versionNo: null });
      try {
        const res = await api.post(`/agents/${encodeURIComponent(agentId)}/generate`, { mode }, acceptedJob);
        storage.set(key(agentId), res.job_id);
        setState((s) => ({ ...s, jobId: res.job_id }));
        track('generation_started', { agent_id: agentId, mode, job_id: res.job_id });
      } catch (error) {
        if (isApiError(error, 'CONFLICT')) {
          // Already running: stay in the waiting state; SSE or the agent refetch will end it.
          return;
        }
        startedAt.current = null;
        setState({ stage: 'failed', jobId: null, reason: null, versionNo: null });
        throw error;
      }
    },
    [agentId, active, api],
  );

  const reset = React.useCallback(() => setState({ stage: 'idle', jobId: null, reason: null, versionNo: null }), []);

  // Generation is ~15 s at p95 (ADR 0012). Past a minute something is wrong — most often
  // on a dev box that no worker is consuming the queue, in which case the job stays
  // `queued` for ever and the panel would otherwise spin with nothing to say.
  const [slow, setSlow] = React.useState(false);
  React.useEffect(() => {
    if (!active) {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, [active]);

  return { state, active, slow, start, reset };
}
