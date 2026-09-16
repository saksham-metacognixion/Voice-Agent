import { describe, expect, it } from 'vitest';
import type { WorkspaceCaps } from '@portal/schemas';
import type { CurrentPricing } from '../config';
import { NUMBER_RECORD_VERSION, type NumberRecord } from '../runtime-cache';
import { ACTIVE_SLACK_MS, type ActiveCall, type Decision, decide, encodeActive, parseActiveHash } from './inbound.decide';
import { RESERVE_SCRIPT } from './reserve.script';

/*
 * The six ordered §13.9 checks, exhaustively. Every branch here decides whether a real
 * phone rings, so the cases are written as the situations they are: a paused workspace, a
 * customer at exactly zero credits, a workspace at its concurrency cap, a bar that just
 * closed, and every way the Redis cache can be incomplete when the call arrives.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const NUM = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'tok_abcdefgh12345678';
/** Wednesday 2026-09-16, 10:00 in Toronto. */
const NOW = new Date('2026-09-16T14:00:00Z');

function number(overrides: Partial<NumberRecord> = {}): NumberRecord {
  return {
    v: NUMBER_RECORD_VERSION,
    number_id: NUM,
    e164: '+14505550123',
    inbound_token: TOKEN,
    workspace_id: WS,
    workspace_paused: false,
    number_paused: false,
    number_active: true,
    agent_id: AGENT,
    retell_agent_id: 'agent_retell_1',
    agent_live: true,
    agent_name: 'Maya',
    tier: 'standard',
    business_name: 'Maple Dental',
    timezone: 'America/Toronto',
    plan_max_ms: 600_000,
    // `refresh()` writes rateForTier(config.rates, tier) into the record, so the helper
    // does the same: a premium number carries the premium rate unless a test says otherwise.
    rate_per_min: overrides.tier === 'premium' ? 1.5 : 1,
    config_version: 1,
    hours_mode: 'always',
    hours: null,
    blocklist: [],
    transfer_numbers: [],
    refreshed_at: NOW.toISOString(),
    ...overrides,
  };
}

function caps(overrides: Partial<WorkspaceCaps> = {}): WorkspaceCaps {
  return {
    plan_tier: 'growth',
    concurrency_cap: 3,
    kb_allowance: 1,
    max_agents: 3,
    max_numbers: 3,
    grace_overdraft_credits: 10,
    config_version: 1,
    ...overrides,
  };
}

function pricing(standard = 1.0, premium = 1.5): CurrentPricing {
  return {
    version: 7,
    effective_at: NOW.toISOString(),
    config: {
      rates: { standard_per_min: standard, premium_per_min: premium, web_call_per_min: null, toll_free_surcharge_per_min: 0, transferred_leg_per_min: 0, rounding_dp: 2 },
      wallet_policy: { grace_overdraft_credits: 10 },
    } as CurrentPricing['config'],
  };
}

function active(count: number, credits = 120): ActiveCall[] {
  return Array.from({ length: count }, (_, i) => ({ callId: `call_live_${i}`, credits, expiresAt: NOW.getTime() + 600_000 }));
}

function run(overrides: Partial<Parameters<typeof decide>[0]> = {}): Decision {
  return decide({
    token: TOKEN,
    callId: 'call_incoming',
    from: '+19375550100',
    to: '+14505550123',
    now: NOW,
    number: number(),
    caps: caps(),
    balance: 100,
    active: [],
    pricing: pricing(),
    rejectInbound: false,
    ...overrides,
  });
}

describe('identifying the number', () => {
  it('allows a healthy call and names the Retell agent to answer with', () => {
    const d = run();
    expect(d.kind).toBe('allow');
    if (d.kind !== 'allow') return;
    expect(d).toMatchObject({ workspaceId: WS, numberId: NUM, agentId: AGENT, retellAgentId: 'agent_retell_1', tier: 'standard' });
    expect(d.metadata).toEqual({ tenant_id: WS, number_id: NUM, agent_id: AGENT, tier: 'standard' });
    expect(d.warnings).toEqual([]);
  });

  it('cannot authorise a number it has never heard of, or a call with no to_number', () => {
    expect(run({ number: null })).toEqual({ kind: 'open', reason: 'unknown_number' });
    expect(run({ to: null })).toEqual({ kind: 'open', reason: 'missing_to_number' });
  });

  it('refuses a token that does not match the number it was minted for', () => {
    // Someone guessed a number but not its token, or a token was rotated and Retell still
    // holds the old URL. Either way this is not an authorisation we can make.
    expect(run({ token: 'tok_someone_elses_token' })).toEqual({ kind: 'open', reason: 'token_mismatch' });
  });
});

