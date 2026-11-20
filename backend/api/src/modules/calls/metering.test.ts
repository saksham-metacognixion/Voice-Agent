import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { roundCredits } from '../wallet/fifo';
import { type CallEndedFacts, computeCharge } from './metering';

/*
 * Metering against the real call_ended payloads captured on D2 (ADR 0003 §3). If Retell
 * changes a field name or a disconnection reason, these fail before production does.
 */

const FIXTURES = path.resolve(__dirname, '../../../test/fixtures/retell');

function fixture(name: string): CallEndedFacts & { call_id: string; duration_ms: number; call_cost?: { combined_cost: number } } {
  const file = JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')) as { body: { event: string; call: never } };
  expect(file.body.event).toBe('call_ended');
  return file.body.call;
}

const STANDARD = 1.0;
const PREMIUM = 1.5;

describe('computeCharge — billable calls from the fixtures', () => {
  it('inbound user_hangup: 75 549 ms → 1.26 credits at Standard, 1.89 at Premium', () => {
    const call = fixture('call_ended-inbound-user_hangup');
    const std = computeCharge(call, STANDARD);
    expect(std).toEqual({ billable: true, duration_s: 75.549, credits: 1.26 });
    expect(computeCharge(call, PREMIUM).credits).toBe(1.89);
    // Not Retell's rounded-up total_duration_seconds (76 → 1.27).
    expect(std.credits).not.toBe(roundCredits((76 / 60) * STANDARD));
  });

  it('inbound max_duration_reached at the 60 s override: 60 004 ms → exactly 1.00', () => {
    const call = fixture('call_ended-inbound-max_duration_reached');
    expect(computeCharge(call, STANDARD)).toEqual({ billable: true, duration_s: 60.004, credits: 1 });
    expect(computeCharge(call, PREMIUM).credits).toBe(1.5);
  });

  it('browser test call bills like a phone call at the tier rate', () => {
    const call = fixture('call_ended-web-max_duration_reached');
    expect(computeCharge(call, STANDARD)).toMatchObject({ billable: true, credits: 1 });
  });

  it('outbound max_duration_reached bills its measured seconds', () => {
    const call = fixture('call_ended-outbound-max_duration_reached');
    const charge = computeCharge(call, STANDARD);
    expect(charge.billable).toBe(true);
    expect(charge.duration_s).toBeCloseTo((call.end_timestamp! - call.start_timestamp!) / 1000, 9);
    expect(charge.credits).toBe(roundCredits((charge.duration_s / 60) * STANDARD));
  });

  it('metered credits stay within ±5 % of duration × rate on every billable fixture (the D3 exit check)', () => {
    for (const name of billableFixtures()) {
      const call = fixture(name);
      const charge = computeCharge(call, PREMIUM);
      const expected = ((call.end_timestamp! - call.start_timestamp!) / 60_000) * PREMIUM;
      expect(Math.abs(charge.credits - expected) / expected, name).toBeLessThan(0.05);
    }
  });
});

describe('computeCharge — the zero-charge rule', () => {
  it.each([
    ['call_ended-outbound-not_connected-dial_busy', 'dial_busy'],
    ['call_ended-outbound-not_connected-dial_no_answer', 'dial_no_answer'],
  ])('%s → 0 credits, not billable', (name, reason) => {
    const call = fixture(name);
    expect(call.disconnection_reason).toBe(reason);
    expect(computeCharge(call, STANDARD)).toEqual({ billable: false, duration_s: 0, credits: 0, zero_reason: 'not_connected' });
  });

  it('a not_connected call with a benign reason (user_hangup before answer) is still 0', () => {
    const call = fixture('call_ended-inbound-zero-duration');
    expect(call.call_status).toBe('not_connected');
    expect(call.disconnection_reason).toBe('user_hangup');
    expect(computeCharge(call, STANDARD)).toMatchObject({ billable: false, credits: 0, zero_reason: 'not_connected' });
  });

  it('a connected call whose Retell cost is 0 still bills its seconds — cost never drives billing', () => {
    const call = { ...fixture('call_ended-inbound-user_hangup'), call_cost: { combined_cost: 0 } };
    expect(computeCharge(call, STANDARD).credits).toBe(1.26);
  });

  it('missing timestamps never bill and never throw', () => {
    expect(computeCharge({ call_status: 'ended', start_timestamp: 1, end_timestamp: null }, STANDARD)).toMatchObject({
      billable: false,
      credits: 0,
      zero_reason: 'missing_timestamps',
    });
    expect(computeCharge({}, STANDARD).billable).toBe(false);
  });

  it('a negative or zero span is a zero charge, not a refund', () => {
    expect(computeCharge({ start_timestamp: 2000, end_timestamp: 1000 }, STANDARD)).toMatchObject({ credits: 0, billable: false });
  });
});

describe('computeCharge — rounding', () => {
  it('rounds to 0.01 half up', () => {
    // 0.3 s at 1 cr/min = 0.005 → 0.01; 0.29 s → 0.0048 → 0.00 (not billable).
    expect(computeCharge({ start_timestamp: 0, end_timestamp: 300 }, STANDARD)).toMatchObject({ credits: 0.01, billable: true });
    expect(computeCharge({ start_timestamp: 0, end_timestamp: 290 }, STANDARD)).toMatchObject({ credits: 0, billable: false, zero_reason: 'zero_duration' });
    // 90 s at 1.5 = 2.25 exactly; 91 s = 2.275 → 2.28.
    expect(computeCharge({ start_timestamp: 0, end_timestamp: 90_000 }, PREMIUM).credits).toBe(2.25);
    expect(computeCharge({ start_timestamp: 0, end_timestamp: 91_000 }, PREMIUM).credits).toBe(2.28);
  });

  it('meters per second, so a 30 s call is half a credit, not a whole minute', () => {
    expect(computeCharge({ start_timestamp: 0, end_timestamp: 30_000 }, STANDARD).credits).toBe(0.5);
  });

  it('refuses a nonsense rate loudly instead of billing 0 or NaN', () => {
    expect(() => computeCharge({ start_timestamp: 0, end_timestamp: 60_000 }, Number.NaN)).toThrow(/rate/);
    expect(() => computeCharge({ start_timestamp: 0, end_timestamp: 60_000 }, -1)).toThrow(/rate/);
  });
});

function billableFixtures(): string[] {
  return readdirSync(FIXTURES)
    .filter((f) => f.startsWith('call_ended-') && f.endsWith('.json') && !/not_connected|zero-duration|\d{4}-\d{2}-\d{2}T/.test(f))
    .map((f) => f.replace(/\.json$/, ''));
}
