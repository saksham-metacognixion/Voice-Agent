import type { WorkspaceDb } from '@portal/db';

/** A verified number of the workspace that may be the caller ID. */
export interface CallerId {
  id: string;
  e164: string;
}

/** What the caller-ID rules read off a number row. */
export interface CallerIdCandidate {
  id: string;
  e164: string | null;
  agentId: string | null;
  status: string;
  pausedAt: Date | null;
  callerIdVerifiedAt: Date | null;
}

/**
 * The numbers the D6 Outbound tab lists as caller IDs and the callback picks from — **one
 * query for both** (QA-085): a number the tab shows but the gate would not pick from, or
 * the other way round, is what this rules out. Paused numbers are included so the tab can
 * say "paused" rather than make a verified number vanish; `usableCallerId` is what decides
 * whether one may be used, and both sides read it.
 */
export function callerIdCandidates<S extends Record<string, boolean>>(db: WorkspaceDb, workspaceId: string, select: S) {
  return db.phoneNumber.findMany({
    where: { tenantId: workspaceId, status: { in: ['active', 'paused'] }, e164: { not: null } },
    select: { id: true, e164: true, agentId: true, status: true, pausedAt: true, callerIdVerifiedAt: true, ...select },
    orderBy: { createdAt: 'asc' },
  });
}

/** Verified (by purchase or by staff), live and not paused: the only kind of number a callback may come from. */
export function usableCallerId(n: CallerIdCandidate): n is CallerIdCandidate & { e164: string } {
  return n.e164 !== null && n.callerIdVerifiedAt !== null && n.status === 'active' && n.pausedAt === null;
}

/** A verified number that is paused — the one state a customer can fix on their own, in Numbers. */
function pausedCallerId(n: CallerIdCandidate): boolean {
  return n.e164 !== null && n.callerIdVerifiedAt !== null && (n.status === 'paused' || n.pausedAt !== null);
}

export type CallerIdPick = { kind: 'ok'; number: CallerId } | { kind: 'none' | 'unverified' | 'paused' };

/**
 * The caller ID: the number asked for, if it is a usable number of this workspace; else
 * the number the call came in on, then one answering for the agent, then any — usable
 * ones only. A number of another workspace is not in `numbers` (RLS) and reads as
 * unverified. A verified number that is paused answers `paused` — when it was asked for,
 * or when it is the only verified number there is — so the customer is sent to Numbers to
 * resume it, not to support to verify it (QA-085).
 */
export function pickCallerId(numbers: ReadonlyArray<CallerIdCandidate>, pick: { requested?: string; sourceNumberId: string | null; agentId: string | null }): CallerIdPick {
  const usable = numbers.filter(usableCallerId);
  if (pick.requested) {
    const asked = usable.find((n) => n.id === pick.requested);
    if (asked) return { kind: 'ok', number: { id: asked.id, e164: asked.e164 } };
    return numbers.some((n) => n.id === pick.requested && pausedCallerId(n)) ? { kind: 'paused' } : { kind: 'unverified' };
  }
  const chosen =
    usable.find((n) => n.id === pick.sourceNumberId) ?? usable.find((n) => pick.agentId !== null && n.agentId === pick.agentId) ?? usable[0];
  if (chosen) return { kind: 'ok', number: { id: chosen.id, e164: chosen.e164 } };
  return numbers.some(pausedCallerId) ? { kind: 'paused' } : { kind: 'none' };
}