describe('the six ordered checks', () => {
  it('1. a paused workspace declines as paused', () => {
    expect(run({ number: number({ workspace_paused: true }) })).toMatchObject({ kind: 'decline', reason: 'paused' });
  });

  it('2. a paused, provisioning or released number declines as paused', () => {
    expect(run({ number: number({ number_paused: true }) })).toMatchObject({ kind: 'decline', reason: 'paused' });
    expect(run({ number: number({ number_active: false }) })).toMatchObject({ kind: 'decline', reason: 'paused' });
  });

  it('2b. a number with no live agent declines rather than answering with nothing', () => {
    expect(run({ number: number({ agent_live: false }) })).toMatchObject({ kind: 'decline', reason: 'paused' });
    expect(run({ number: number({ retell_agent_id: null }) })).toMatchObject({ kind: 'decline', reason: 'paused' });
    expect(run({ number: number({ agent_id: null, retell_agent_id: null, agent_live: false }) })).toMatchObject({ kind: 'decline', reason: 'paused' });
  });

  it('3. a blocklisted caller declines as blocked, however the number is formatted', () => {
    const blocked = number({ blocklist: ['+19375550100'] });
    expect(run({ number: blocked })).toMatchObject({ kind: 'decline', reason: 'blocked' });
    expect(run({ number: blocked, from: '+1 (937) 555-0100' })).toMatchObject({ kind: 'decline', reason: 'blocked' });
    // Without a country code there is no number to compare: normalisation does not guess one.
    expect(run({ number: blocked, from: '(937) 555-0100' })).toMatchObject({ kind: 'allow' });
    expect(run({ number: blocked, from: '+19375550101' })).toMatchObject({ kind: 'allow' });
    // A withheld caller id cannot be matched against a blocklist and is not a decline.
    expect(run({ number: blocked, from: null })).toMatchObject({ kind: 'allow' });
  });

  it('4. the balance must stay above −grace, counting what live calls may still spend', () => {
    expect(run({ balance: -9.99 })).toMatchObject({ kind: 'allow' });
    expect(run({ balance: -10 })).toMatchObject({ kind: 'decline', reason: 'balance' });
    expect(run({ balance: -10.01 })).toMatchObject({ kind: 'decline', reason: 'balance' });
    expect(run({ balance: 0 })).toMatchObject({ kind: 'allow' });
    // Two calls already live, each able to spend 60 credits, against a balance of 100:
    // this third call would be authorised against credits the others may still use.
    expect(run({ balance: 100, active: active(2, 60), caps: caps({ concurrency_cap: 5 }) })).toMatchObject({ kind: 'decline', reason: 'balance' });
    expect(run({ balance: 100, active: active(1, 60), caps: caps({ concurrency_cap: 5 }) })).toMatchObject({ kind: 'allow' });
  });

  it('5. the concurrency cap counts every live call, and declines as cap', () => {
    expect(run({ active: active(2, 0) })).toMatchObject({ kind: 'allow' });
    expect(run({ active: active(3, 0) })).toMatchObject({ kind: 'decline', reason: 'cap' });
    expect(run({ active: active(9, 0) })).toMatchObject({ kind: 'decline', reason: 'cap' });
    // A cap of zero (a suspended plan) declines the first call.
    expect(run({ active: [], caps: caps({ concurrency_cap: 0 }) })).toMatchObject({ kind: 'decline', reason: 'cap' });
  });

  it('6. outside business hours declines as hours; `always` never looks at the clock', () => {
    const businessHours = { days: { wed: [{ open: '09:00', close: '17:00' }] }, closed_dates: [] };
    const open = number({ hours_mode: 'business', hours: businessHours });
    expect(run({ number: open })).toMatchObject({ kind: 'allow' });
    // 03:00 Toronto.
    expect(run({ number: open, now: new Date('2026-09-16T07:00:00Z') })).toMatchObject({ kind: 'decline', reason: 'hours' });
    // The same instant on a 24/7 number is allowed.
    expect(run({ number: number({ hours_mode: 'always' }), now: new Date('2026-09-16T07:00:00Z') })).toMatchObject({ kind: 'allow' });
  });

  it('applies the checks in order, so the most actionable reason wins when several apply', () => {
    const everything = number({ workspace_paused: true, number_paused: true, blocklist: ['+19375550100'], hours_mode: 'business', hours: { days: {}, closed_dates: [] } });
    expect(run({ number: everything, balance: -100, active: active(9) })).toMatchObject({ kind: 'decline', reason: 'paused' });
    const noPause = number({ blocklist: ['+19375550100'], hours_mode: 'business', hours: { days: {}, closed_dates: [] } });
    expect(run({ number: noPause, balance: -100, active: active(9) })).toMatchObject({ kind: 'decline', reason: 'blocked' });
    const noBlock = number({ hours_mode: 'business', hours: { days: {}, closed_dates: [] } });
    expect(run({ number: noBlock, balance: -100, active: active(9) })).toMatchObject({ kind: 'decline', reason: 'balance' });
    expect(run({ number: noBlock, balance: 100, active: active(9, 0) })).toMatchObject({ kind: 'decline', reason: 'cap' });
    expect(run({ number: noBlock, balance: 100, active: [] })).toMatchObject({ kind: 'decline', reason: 'hours' });
  });

  it('the reject_inbound kill switch declines everything, before any other check', () => {
    const d = run({ rejectInbound: true });
    expect(d).toMatchObject({ kind: 'decline', reason: 'paused', workspaceId: WS });
  });
});

