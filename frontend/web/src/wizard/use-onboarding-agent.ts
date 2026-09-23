'use client';

import { useApi, useListAgents, useUpdateWorkspace } from '@portal/api-client';
import type { AgentSummary } from '@portal/schemas';
import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { useWorkspace } from '@/src/workspace/workspace-provider';

/**
 * The agent the wizard is building: the newest agent in the workspace (`GET /agents` is
 * newest-first). W1 creates it; W2/W3 edit its draft. `undefined` while loading, `null`
 * when the workspace has none yet.
 */
export function useOnboardingAgent() {
  const api = useApi();
  const ws = useWorkspace();
  const query = useListAgents(api, { limit: 1 }, { enabled: Boolean(ws.active), staleTime: 10_000 });
  const agent: AgentSummary | null | undefined = query.isPending ? undefined : (query.data?.items[0] ?? null);
  return { agent, query };
}

/**
 * Advances `tenants.onboarding_step` (§6.4) after a step completes. Idempotent: never
 * moves backwards, so revisiting W1 after generating does not un-generate anything. A
 * role that may not PATCH the workspace (editor) is not an error for the wizard — the
 * step still renders; only the resume pointer stays put.
 */
export function useAdvanceOnboarding() {
  const api = useApi();
  const ws = useWorkspace();
  const queryClient = useQueryClient();
  const update = useUpdateWorkspace(api);
  // Single-flight per step: Generate's completion and the Continue button can both ask
  // for the same advance within a second; the second call joins the first.
  const inFlight = React.useRef<{ step: number; promise: Promise<void> } | null>(null);

  return React.useCallback(
    async (step: number, stepKey: string) => {
      const current = ws.workspace?.onboarding_step ?? 1;
      track('onboarding_step_completed', { step: stepKey, step_no: step - 1 });
      if (step <= current) return;
      if (inFlight.current && inFlight.current.step >= step) return inFlight.current.promise;
      const promise = (async () => {
        try {
          await update.mutateAsync({ body: { onboarding_step: step } });
          await queryClient.invalidateQueries({ queryKey: ['getWorkspace'] });
        } catch {
          /* editor role or a transient failure: the page still moves on */
        } finally {
          inFlight.current = null;
        }
      })();
      inFlight.current = { step, promise };
      return promise;
    },
    [ws.workspace?.onboarding_step, update, queryClient],
  );
}
