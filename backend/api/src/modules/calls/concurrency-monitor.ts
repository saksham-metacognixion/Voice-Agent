/*
 * §14.3 concurrency monitoring, as a pure decision. `live` is what `active:{ws}` holds
 * right now (expired reservations excluded); `cap` is the workspace's plan cap from
 * `caps:{ws}`; `pct` is `CONCURRENCY_ALERT_PCT`. The threshold is *reached* at
 * `ceil(cap × pct / 100)` live calls — at 80% of a cap of 10 that is 8, and exactly 8
 * live calls alert. It clears when the count is back below the threshold.
 */
export interface ConcurrencyInput {
  live: number;
  cap: number;
  pct: number;
  /** Whether an alert is currently open for this workspace. */
  open: boolean;
}

export type ConcurrencyDecision = { action: 'open'; threshold: number } | { action: 'resolve'; threshold: number } | { action: 'none'; threshold: number };

export function concurrencyThreshold(cap: number, pct: number): number {
  if (!(cap > 0)) return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.ceil((cap * pct) / 100));
}

export function decideConcurrency(input: ConcurrencyInput): ConcurrencyDecision {
  const threshold = concurrencyThreshold(input.cap, input.pct);
  const reached = input.live >= threshold;
  if (reached && !input.open) return { action: 'open', threshold };
  if (!reached && input.open) return { action: 'resolve', threshold };
  return { action: 'none', threshold };
}

/** `CONCURRENCY_ALERT_PCT`, default 80 (plan: "concurrency-monitor, alert at 80%"). */
export function concurrencyAlertPct(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.CONCURRENCY_ALERT_PCT);
  return Number.isFinite(raw) && raw > 0 && raw <= 100 ? raw : 80;
}

/** `CONCURRENCY_PLATFORM_LIMIT`: our Retell plan's concurrent-call ceiling, when the operator sets it. Null = not monitored. */
export function platformConcurrencyLimit(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = Number(env.CONCURRENCY_PLATFORM_LIMIT);
  return Number.isInteger(raw) && raw > 0 ? raw : null;
}
