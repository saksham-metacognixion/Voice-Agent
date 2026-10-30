import type { WorkspaceDb } from '@portal/db';

/**
 * An attempt still `pending` with no call this long after it was last touched is written
 * off as `failed` (`unconfirmed`): the process died between the claim and the answer, or the
 * platform's answer never came and no lifecycle webhook has named the attempt since. Until
 * then it counts toward the cap and its key answers `OUTBOUND_IN_PROGRESS`, because the
 * platform may have rung the person. Wall time, not `now()`: it is about our own process.
 */
export const UNCONFIRMED_ATTEMPT_MS = 5 * 60_000;

/** Pending attempts last touched before this are written off (`UNCONFIRMED_ATTEMPT_MS`). */
export function unconfirmedBefore(): Date {
  return new Date(Date.now() - UNCONFIRMED_ATTEMPT_MS);
}

/**
 * Attempts that count toward a local day's cap: placed, or still being placed and not yet
 * written off. **The one count of today's use** (QA-086): the gate, the claim under the
 * lock, the replay and the D6 Outbound tab all read it, so "3 of 20" on the tab is the same
 * 3 the drawer judges the next press against — a stale unconfirmed attempt drops out of
 * both at the same minute.
 */
export function usedOn(db: WorkspaceDb, workspaceId: string, localDay: string): Promise<number> {
  return db.outboundCall.count({
    where: {
      tenantId: workspaceId,
      localDay: new Date(`${localDay}T00:00:00Z`),
      OR: [{ status: 'placed' }, { status: 'pending', OR: [{ callId: { not: null } }, { updatedAt: { gte: unconfirmedBefore() } }] }],
    },
  });
}