describe('a retry of the call being decided', () => {
  /*
   * Retell re-sends `call_inbound` with an identical `call_id` up to three times when it
   * does not get an answer it likes — the `call_inbound-decline_timeout-attempt{1,2,3}`
   * fixtures are one caller, one call id, three POSTs. The timeout case is exactly the one
   * where attempt 1 already reserved before giving up on us, so by attempt 2 the call's own
   * reservation is sitting in `active:{ws}`. Counted, it declines the caller on `cap` for a
   * slot that is being held for them, or sizes them from credits they are holding
   * themselves. `reserve.script.ts` excludes `field ~= callId`; this is the same exclusion.
   */
  const own = (credits: number): ActiveCall => ({ callId: 'call_incoming', credits, expiresAt: NOW.getTime() + 600_000 });

  it('does not count its own reservation against the concurrency cap', () => {
    expect(run({ active: [...active(2, 0), own(0)], caps: caps({ concurrency_cap: 3 }) })).toMatchObject({ kind: 'allow' });
    // A cap of one, held by this very call, is still free for it.
    expect(run({ active: [own(0)], caps: caps({ concurrency_cap: 1 }) })).toMatchObject({ kind: 'allow' });
  });

  it('does not subtract its own reservation from the credits it may spend', () => {
    // 10 credits, all of them reserved by attempt 1: counted, this retry would see nothing
    // available and be clamped to the 60 s floor — or declined outright at the grace.
    const d = run({ balance: 10, active: [own(10)] });
    expect(d.kind).toBe('allow');
    if (d.kind !== 'allow') return;
    expect(d.available).toBe(10);
    expect(d.maxCallDurationMs).toBe(600_000);
  });

  it('still declines a retry when it is the other calls that have spent the wallet', () => {
    const other: ActiveCall = { callId: 'call_other', credits: 20, expiresAt: NOW.getTime() + 600_000 };
    expect(run({ balance: 10, active: [own(10), other], caps: caps({ concurrency_cap: 5 }) })).toMatchObject({ kind: 'decline', reason: 'balance' });
  });

  it('counts every reservation when the payload carried no call_id, having nothing to exclude', () => {
    expect(run({ callId: null, active: active(3, 0) })).toMatchObject({ kind: 'decline', reason: 'cap' });
  });

  it('excludes the same field the reservation script does, so neither refuses what the other allows', () => {
    expect(RESERVE_SCRIPT).toContain('field ~= callId');
  });
});

