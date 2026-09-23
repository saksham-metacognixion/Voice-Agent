'use client';

import { isApiError, useApi, useGetWorkspace, useListMyWorkspaces } from '@portal/api-client';
import type { WorkspaceMembershipSummary, WorkspaceResponse } from '@portal/schemas';
import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { useAuth } from '../auth/auth-provider';
import { useActiveWorkspaceId, workspaceStore } from './store';

/**
 * Memberships (A7) and the active workspace. `memberships` is `GET /workspaces`; the
 * stored id is validated against it, so a workspace you were removed from does not stay
 * selected — the guard sends you to the switcher instead of an endless 403.
 */
interface WorkspaceContextValue {
  /** `loading` until memberships are known; `error` when the list itself failed. */
  status: 'idle' | 'loading' | 'ready' | 'error';
  memberships: WorkspaceMembershipSummary[];
  activeId: string | null;
  /** The active membership row, when the stored id is one of ours. */
  active: WorkspaceMembershipSummary | null;
  /** `GET /workspace` for the active one. Undefined until loaded. */
  workspace: WorkspaceResponse | undefined;
  workspaceStatus: 'idle' | 'loading' | 'ready' | 'error';
  /** A refetch is in flight (after a step advance). Guards wait for it rather than redirect on stale data. */
  workspaceFetching: boolean;
  workspaceError: unknown;
  select: (id: string | null) => void;
  refetchMemberships: () => Promise<unknown>;
  refetchWorkspace: () => Promise<unknown>;
}

const Ctx = React.createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const api = useApi();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const activeId = useActiveWorkspaceId();
  const signedIn = auth.status === 'authenticated';

  const memberships = useListMyWorkspaces(api, { enabled: signedIn, staleTime: 60_000 });
  const list = React.useMemo(() => memberships.data ?? [], [memberships.data]);
  const active = React.useMemo(() => list.find((m) => m.id === activeId) ?? null, [list, activeId]);

  // Auto-select the only workspace; drop a stored id that is no longer ours.
  React.useEffect(() => {
    if (!memberships.isSuccess) return;
    if (activeId && !list.some((m) => m.id === activeId)) workspaceStore.set(null);
    else if (!activeId && list.length === 1) workspaceStore.set(list[0]!.id);
  }, [memberships.isSuccess, list, activeId]);

  const workspace = useGetWorkspace(api, { enabled: signedIn && Boolean(active) });

  // A workspace the API says we are not a member of any more → drop it.
  const refetchMemberships = memberships.refetch;
  React.useEffect(() => {
    if (workspace.isError && isApiError(workspace.error, 'NOT_A_MEMBER')) {
      workspaceStore.set(null);
      void refetchMemberships();
    }
  }, [workspace.isError, workspace.error, refetchMemberships]);

  const select = React.useCallback(
    (id: string | null) => {
      if (id === workspaceStore.get()) return;
      workspaceStore.set(id);
      // Everything workspace-scoped is stale the moment the header changes.
      void queryClient.resetQueries({ predicate: (q) => q.queryKey[0] !== 'listMyWorkspaces' });
    },
    [queryClient],
  );

  // Signing out clears the selection; the next person on this browser starts clean.
  React.useEffect(() => {
    if (auth.status === 'anonymous') queryClient.clear();
  }, [auth.status, queryClient]);

  const value = React.useMemo<WorkspaceContextValue>(
    () => ({
      status: !signedIn ? 'idle' : memberships.isPending ? 'loading' : memberships.isError ? 'error' : 'ready',
      memberships: list,
      activeId,
      active,
      workspace: workspace.data,
      workspaceStatus: !active ? 'idle' : workspace.isPending ? 'loading' : workspace.isError ? 'error' : 'ready',
      workspaceFetching: workspace.isFetching,
      workspaceError: workspace.error,
      select,
      refetchMemberships: memberships.refetch,
      refetchWorkspace: workspace.refetch,
    }),
    [signedIn, memberships.isPending, memberships.isError, memberships.refetch, list, activeId, active, workspace.data, workspace.isPending, workspace.isError, workspace.isFetching, workspace.error, workspace.refetch, select],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error('useWorkspace() must be used inside <WorkspaceProvider>');
  return ctx;
}
