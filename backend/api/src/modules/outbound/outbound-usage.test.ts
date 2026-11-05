import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UNCONFIRMED_ATTEMPT_MS, unconfirmedBefore, usedOn } from './outbound-usage';

/* D18 / QA-086: the one count of today's outbound use — what the cap is judged against. */

const NOW = new Date('2026-11-04T15:00:00Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('unconfirmedBefore', () => {
  it('is five minutes before now', () => {
    expect(UNCONFIRMED_ATTEMPT_MS).toBe(300_000);
    expect(unconfirmedBefore().toISOString()).toBe('2026-11-04T14:55:00.000Z');
  });
});

describe('usedOn', () => {
  it('counts placed attempts and pending ones that have a call or are still fresh, for that workspace and local day', async () => {
    const count = vi.fn().mockResolvedValue(3);
    await expect(usedOn({ outboundCall: { count } } as never, 'ws-1', '2026-11-04')).resolves.toBe(3);
    expect(count).toHaveBeenCalledWith({
      where: {
        tenantId: 'ws-1',
        localDay: new Date('2026-11-04T00:00:00Z'),
        OR: [
          { status: 'placed' },
          { status: 'pending', OR: [{ callId: { not: null } }, { updatedAt: { gte: new Date('2026-11-04T14:55:00Z') } }] },
        ],
      },
    });
  });

  it('never counts failed attempts (a provider 4xx frees the slot)', async () => {
    const count = vi.fn().mockResolvedValue(0);
    await usedOn({ outboundCall: { count } } as never, 'ws-1', '2026-11-04');
    const statuses = JSON.stringify(count.mock.calls[0]![0]);
    expect(statuses).not.toContain('failed');
  });
});