describe('max_call_duration_ms = min(planMax, remainingCredits/rate × 60000)', () => {
  it('takes the plan maximum when credits are plentiful', () => {
    const d = run({ balance: 1000 });
    expect(d.kind === 'allow' && d.maxCallDurationMs).toBe(600_000);
  });

  it('takes the credit-bounded duration when it is the smaller of the two', () => {
    // 3 credits at 1 credit/min = 3 minutes, under the 10-minute plan max.
    const d = run({ balance: 3 });
    expect(d.kind === 'allow' && d.maxCallDurationMs).toBe(180_000);
  });

  it('prices a premium agent at the premium rate', () => {
    // 3 credits at 1.5 credits/min = 2 minutes.
    const d = run({ number: number({ tier: 'premium' }), balance: 3 });
    expect(d.kind === 'allow' && d.maxCallDurationMs).toBe(120_000);
    expect(d.kind === 'allow' && d.rate).toBe(1.5);
  });

  it('subtracts what other live calls have reserved before sizing this one', () => {
    // 10 credits, 6 already reserved by a live call → 4 minutes at 1 credit/min.
    const d = run({ balance: 10, active: [{ callId: 'call_other', credits: 6, expiresAt: NOW.getTime() + 60_000 }] });
    expect(d.kind === 'allow' && d.available).toBe(4);
    expect(d.kind === 'allow' && d.maxCallDurationMs).toBe(240_000);
  });

  it('clamps into Retell’s [60 s, 2 h] window, so a tiny balance still gets a minute', () => {
    // 0.2 credits would be 12 s; Retell refuses anything under 60 s, and the grace covers it.
    expect(run({ balance: 0.2 }).kind === 'allow' && (run({ balance: 0.2 }) as { maxCallDurationMs: number }).maxCallDurationMs).toBe(60_000);
    // Zero credits is still above −grace, so the call is allowed for the minimum minute.
    const zero = run({ balance: 0 });
    expect(zero.kind === 'allow' && zero.maxCallDurationMs).toBe(60_000);
    // A plan maximum beyond Retell's ceiling is clamped down to it.
    const huge = run({ number: number({ plan_max_ms: 99_999_999 }), balance: 1_000_000 });
    expect(huge.kind === 'allow' && huge.maxCallDurationMs).toBe(7_200_000);
  });

  it('is exactly the plan maximum when credits cover precisely that much talking', () => {
    // 10 minutes of plan max at 1 credit/min = 10 credits, exactly.
    const d = run({ balance: 10 });
    expect(d.kind === 'allow' && d.maxCallDurationMs).toBe(600_000);
  });

  it('reserves what this call could spend at its own ceiling', () => {
    const d = run({ balance: 3 });
    // 3 minutes at 1 credit/min.
    expect(d.kind === 'allow' && d.reservedCredits).toBe(3);
  });
});

