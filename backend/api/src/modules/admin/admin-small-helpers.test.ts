import { describe, expect, it } from 'vitest';
import { redisDownPolicy } from '../calls/inbound.service';
import { JOBS } from '../jobs';
import { refundKey } from './admin-calls.service';
import { retryPayload } from './admin-jobs.service';
import { ticketParam } from './admin-support.service';

/* Small rules behind SA4 / SA7 / SA8 and the §13.9 Redis-down switch. */

describe('redisDownPolicy (ADR 0003 §12)', () => {
  it.each([
    [undefined, 'open'],
    ['', 'open'],
    ['open', 'open'],
    ['closed', 'closed'],
    [' CLOSED ', 'closed'],
    ['reject', 'open'],
  ])('INBOUND_REDIS_DOWN_POLICY=%j → %s (fail open unless explicitly closed)', (value, expected) => {
    expect(redisDownPolicy({ INBOUND_REDIS_DOWN_POLICY: value } as NodeJS.ProcessEnv)).toBe(expected);
  });
});

describe('refundKey (SA8 call refund, once per call)', () => {
  it('is a stable uuid for one (workspace, call)', () => {
    const key = refundKey('ws-1', 'call_1');
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(refundKey('ws-1', 'call_1')).toBe(key);
  });

  it('differs per call and per workspace', () => {
    expect(refundKey('ws-1', 'call_2')).not.toBe(refundKey('ws-1', 'call_1'));
    expect(refundKey('ws-2', 'call_1')).not.toBe(refundKey('ws-1', 'call_1'));
  });
});

describe('ticketParam (SA4 ticket ids are positive integers)', () => {
  it.each([
    ['42', 42],
    [42, 42],
    ['1', 1],
    ['999999999', 999_999_999],
  ])('%j → %i', (raw, expected) => {
    expect(ticketParam(raw)).toBe(expected);
  });

  it.each(['0', '-1', '1.5', 'abc', '', '1e3', '1234567890', ' 42', 0, -3, 1.5, Number.NaN])('%j is a 404', (raw) => {
    expect(() => ticketParam(raw)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });
});

describe('retryPayload (SA7 staff retry)', () => {
  const base = { id: 'job-1', type: JOBS.activateAgent, tenantId: 'ws-1', payloadJson: null, stepsJson: null };

  it('uses the payload the enqueue site kept', () => {
    expect(retryPayload({ ...base, type: 'knowledge-sync', payloadJson: { sourceId: 's-1' } })).toEqual({ sourceId: 's-1' });
  });

  it('rebuilds an old activation row’s payload from steps_json', () => {
    expect(retryPayload({ ...base, stepsJson: { agent_id: 'a-1', requested_by: 'u-1', version_no: 3 } })).toEqual({
      jobId: 'job-1',
      workspaceId: 'ws-1',
      agentId: 'a-1',
      userId: 'u-1',
      versionNo: 3,
    });
  });

  it('a missing requester is null and a missing version is left out', () => {
    expect(retryPayload({ ...base, stepsJson: { agent_id: 'a-1' } })).toEqual({ jobId: 'job-1', workspaceId: 'ws-1', agentId: 'a-1', userId: null });
  });

  it('cannot rebuild without an agent id, a workspace, or for another job type', () => {
    expect(retryPayload({ ...base, stepsJson: {} })).toBeNull();
    expect(retryPayload({ ...base, tenantId: null, stepsJson: { agent_id: 'a-1' } })).toBeNull();
    expect(retryPayload({ ...base, type: 'knowledge-sync', stepsJson: { agent_id: 'a-1' } })).toBeNull();
  });

  it('an empty kept payload falls through to the rebuild', () => {
    expect(retryPayload({ ...base, payloadJson: {}, stepsJson: { agent_id: 'a-1' } })).toMatchObject({ agentId: 'a-1' });
  });
});
