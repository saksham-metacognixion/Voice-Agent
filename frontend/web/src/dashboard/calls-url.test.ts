import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW, callsQueryFor, rangeFrom, readCallsView, writeCallsView } from './calls-url';

describe('calls URL state', () => {
  it('round-trips a view through the query string and drops defaults', () => {
    const params = new URLSearchParams();
    writeCallsView(params, { ...DEFAULT_VIEW, status: 'missed', agentId: '11111111-1111-4111-8111-111111111111', test: false, sort: 'duration_s', order: 'asc', range: '7d', callId: 'call_x' });
    expect(params.toString()).toBe('status=missed&agent=11111111-1111-4111-8111-111111111111&test=false&range=7d&sort=duration_s&order=asc&call=call_x');
    expect(readCallsView(params)).toMatchObject({ status: 'missed', test: false, sort: 'duration_s', order: 'asc', range: '7d', callId: 'call_x' });
    const empty = new URLSearchParams();
    writeCallsView(empty, DEFAULT_VIEW);
    expect(empty.toString()).toBe('');
  });

  it('carries the page number with the cursor, and never without one', () => {
    const params = new URLSearchParams();
    writeCallsView(params, { ...DEFAULT_VIEW, cursor: 'abc', page: 3 });
    expect(params.toString()).toBe('cursor=abc&page=3');
    expect(readCallsView(params)).toMatchObject({ cursor: 'abc', page: 3 });
    // A pasted cursor with no page is at least the second page; a page with no cursor is the first.
    expect(readCallsView(new URLSearchParams('cursor=abc'))).toMatchObject({ cursor: 'abc', page: 2 });
    expect(readCallsView(new URLSearchParams('cursor=abc&page=x'))).toMatchObject({ page: 2 });
    expect(readCallsView(new URLSearchParams('page=4'))).toMatchObject({ cursor: null, page: 1 });
    const first = new URLSearchParams();
    writeCallsView(first, { ...DEFAULT_VIEW, page: 4 });
    expect(first.toString()).toBe('');
  });

  it('ignores malformed values instead of sending them to the API', () => {
    const view = readCallsView(new URLSearchParams('status=exploded&agent=not-a-uuid&sort=nope&order=sideways&range=1y'));
    expect(view).toEqual(DEFAULT_VIEW);
  });

  it('computes the range bound in the workspace timezone', () => {
    const now = new Date('2026-09-24T13:00:00Z');
    expect(rangeFrom('today', 'America/Toronto', now)).toBe('2026-09-24T04:00:00.000Z');
    expect(rangeFrom('7d', 'America/Toronto', now)).toBe('2026-09-18T04:00:00.000Z');
    expect(rangeFrom('all', 'America/Toronto', now)).toBeUndefined();
    const q = callsQueryFor({ ...DEFAULT_VIEW, range: 'today', test: false }, 'America/Toronto', now);
    expect(q).toMatchObject({ limit: 25, from: '2026-09-24T04:00:00.000Z', is_test: 'false', sort: 'started_at', order: 'desc' });
  });
});
