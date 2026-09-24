'use client';

import { isApiError, sendAgentFeedback, useApi, useJobWatch, useWorkspaceEvents } from '@portal/api-client';
import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { storage } from '@/src/lib/storage';

export type FeedbackStage = 'idle' | 'working' | 'done' | 'failed';

export interface FeedbackState {
  stage: FeedbackStage;
  jobId: string | null;
  /** The version the patch wrote. */
  versionNo: number | null;
  /** §9.6: `changes: []` — the request conflicted with a guardrail; nothing changed. */
  refused: boolean;
  /** The customer-facing explanation when refused, or the failure reason. */
  message: string | null;
}

const IDLE: FeedbackState = { stage: 'idle', jobId: null, versionNo: null, refused: false, message: null };
const key = (agentId: string) => `portal:feedback-job:${agentId}`;

/**
 * §13.5 as the W5 Improve panel sees it: `POST /agents/:id/feedback {text, base_version}`
 * → `202 {job_id}` → `patched` (or `generation_failed`) on `agent:{id}`, with
 * `GET /jobs/:id` polled alongside — the same pair `useGeneration` runs for W2, for the
 * same reason (a frame can be missed on a reconnect and the server never replays).
 *
 * The result is a new immutable draft version; the page re-reads the agent to show it.
 * The job id survives a refresh in localStorage so the panel re-attaches instead of
 * offering a second submit (the API would answer 409 for a second active job).
 */
export function useFeedback(agentId: string | null) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [state, setState] = React.useState<FeedbackState>(IDLE);
  const working = state.stage === 'working';

  React.useEffect(() => {
    if (!agentId) return;
    const stored = storage.get(key(agentId));
    if (stored) setState({ ...IDLE, stage: 'working', jobId: stored });
  }, [agentId]);

  const finish = React.useCallback(
    (next: Partial<FeedbackState> & { stage: 'done' | 'failed' }) => {
      if (agentId) storage.remove(key(agentId));
      setState((s) => ({ ...s, ...next }));
      void queryClient.invalidateQueries({ queryKey: ['getAgent'] });
      track(next.stage === 'done' ? 'feedback_applied' : 'feedback_failed', { agent_id: agentId, version_no: next.versionNo ?? null, refused: next.refused ?? null });
    },
    [agentId, queryClient],
  );

  useWorkspaceEvents(
    agentId ? [`agent:${agentId}`] : undefined,
    (event) => {
      if (!working) return;
      const data = (event.data ?? {}) as Record<string, unknown>;
      // Only frames about this job; a W2-style generation elsewhere must not end this one.
      if (typeof data.job_id === 'string' && state.jobId && data.job_id !== state.jobId) return;
      if (event.type === 'patched') {
        const changes = Array.isArray(data.changes) ? data.changes : null;
        finish({
          stage: 'done',
          versionNo: typeof data.version_no === 'number' ? data.version_no : null,
          refused: changes ? changes.length === 0 : false,
          message: typeof data.explanation === 'string' ? data.explanation : null,
        });
      } else if (event.type === 'generation_failed') {
        finish({ stage: 'failed', message: typeof data.reason === 'string' ? data.reason : null });
      }
    },
    Boolean(agentId) && working,
  );

  const job = useJobWatch(working ? state.jobId : null);
  React.useEffect(() => {
    if (!working || !job.data) return;
    if (job.data.status === 'succeeded') {
      finish({ stage: 'done', versionNo: job.data.progress.version_no, refused: job.data.progress.refused === true, message: job.data.progress.explanation });
    } else if (job.data.status === 'failed') {
      finish({ stage: 'failed', message: job.data.error });
    }
  }, [working, job.data, finish]);
  React.useEffect(() => {
    if (working && job.isError && isApiError(job.error, 'NOT_FOUND')) finish({ stage: 'failed', message: null });
  }, [working, job.isError, job.error, finish]);

  const submit = React.useCallback(
    async (text: string, baseVersion: number | null) => {
      if (!agentId || working) return;
      setState({ ...IDLE, stage: 'working' });
      track('feedback_submitted', { agent_id: agentId, base_version: baseVersion, length: text.length });
      try {
        const res = await sendAgentFeedback(api, { id: agentId }, { text, ...(baseVersion ? { base_version: baseVersion } : {}) });
        storage.set(key(agentId), res.job_id);
        setState((s) => ({ ...s, jobId: res.job_id }));
      } catch (error) {
        if (isApiError(error, 'CONFLICT')) return; // already running: the frames or the poll will end it
        setState(IDLE);
        throw error;
      }
    },
    [agentId, working, api],
  );

  const reset = React.useCallback(() => setState(IDLE), []);
  return { state, working, submit, reset };
}
