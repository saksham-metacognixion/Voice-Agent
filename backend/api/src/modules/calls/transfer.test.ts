import { describe, expect, it } from 'vitest';
import { type TransferEventFact, computeTransferCharge, foldTransfer } from './transfer';

const T0 = 1_792_996_890_768; // the stored transfer_started of 26 Oct
const started: TransferEventFact = { type: 'transfer_started', at: T0 };
const bridged: TransferEventFact = { type: 'transfer_bridged', at: T0 + 8_000 };
const ended: TransferEventFact = { type: 'transfer_ended', at: T0 + 8_000 + 150_000 };

/** Every permutation, so the fold is shown not to care which event the platform sent first. */
function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]));
}

describe('foldTransfer', () => {
  it('folds started → bridged → ended into one leg, in any delivery order', () => {
    for (const order of permutations([started, bridged, ended])) {
      expect(foldTransfer(order)).toEqual({ status: 'ended', startedAt: T0, bridgedAt: T0 + 8_000, endedAt: T0 + 158_000 });
    }
  });

  it('is unchanged by duplicates and replays', () => {
    expect(foldTransfer([started, bridged, bridged, ended, ended, started])).toEqual(foldTransfer([started, bridged, ended]));
  });

  it('prefers the platform transfer_end_timestamp over when the ended event arrived', () => {
    const late: TransferEventFact = { ...ended, at: T0 + 400_000, transferEndTimestamp: T0 + 98_000 };
    expect(foldTransfer([bridged, late]).endedAt).toBe(T0 + 98_000);
  });

  it('takes the end from a call_ended / call_analyzed when transfer_ended was lost', () => {
    const analyzed: TransferEventFact = { type: 'call_analyzed', at: T0 + 600_000, transferEndTimestamp: T0 + 68_000 };
    expect(foldTransfer([started, bridged, analyzed])).toMatchObject({ status: 'ended', endedAt: T0 + 68_000 });
  });

  it('dates a lost transfer_bridged from an agent leg that ended because the transfer bridged', () => {
    const callEnded: TransferEventFact = { type: 'call_ended', at: T0 + 20_000, disconnectionReason: 'transfer_bridged', endTimestamp: T0 + 9_000 };
    expect(foldTransfer([started, callEnded, ended])).toMatchObject({ status: 'ended', bridgedAt: T0 + 9_000 });
    // Any other reason is not evidence of a bridge.
    expect(foldTransfer([started, { ...callEnded, disconnectionReason: 'call_transfer' }, ended]).bridgedAt).toBeNull();
  });

  it('a transfer that never bridged is cancelled, whether or not the platform said so', () => {
    expect(foldTransfer([started, { type: 'transfer_cancelled', at: T0 + 30_000 }]).status).toBe('cancelled');
    expect(foldTransfer([started, ended])).toMatchObject({ status: 'cancelled', bridgedAt: null, endedAt: null });
  });

  it('is in flight between the bridge and the end', () => {
    expect(foldTransfer([started])).toMatchObject({ status: 'started' });
    expect(foldTransfer([started, bridged])).toMatchObject({ status: 'bridged', endedAt: null });
  });

  it('knows nothing about a call that never transferred', () => {
    expect(foldTransfer([])).toEqual({ status: null, startedAt: null, bridgedAt: null, endedAt: null });
    expect(foldTransfer([{ type: 'call_ended', at: T0, disconnectionReason: 'user_hangup', endTimestamp: T0 }]).status).toBeNull();
  });

  it('ignores a missing or nonsense timestamp rather than billing from it', () => {
    expect(foldTransfer([{ type: 'transfer_bridged', at: Number.NaN }, ended]).status).toBe('cancelled');
    expect(foldTransfer([bridged, { type: 'call_ended', at: T0, transferEndTimestamp: 0 }]).status).toBe('bridged');
  });
});

describe('computeTransferCharge', () => {
  const leg = (seconds: number) => foldTransfer([bridged, { type: 'transfer_ended', at: T0 + 8_000 + seconds * 1000 }]);

  it('bills the leg at 0.25 credits a minute, per second, to 2 dp', () => {
    expect(computeTransferCharge(leg(150), 0.25)).toEqual({ settled: true, billable: true, duration_s: 150, credits: 0.63 });
    expect(computeTransferCharge(leg(60), 0.25)).toMatchObject({ credits: 0.25 });
    expect(computeTransferCharge(leg(3600), 0.25)).toMatchObject({ credits: 15 });
  });

  it('settles a leg too short to cost a hundredth at zero, not billable', () => {
    expect(computeTransferCharge(leg(1), 0.25)).toEqual({ settled: true, billable: false, duration_s: 1, credits: 0, zero_reason: 'zero_duration' });
  });

  it('never bills a transfer that did not bridge', () => {
    expect(computeTransferCharge(foldTransfer([started, ended]), 0.25)).toMatchObject({ settled: true, billable: false, credits: 0, zero_reason: 'not_bridged' });
  });

  it('waits for the end of a leg in flight', () => {
    expect(computeTransferCharge(foldTransfer([started, bridged]), 0.25)).toEqual({ settled: false });
  });

  it('never bills a negative span (an end before the bridge)', () => {
    const backwards = foldTransfer([{ type: 'transfer_bridged', at: T0 + 10_000 }, { type: 'transfer_ended', at: T0 }]);
    expect(computeTransferCharge(backwards, 0.25)).toMatchObject({ billable: false, credits: 0 });
  });

  it('refuses a rate that is not a non-negative number', () => {
    expect(() => computeTransferCharge(leg(60), -1)).toThrow();
    expect(() => computeTransferCharge(leg(60), Number.NaN)).toThrow();
  });
});
