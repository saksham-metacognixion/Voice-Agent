import type { CallListResponse } from 'retell-sdk/resources/call';
import { describe, expect, it } from 'vitest';
import { callListPage, providerCallFacts } from './retell.gateway';

/**
 * `list-calls` pages are `{has_more, items, pagination_key}` in retell-sdk 6. The
 * reconciliation used to read the response as a bare array, so every night the provider
 * "had" zero calls and every row in `calls` was drift. The type annotation below is the
 * pin: if the SDK changes shape, this file stops compiling before the job lies again.
 */
describe('callListPage (§14.2 reconcile-calls)', () => {
  const call = (id: string): CallListResponse.V3PhoneCallResponse =>
    ({
      call_id: id,
      call_type: 'phone_call',
      agent_id: 'agent_x',
      call_status: 'ended',
      start_timestamp: 1_000,
      end_timestamp: 61_000,
      metadata: { tenant_id: 'ws_1' },
    }) as unknown as CallListResponse.V3PhoneCallResponse;

  it('reads items, has_more and the cursor from the SDK shape', () => {
    const page: CallListResponse = { has_more: true, items: [call('a'), call('b')], pagination_key: 'b' };
    expect(callListPage(page)).toEqual({ items: page.items, hasMore: true, paginationKey: 'b' });
    expect(callListPage({ has_more: false, items: [] } satisfies CallListResponse)).toEqual({ items: [], hasMore: false, paginationKey: undefined });
  });

  it('refuses anything that is not a page instead of reporting zero calls', () => {
    expect(() => callListPage([call('a')])).toThrow(/items array/);
    expect(() => callListPage(undefined)).toThrow(/not a page/);
    expect(() => callListPage({ has_more: false })).toThrow(/items array/);
  });

  it('reduces a page item to the facts the reconciliation compares', () => {
    expect(providerCallFacts(call('a'))).toMatchObject({ call_id: 'a', call_type: 'phone_call', duration_s: 60, workspace_id: 'ws_1' });
  });
});
