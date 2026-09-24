/*
 * ADR 0011 §7: which `calls` rows are still waiting on a lifecycle webhook the platform may
 * never send, and how often the platform may be asked about one. Pure — no I/O — and owned
 * by `calls` because it is a rule about a `calls` row: `GET /calls/:id` uses it to decide
 * whether to queue `recover-call`, and `CallRecoveryService` (module `webhooks`, which
 * already depends on `calls`) uses the same predicate and the same windows to decide what
 * to ask `get-call` about. One copy, so the route cannot queue what the worker discards.
 */

/**
 * How far back recovery looks. A call runs two hours at most and the platform gives up
 * re-delivering within minutes, so a day covers every call this can still settle; older
 * gaps are the nightly `reconcile-calls` report's to show.
 */
export const RECOVER_WINDOW_MS = 24 * 3_600_000;
/** An `ended` row is asked about its analysis for this long after it ended. */
export const RECOVER_ANALYSIS_WINDOW_MS = 6 * 3_600_000;
/**
 * How many times the platform is asked about a row whose analysis it has not produced.
 * Short calls sometimes never get one, and the platform's analysis otherwise lands within
 * a minute of the call; three answers of "no analysis" are the answer. Without a cap an
 * `ended` row with no analysis costs one `get-call` per tick for the whole window.
 */
export const RECOVER_ANALYSIS_MAX_CHECKS = 3;
/**
 * The schedule does not ask about the same row twice within this. A row the platform says
 * is still running (a genuinely long call) or cannot find is re-asked on this cadence, not
 * every 5-minute tick, and rows never asked come first — so a backlog of unanswerable rows
 * cannot starve a call whose webhook was actually lost.
 */
export const RECOVER_RECHECK_MS = 15 * 60_000;

export type UnsettledKind = 'unfinished' | 'unanalysed';

/** The columns the predicate reads. `recoveryChecks` is how often `get-call` has been asked about the row. */
export interface UnsettledCallRow {
  status: string;
  endedAt: Date | null;
  analysisJson: unknown;
  createdAt: Date;
  recoveryChecks: number;
}

/**
 * Still waiting on a webhook: live or lost (`registered` / `in_progress`), or `ended`
 * without its analysis and not yet asked about `RECOVER_ANALYSIS_MAX_CHECKS` times. Null
 * once the row is settled, past the window, or has been asked enough.
 */
export function unsettledCallKind(row: UnsettledCallRow, nowMs = Date.now()): UnsettledKind | null {
  if (row.createdAt.getTime() < nowMs - RECOVER_WINDOW_MS) return null;
  if (row.status === 'registered' || row.status === 'in_progress') return row.endedAt === null ? 'unfinished' : null;
  if (row.status !== 'ended' || row.analysisJson !== null) return null;
  if (row.recoveryChecks >= RECOVER_ANALYSIS_MAX_CHECKS) return null;
  const endedAt = (row.endedAt ?? row.createdAt).getTime();
  return endedAt >= nowMs - RECOVER_ANALYSIS_WINDOW_MS ? 'unanalysed' : null;
}