describe('a cache that is missing pieces', () => {
  it('allows without a duration cap when no projection knows the rate, and says so', () => {
    const d = run({ pricing: null, number: number({ rate_per_min: null, config_version: null }) });
    expect(d.kind).toBe('allow');
    if (d.kind !== 'allow') return;
    // No rate: the credit bound cannot be computed, so only the plan maximum applies.
    expect(d.rate).toBeNull();
    expect(d.maxCallDurationMs).toBe(600_000);
    expect(d.reservedCredits).toBe(0);
    expect(d.warnings).toContain('rate_unknown');
  });

  /**
   * The bug this pair exists for: the rate used to be read from `pricing:current` alone,
   * which carries the 60 s config TTL while `runtime-cache-refresh` runs every five
   * minutes. For most of every cycle there was no rate, and a decision without one
   * reserves nothing — so concurrent calls stopped subtracting each other's spend and a
   * workspace could run to several times the grace overdraft. The rate now rides in the
   * number record beside `plan_max_ms`, so both halves of the formula expire together.
   */
  it('sizes the call from the number record when pricing:current has expired', () => {
    const d = run({ pricing: null, balance: 3 });
    expect(d.kind).toBe('allow');
    if (d.kind !== 'allow') return;
    expect(d.rate).toBe(1);
    // 3 credits at 1 credit/min = 3 minutes, which is under the 10-minute plan maximum.
    expect(d.maxCallDurationMs).toBe(180_000);
    expect(d.reservedCredits).toBe(3);
    expect(d.warnings).not.toContain('rate_unknown');
  });

  it('keeps concurrent calls inside the grace when pricing:current has expired', () => {
    // Five slots, 20 credits, 10 grace: the cap alone would allow 5 × 10 min = 50 credits.
    const caps = { concurrency_cap: 5, grace_overdraft_credits: 10 } as WorkspaceCaps;
    const active: ActiveCall[] = [];
    let ceilingSpend = 0;
    for (let i = 0; i < 5; i += 1) {
      const d = run({ pricing: null, caps, balance: 20, callId: `call_${i}`, active: [...active] });
      if (d.kind !== 'allow') break;
      ceilingSpend += (d.maxCallDurationMs ?? 0) / 60_000;
      active.push({ callId: `call_${i}`, credits: d.reservedCredits, expiresAt: NOW.getTime() + 600_000 });
    }
    // Every allowed call talking to its own ceiling must still land inside balance + grace.
    expect(ceilingSpend).toBeLessThanOrEqual(30);
  });

  it('never divides by a zero or negative rate', () => {
    const d = run({ number: number({ rate_per_min: 0 }), pricing: pricing(0), balance: 5 });
    expect(d.kind === 'allow' && d.maxCallDurationMs).toBe(600_000);
    expect(d.kind === 'allow' && d.warnings).toContain('rate_unknown');
    const negative = run({ number: number({ rate_per_min: -2 }), pricing: pricing(-2), balance: 5 });
    expect(negative.kind === 'allow' && Number.isFinite(negative.maxCallDurationMs ?? 0)).toBe(true);
    expect(negative.kind === 'allow' && negative.warnings).toContain('rate_unknown');
  });

  it('allows when the balance is unknown rather than declining a paying customer', () => {
    const d = run({ balance: null });
    expect(d.kind).toBe('allow');
    if (d.kind !== 'allow') return;
    expect(d.warnings).toContain('balance_unknown');
    expect(d.available).toBeNull();
    // Unknown credits means no credit bound: the plan maximum is the only limit.
    expect(d.maxCallDurationMs).toBe(600_000);
  });

  it('allows when caps are unknown rather than guessing a concurrency limit', () => {
    const d = run({ caps: null, active: active(20, 0) });
    expect(d.kind).toBe('allow');
    if (d.kind !== 'allow') return;
    expect(d.warnings).toContain('caps_unknown');
  });

  it('still enforces the grace floor from the pricing snapshot when caps are missing', () => {
    expect(run({ caps: null, balance: -50 })).toMatchObject({ kind: 'decline', reason: 'balance' });
  });

  it('does not decline on balance when neither caps nor pricing knows the grace', () => {
    const d = run({ caps: null, pricing: null, balance: -50, number: number({ rate_per_min: null }) });
    expect(d.kind).toBe('allow');
    if (d.kind !== 'allow') return;
    expect(d.warnings).toEqual(expect.arrayContaining(['grace_unknown', 'caps_unknown', 'rate_unknown']));
  });

  it('records a missing plan maximum and a missing call id as warnings, not failures', () => {
    const d = run({ number: number({ plan_max_ms: null }), callId: null, balance: 5 });
    expect(d.kind).toBe('allow');
    if (d.kind !== 'allow') return;
    expect(d.warnings).toEqual(expect.arrayContaining(['plan_max_unknown', 'no_call_id']));
    // Only the credit bound is left: 5 credits at 1/min.
    expect(d.maxCallDurationMs).toBe(300_000);
  });

  it('allows with a warning when the schedule or its timezone is unusable', () => {
    const noSchedule = run({ number: number({ hours_mode: 'business', hours: null }) });
    expect(noSchedule).toMatchObject({ kind: 'allow' });
    expect(noSchedule.kind === 'allow' && noSchedule.warnings).toContain('hours_no_schedule');
    const badZone = run({ number: number({ hours_mode: 'custom', hours: { days: { wed: [] }, closed_dates: [] }, timezone: 'Not/AZone' }) });
    expect(badZone).toMatchObject({ kind: 'allow' });
    expect(badZone.kind === 'allow' && badZone.warnings).toContain('hours_invalid_timezone');
  });
});

