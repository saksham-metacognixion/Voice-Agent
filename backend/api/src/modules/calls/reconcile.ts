import type { ProviderCallFacts } from '../retell';

/*
 * §14.2 / §13.11 `reconcile-calls`: the pure comparison. Deterministic — same inputs,
 * same numbers — so the threshold check is testable without a provider.
 */

/** What we hold for a call in the window: the id, how long, and the COGS the analysis event gave us. */
export interface InternalCallFacts {
  id: string;
  duration_s: number | null;
  retell_cost_cents: number | null;
  workspace_id: string;
  billable: boolean;
}

export interface ReconciliationMetrics {
  provider_calls: number;
  internal_calls: number;
  matched: number;
  /** Provider ids with no row of ours — calls that were never billed. */
  missing: string[];
  /** Our ids the provider does not list in this window. */
  extra: string[];
  provider_seconds: number;
  internal_seconds: number;
  provider_cost_cents: number;
  internal_cost_cents: number;
  /** |missing| + |extra| over the larger of the two populations, in percent. */
  id_drift_pct: number;
  /** |Σ provider seconds − Σ internal seconds| over provider seconds, in percent, matched calls only. */
  seconds_drift_pct: number;
  /** The number the threshold is compared against: the larger of the two. */
  drift_pct: number;
}

export function reconcile(provider: readonly ProviderCallFacts[], internal: readonly InternalCallFacts[]): ReconciliationMetrics {
  const ours = new Map(internal.map((c) => [c.id, c]));
  const theirs = new Map(provider.map((c) => [c.call_id, c]));

  const missing: string[] = [];
  const extra: string[] = [];
  let matched = 0;
  let providerSeconds = 0;
  let internalSeconds = 0;
  let providerCost = 0;
  let internalCost = 0;

  for (const call of provider) {
    providerCost += call.cost_cents ?? 0;
    const mine = ours.get(call.call_id);
    if (!mine) {
      missing.push(call.call_id);
      continue;
    }
    matched += 1;
    providerSeconds += call.duration_s ?? 0;
    internalSeconds += mine.duration_s ?? 0;
  }
  for (const call of internal) {
    internalCost += call.retell_cost_cents ?? 0;
    if (!theirs.has(call.id)) extra.push(call.id);
  }
  missing.sort();
  extra.sort();

  const population = Math.max(provider.length, internal.length);
  const idDrift = population === 0 ? 0 : round3(((missing.length + extra.length) / population) * 100);
  const secondsDrift = providerSeconds === 0 ? (internalSeconds === 0 ? 0 : 100) : round3((Math.abs(providerSeconds - internalSeconds) / providerSeconds) * 100);

  return {
    provider_calls: provider.length,
    internal_calls: internal.length,
    matched,
    missing,
    extra,
    provider_seconds: Math.round(providerSeconds),
    internal_seconds: Math.round(internalSeconds),
    provider_cost_cents: providerCost,
    internal_cost_cents: internalCost,
    id_drift_pct: idDrift,
    seconds_drift_pct: secondsDrift,
    drift_pct: Math.max(idDrift, secondsDrift),
  };
}

/** `RECONCILE_DRIFT_THRESHOLD_PCT`, default 5 (plan: "alert > 5% drift"). */
export function driftThresholdPct(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.RECONCILE_DRIFT_THRESHOLD_PCT);
  return Number.isFinite(raw) && raw >= 0 ? raw : 5;
}

/** The previous whole UTC day, the window the 02:30 UTC schedule reconciles. */
export function previousUtcDay(now: Date): { start: Date; end: Date } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { start: new Date(end.getTime() - 86_400_000), end };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
