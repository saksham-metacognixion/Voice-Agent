import { describe, expect, it } from 'vitest';
import { resendDecision } from './account.service';

/** §6.3 A2 "Resend code (60-s cooldown, max 5/hour)" — ADR 0036 §8. */
describe('resendDecision', () => {
  const hour = 3_600_000;
  const now = 100 * hour + 10 * 60_000; // ten minutes into a clock hour

  it('allows the first send', () => {
    expect(resendDecision({ now, cooldownStartedAt: null, sentThisHour: 1 })).toEqual({ allow: true });
  });

  it('refuses inside the 60 seconds and says how long is left', () => {
    expect(resendDecision({ now, cooldownStartedAt: now - 1_000, sentThisHour: 0 })).toEqual({ allow: false, retryAfterS: 59 });
    expect(resendDecision({ now, cooldownStartedAt: now - 59_500, sentThisHour: 0 })).toEqual({ allow: false, retryAfterS: 1 });
  });

  it('allows once the 60 seconds have passed', () => {
    expect(resendDecision({ now, cooldownStartedAt: now - 60_000, sentThisHour: 2 })).toEqual({ allow: true });
  });

  it('allows the fifth send in an hour and refuses the sixth until the hour turns', () => {
    expect(resendDecision({ now, cooldownStartedAt: null, sentThisHour: 5 })).toEqual({ allow: true });
    expect(resendDecision({ now, cooldownStartedAt: null, sentThisHour: 6 })).toEqual({ allow: false, retryAfterS: 50 * 60 });
  });
});