describe('dynamic variables handed to the agent (§9.7)', () => {
  it('carries the business name, the agent name, the local time and the transfer targets', () => {
    const d = run({
      number: number({ hours_mode: 'business', hours: { days: { wed: [{ open: '09:00', close: '17:00' }] }, closed_dates: [] }, transfer_numbers: ['+14165551234', '+14165555678'] }),
    });
    expect(d.kind).toBe('allow');
    if (d.kind !== 'allow') return;
    expect(d.dynamicVariables).toMatchObject({
      business_name: 'Maple Dental',
      agent_name: 'Maya',
      business_open: 'true',
      current_time: '10:00',
      transfer_number_1: '+14165551234',
      transfer_number_2: '+14165555678',
    });
  });
});

describe('what the atomic reservation re-checks', () => {
  it('carries the cap and the balance ceiling the reservation must hold to', () => {
    const d = run({ balance: 40 });
    expect(d.kind).toBe('allow');
    if (d.kind !== 'allow') return;
    // reserved_others must stay below balance + grace (§5.4): 40 + 10.
    expect(d.balanceCeiling).toBe(50);
    expect(d.concurrencyCap).toBe(3);
  });

  it('leaves both null when the cache could not say, so the script skips those predicates', () => {
    const noBalance = run({ balance: null });
    expect(noBalance.kind === 'allow' && noBalance.balanceCeiling).toBeNull();
    const noCaps = run({ caps: null, pricing: null });
    expect(noCaps.kind === 'allow' && noCaps.concurrencyCap).toBeNull();
    expect(noCaps.kind === 'allow' && noCaps.balanceCeiling).toBeNull();
  });

  it('takes the grace from the pricing snapshot when caps are missing', () => {
    const d = run({ caps: null, balance: 5 });
    expect(d.kind === 'allow' && d.balanceCeiling).toBe(15);
  });
});

describe('the active:{ws} hash', () => {
  it('round-trips a reservation', () => {
    const expiresAt = Date.now() + 60_000;
    const encoded = encodeActive(12.345, expiresAt);
    const { live, stale } = parseActiveHash({ call_a: encoded }, Date.now());
    expect(stale).toEqual([]);
    expect(live).toEqual([{ callId: 'call_a', credits: 12.35, expiresAt: Math.round(expiresAt) }]);
  });

  it('drops entries past their expiry and reports them for cleanup', () => {
    const now = Date.now();
    const { live, stale } = parseActiveHash(
      { fresh: encodeActive(1, now + 1_000), expired: encodeActive(1, now - 1_000), junk: 'not-a-reservation', empty: '' },
      now,
    );
    expect(live.map((l) => l.callId)).toEqual(['fresh']);
    expect(stale.sort()).toEqual(['empty', 'expired', 'junk']);
  });

  it('is empty for a workspace with no live calls', () => {
    expect(parseActiveHash({}, Date.now())).toEqual({ live: [], stale: [] });
  });

  it('keeps a reservation alive for the call duration plus the slack', () => {
    const now = Date.now();
    const encoded = encodeActive(5, now + 600_000 + ACTIVE_SLACK_MS);
    expect(parseActiveHash({ c: encoded }, now + 600_000).live).toHaveLength(1);
    expect(parseActiveHash({ c: encoded }, now + 600_000 + ACTIVE_SLACK_MS + 1).live).toHaveLength(0);
  });
});
