/**
 * §5.4 low-balance alerts, as a pure decision.
 *
 * Thresholds are percentages of the last pack (`low_balance_thresholds_pct`, e.g.
 * [20, 5, 0]). A threshold is *crossed* when the balance is at or below that many
 * credits; `0` means the balance has reached zero. For each threshold there is at most
 * one open alert; it is opened when crossed and no alert is open, and resolved when the
 * balance is back above it — so a balance that recovers and drops again alerts again,
 * and one that sits below the line alerts once.
 */
export interface LowBalanceInput {
  balance: number;
  /** Credits the percentages apply to: the last paid pack, else the trial size. */
  baseCredits: number;
  thresholdsPct: readonly number[];
  /** Threshold percentages that currently have an open alert. */
  openPct: ReadonlySet<number>;
}

export interface LowBalanceDecision {
  /** Thresholds to alert on now, largest first — `{pct, credits}`. */
  open: Array<{ pct: number; credits: number }>;
  /** Open alerts whose threshold the balance is back above. */
  resolve: number[];
}

export function decideLowBalance(input: LowBalanceInput): LowBalanceDecision {
  const open: LowBalanceDecision['open'] = [];
  const resolve: number[] = [];
  if (!(input.baseCredits > 0)) return { open, resolve: [...input.openPct] };
  const seen = new Set<number>();
  for (const pct of [...input.thresholdsPct].sort((a, b) => b - a)) {
    if (seen.has(pct)) continue;
    seen.add(pct);
    const credits = round2((input.baseCredits * pct) / 100);
    const crossed = input.balance <= credits;
    const isOpen = input.openPct.has(pct);
    if (crossed && !isOpen) open.push({ pct, credits });
    if (!crossed && isOpen) resolve.push(pct);
  }
  for (const pct of input.openPct) if (!seen.has(pct)) resolve.push(pct);
  return { open, resolve };
}

export function lowBalanceKey(pct: number): string {
  return `low_balance:${pct}`;
}

export function pctOfLowBalanceKey(key: string): number | null {
  const match = /^low_balance:(\d+(?:\.\d+)?)$/.exec(key);
  return match ? Number(match[1]) : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
