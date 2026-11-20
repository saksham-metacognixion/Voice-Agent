import * as React from 'react';
import { storage } from '../lib/storage';

/**
 * The active workspace id — what goes in `X-Workspace-Id` on every request. A tiny external
 * store rather than React state so the API client can read it synchronously, and so the
 * choice survives a refresh (A7: "remembered per browser").
 */
const KEY = 'portal:workspace';
let current: string | null = storage.get(KEY);
const listeners = new Set<() => void>();

export const workspaceStore = {
  get: () => current,
  set(id: string | null) {
    if (id === current) return;
    current = id;
    if (id) storage.set(KEY, id);
    else storage.remove(KEY);
    listeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export function useActiveWorkspaceId(): string | null {
  return React.useSyncExternalStore(workspaceStore.subscribe, workspaceStore.get, () => null);
}
