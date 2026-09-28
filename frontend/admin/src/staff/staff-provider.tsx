'use client';

import { useAdminMe, useApi } from '@portal/api-client';
import type { StaffMeResponse } from '@portal/schemas';
import * as React from 'react';
import { can } from '../lib/permissions';

/**
 * `GET /admin/me` for the whole console: who is signed in, their role and limits, and
 * their open view-as sessions (refetched every 30 s for the banner). Mounted by the guard
 * once the token is there, so every page reads the same answer.
 */
interface StaffContextValue {
  me: StaffMeResponse;
  can: ReturnType<typeof can>;
  refetch: () => Promise<unknown>;
}

const StaffContext = React.createContext<StaffContextValue | null>(null);

export function StaffProvider({ me, refetch, children }: { me: StaffMeResponse; refetch: () => Promise<unknown>; children: React.ReactNode }) {
  const value = React.useMemo<StaffContextValue>(() => ({ me, can: can(me), refetch }), [me, refetch]);
  return <StaffContext.Provider value={value}>{children}</StaffContext.Provider>;
}

export function useStaff(): StaffContextValue {
  const ctx = React.useContext(StaffContext);
  if (!ctx) throw new Error('useStaff() must be used inside <StaffProvider>');
  return ctx;
}

/** The query behind the provider, exposed so the guard can render its states. */
export function useStaffMe() {
  const api = useApi();
  return useAdminMe(api, { refetchInterval: 30_000, staleTime: 10_000, retry: false });
}
