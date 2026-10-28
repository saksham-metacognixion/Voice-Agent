'use client';

import { isApiError, useApi } from '@portal/api-client';
import { agentDetail, type Brief } from '@portal/schemas';
import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { useBeforeUnload } from '@/src/lib/use-before-unload';
import { useDebouncedCallback } from '@/src/lib/use-debounced';
import { briefDiff } from '@/src/wizard/brief-patch';

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

/**
 * W2 autosave: debounced 1.5 s, `PATCH /agents/:id/draft {brief}` with only the fields
 * that changed since the last successful save — the API merges field by field, so a
 * half-typed textarea never wipes another field. Saves are serialised: a change made
 * while a save is in flight is sent after it, never alongside.
 *
 * `flush()` awaits everything pending; Generate calls it so the model reads what is on
 * the screen, not what was on it 1.5 s ago. Leaving the page sends a pending save rather
 * than dropping it, and closing the tab with one pending asks first (QA-007). An emptied
 * field is sent as `null` — "clear it" — by `briefDiff` (QA-006).
 *
 * A save is sent to the workspace the edit was typed in: switching workspace selects the
 * new one before this page unmounts, and the unmount flush would otherwise PATCH the agent
 * under the new workspace's header and fail as not found (QA-056). A failed save makes
 * `flush()` throw, so Continue and Generate stop on it instead of moving on with the brief
 * from before (QA-057).
 */
export function useBriefAutosave(agentId: string | null, initial: Brief | undefined) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [state, setState] = React.useState<SaveState>('idle');
  const [error, setError] = React.useState<unknown>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const lastSaved = React.useRef<Brief | undefined>(initial);
  const latest = React.useRef<Brief | undefined>(initial);
  const inFlight = React.useRef<Promise<void> | null>(null);
  const queued = React.useRef(false);
  const workspaceId = React.useRef<string | null>(null);
  const failure = React.useRef<unknown>(null);
  // A save flushed by unmount lands after the page is gone; the next screen must not
  // read the brief from before it.
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  React.useEffect(() => {
    if (initial && lastSaved.current === undefined) {
      lastSaved.current = initial;
      latest.current = initial;
    }
  }, [initial]);

  const save = React.useCallback(async (): Promise<void> => {
    if (!agentId || !latest.current) return;
    if (inFlight.current) {
      queued.current = true;
      return inFlight.current;
    }
    const patch = briefDiff(lastSaved.current, latest.current);
    if (Object.keys(patch).length === 0) {
      setState((s) => (s === 'dirty' ? 'saved' : s));
      return;
    }
    const snapshot = latest.current;
    setState('saving');
    const run = (async () => {
      try {
        await api.patch(`/agents/${encodeURIComponent(agentId)}/draft`, { brief: patch }, agentDetail, {
          workspaceId: workspaceId.current ?? undefined,
        });
        lastSaved.current = snapshot;
        failure.current = null;
        setFieldErrors({});
        setError(null);
        setState('saved');
        track('brief_field_saved', { agent_id: agentId, fields: Object.keys(patch).length });
        if (!mounted.current) void queryClient.invalidateQueries({ queryKey: ['getAgent', { id: agentId }] });
      } catch (e) {
        failure.current = e;
        setError(e);
        setState('error');
        if (isApiError(e) && e.body.fields) {
          const fe: Record<string, string> = {};
          for (const f of e.body.fields) fe[f.field.replace(/^brief\./, '')] = f.message;
          setFieldErrors(fe);
        }
      } finally {
        inFlight.current = null;
        if (queued.current) {
          queued.current = false;
          void save();
        }
      }
    })();
    inFlight.current = run;
    return run;
  }, [agentId, api, queryClient]);

  const debounced = useDebouncedCallback(() => void save(), 1_500, { flushOnUnmount: true });

  const onChange = React.useCallback(
    (brief: Brief) => {
      latest.current = brief;
      workspaceId.current = api.options.getWorkspaceId();
      setState('dirty');
      debounced.call();
    },
    [api, debounced],
  );

  const flush = React.useCallback(async () => {
    debounced.cancel();
    await save();
    if (inFlight.current) await inFlight.current;
    if (failure.current) throw failure.current;
    await queryClient.invalidateQueries({ queryKey: ['getAgent', { id: agentId }] });
  }, [debounced, save, queryClient, agentId]);

  const retry = React.useCallback(() => void save(), [save]);
  // An unsaved failure is still unsaved: closing the tab on it asks first (QA-057).
  const isDirty = state === 'dirty' || state === 'saving' || state === 'error';
  useBeforeUnload(isDirty, debounced.flush);

  return { state, error, fieldErrors, onChange, flush, retry, isDirty };
}
