'use client';

import { isApiError, useApi } from '@portal/api-client';
import { agentDetail, type Brief } from '@portal/schemas';
import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { useDebouncedCallback } from '@/src/lib/use-debounced';

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

/**
 * W2 autosave: debounced 1.5 s, `PATCH /agents/:id/draft {brief}` with only the fields
 * that changed since the last successful save — the API merges field by field, so a
 * half-typed textarea never wipes another field. Saves are serialised: a change made
 * while a save is in flight is sent after it, never alongside.
 *
 * `flush()` awaits everything pending; Generate calls it so the model reads what is on
 * the screen, not what was on it 1.5 s ago.
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
    const patch = diff(lastSaved.current, latest.current);
    if (Object.keys(patch).length === 0) {
      setState((s) => (s === 'dirty' ? 'saved' : s));
      return;
    }
    const snapshot = latest.current;
    setState('saving');
    const run = (async () => {
      try {
        await api.patch(`/agents/${encodeURIComponent(agentId)}/draft`, { brief: patch }, agentDetail);
        lastSaved.current = snapshot;
        setFieldErrors({});
        setError(null);
        setState('saved');
        track('brief_field_saved', { agent_id: agentId, fields: Object.keys(patch).length });
      } catch (e) {
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
  }, [agentId, api]);

  const debounced = useDebouncedCallback(() => void save(), 1_500);

  const onChange = React.useCallback(
    (brief: Brief) => {
      latest.current = brief;
      setState('dirty');
      debounced.call();
    },
    [debounced],
  );

  const flush = React.useCallback(async () => {
    debounced.cancel();
    await save();
    if (inFlight.current) await inFlight.current;
    await queryClient.invalidateQueries({ queryKey: ['getAgent', { id: agentId }] });
  }, [debounced, save, queryClient, agentId]);

  const retry = React.useCallback(() => void save(), [save]);

  return { state, error, fieldErrors, onChange, flush, retry, isDirty: state === 'dirty' || state === 'saving' };
}

/** Top-level fields whose JSON differs. */
function diff(prev: Brief | undefined, next: Brief): Partial<Brief> {
  const out: Partial<Brief> = {};
  for (const k of Object.keys(next) as Array<keyof Brief>) {
    const a = prev ? JSON.stringify(prev[k] ?? null) : undefined;
    const b = JSON.stringify(next[k] ?? null);
    if (a !== b) (out as Record<string, unknown>)[k] = next[k];
  }
  return out;
}
