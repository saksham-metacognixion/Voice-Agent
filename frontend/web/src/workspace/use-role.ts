'use client';

import { roleAtLeast, type MemberRole } from '@portal/schemas';
import { useWorkspace } from './workspace-provider';

/**
 * The §6.1 matrix as the UI reads it. The API enforces every one of these again; this
 * only decides what to show, so a control a role cannot use is never offered.
 */
export function useRole() {
  const role: MemberRole = useWorkspace().workspace?.role ?? 'viewer';
  return {
    role,
    isOwner: role === 'owner',
    /** Owner/admin: buy, release, billing, team, workspace settings, audit log. */
    canAdmin: roleAtLeast(role, 'admin'),
    /** Editor and up: routing, hand-off, callers, knowledge. */
    canEdit: roleAtLeast(role, 'editor'),
  };
}
