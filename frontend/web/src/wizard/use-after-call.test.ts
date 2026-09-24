import { describe, expect, it } from 'vitest';
import { ANALYSIS_WAIT_MS, pollDelay } from './use-after-call';

describe('pollDelay', () => {
  it('backs off 5 s, 10 s, 20 s, then holds at 30 s', () => {
    expect([0, 1, 2, 3, 4, 10].map(pollDelay)).toEqual([5_000, 10_000, 20_000, 30_000, 30_000, 30_000]);
  });

  it('keeps a whole analysis wait to a couple of dozen requests', () => {
    let elapsed = 0;
    let requests = 0;
    while (elapsed + pollDelay(requests) <= ANALYSIS_WAIT_MS) elapsed += pollDelay(requests++);
    expect(requests).toBeLessThanOrEqual(25);
  });
});
