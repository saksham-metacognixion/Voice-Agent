/**
 * What the account menu says about workspaces (QA-013): with several memberships, the list
 * to switch between; with one, just its name — a switch with nowhere to go is noise; with
 * none chosen yet, nothing.
 */
export type AccountMenuWorkspace<M> = { kind: 'switch' } | { kind: 'current'; membership: M } | { kind: 'none' };

export function accountMenuWorkspace<M extends { id: string }>(memberships: readonly M[], activeId: string | null): AccountMenuWorkspace<M> {
  if (memberships.length > 1) return { kind: 'switch' };
  const membership = memberships.find((m) => m.id === activeId);
  return membership ? { kind: 'current', membership } : { kind: 'none' };
}
