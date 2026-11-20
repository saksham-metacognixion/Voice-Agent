import Retell from 'retell-sdk';
import { describe, expect, it } from 'vitest';
import { RetellConfig } from './retell.config';
import { LIST_CALLS_PAGE, RetellGateway, listPage, pageThrough } from './retell.gateway';

/**
 * The versioned list endpoints answer `{items, has_more, pagination_key}` pages. These
 * drive the gateway through the real SDK with a stubbed transport, so the request the
 * platform would see (path, query, body) is what is asserted.
 */
const env = { RETELL_API_KEY: 'key_test_0123456789abcdef', API_PUBLIC_URL: 'https://api.example.test/', APP_ENV: 'dev' };

interface Seen {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown> | null;
}

function gatewayAnswering(answer: (req: Seen, n: number) => Response | Promise<Response>, maxRetries = 0) {
  const seen: Seen[] = [];
  const gw = new RetellGateway(new RetellConfig(env));
  const sdk = new Retell({
    apiKey: env.RETELL_API_KEY,
    maxRetries,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const req: Seen = {
        method: (init?.method ?? 'GET').toUpperCase(),
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      };
      seen.push(req);
      return answer(req, seen.length);
    }) as typeof fetch,
  });
  (gw as unknown as { sdk: Retell }).sdk = sdk;
  return { gw, seen };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const number = (e164: string, nickname = `dev-num-${e164.slice(-4)}`) => ({ phone_number: e164, phone_number_type: 'retell-twilio', nickname });
const call = (id: string) => ({ call_id: id, call_type: 'phone_call', call_status: 'ended', start_timestamp: 1_000, end_timestamp: 61_000, metadata: { tenant_id: 'ws_1' } });

describe('listPage', () => {
  it('reads a page and treats optional pagination fields as absent', () => {
    expect(listPage('x', { items: [1] })).toEqual({ items: [1], hasMore: false, paginationKey: undefined });
    expect(listPage('x', { items: [], has_more: null, pagination_key: '' })).toEqual({ items: [], hasMore: false, paginationKey: undefined });
  });

  it('refuses a top-level array or a body without items, naming the endpoint', () => {
    expect(() => listPage('list-phone-numbers', [number('+15550000001')])).toThrow(/list-phone-numbers answered without an items array/);
    expect(() => listPage('list-phone-numbers', null)).toThrow(/null, not a page/);
  });
});

describe('pageThrough', () => {
  it('stops on has_more false, an empty page, a missing key or a key that did not move', async () => {
    const stops = [
      { has_more: false, items: [1], pagination_key: 'k' },
      { has_more: true, items: [], pagination_key: 'k' },
      { has_more: true, items: [1] },
    ];
    for (const page of stops) {
      let calls = 0;
      const out = await pageThrough('x', async () => (calls++, page), 5);
      expect([calls, out.partial]).toEqual([1, false]);
    }
    let calls = 0;
    const stuck = await pageThrough('x', async () => (calls++, { has_more: true, items: [calls], pagination_key: 'same' }), 5);
    expect([calls, stuck.items, stuck.partial]).toEqual([2, [1, 2], false]);
  });

  it('reports partial at the page cap instead of looping', async () => {
    let n = 0;
    const out = await pageThrough('x', async () => ({ has_more: true, items: [++n], pagination_key: `k${n}` }), 3);
    expect(out).toEqual({ items: [1, 2, 3], partial: true });
  });

  it('propagates an error mid-walk rather than answering with the pages so far', async () => {
    let n = 0;
    await expect(
      pageThrough('x', async () => {
        if (++n === 2) throw new Error('retell answered 500');
        return { has_more: true, items: [n], pagination_key: `k${n}` };
      }, 5),
    ).rejects.toThrow(/500/);
  });
});

describe('RetellGateway.listPhoneNumbers (GET /v2/list-phone-numbers)', () => {
  it('reads a single page from items', async () => {
    const { gw, seen } = gatewayAnswering(() => json({ has_more: false, items: [number('+15550000001')] }));
    expect((await gw.listPhoneNumbers()).map((n) => n.phone_number)).toEqual(['+15550000001']);
    expect(seen.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /v2/list-phone-numbers']);
    expect(seen[0]?.query).toEqual({});
  });

  it('walks every page by pagination_key and combines them without duplicates', async () => {
    const pages = [
      { has_more: true, items: [number('+15550000001'), number('+15550000002')], pagination_key: '+15550000002' },
      { has_more: true, items: [number('+15550000002'), number('+15550000003')], pagination_key: '+15550000003' },
      { has_more: false, items: [number('+15550000004')] },
    ];
    const { gw, seen } = gatewayAnswering((_req, n) => json(pages[n - 1]));
    expect((await gw.listPhoneNumbers()).map((n) => n.phone_number)).toEqual(['+15550000001', '+15550000002', '+15550000003', '+15550000004']);
    expect(seen.map((r) => r.query.pagination_key)).toEqual([undefined, '+15550000002', '+15550000003']);
    expect(seen.every((r) => r.path === '/v2/list-phone-numbers')).toBe(true);
  });

  it('answers [] for an empty account', async () => {
    const { gw } = gatewayAnswering(() => json({ has_more: false, items: [] }));
    expect(await gw.listPhoneNumbers()).toEqual([]);
  });

  it('throws rather than answer from an incomplete list at the page cap', async () => {
    const { gw } = gatewayAnswering((_req, n) => json({ has_more: true, items: [number(`+1555000000${n}`)], pagination_key: `k${n}` }));
    await expect(gw.listPhoneNumbers(3)).rejects.toThrow(/incomplete list/);
  });

  it('refuses the legacy array shape instead of reading it as numbers', async () => {
    const { gw } = gatewayAnswering(() => json([number('+15550000001')]));
    await expect(gw.listPhoneNumbers()).rejects.toThrow(/items array/);
  });

  it('retries a 429 through the SDK and then fails loudly if it persists', async () => {
    const once = gatewayAnswering((_req, n) => (n === 1 ? json({ error: 'slow down' }, 429, { 'retry-after-ms': '0' }) : json({ has_more: false, items: [number('+15550000001')] })), 1);
    expect(await once.gw.listPhoneNumbers()).toHaveLength(1);
    expect(once.seen).toHaveLength(2);

    const always = gatewayAnswering(() => json({ error: 'slow down' }, 429, { 'retry-after-ms': '0' }), 1);
    await expect(always.gw.listPhoneNumbers()).rejects.toMatchObject({ status: 429 });
  });
});

describe('RetellGateway.listCallsInWindow (POST /v3/list-calls)', () => {
  it('keeps the window filter, sort and page size on every page and dedupes across pages', async () => {
    const pages = [
      { has_more: true, items: [call('a'), call('b')], pagination_key: 'b' },
      { has_more: false, items: [call('b'), call('c')] },
    ];
    const { gw, seen } = gatewayAnswering((_req, n) => json(pages[n - 1]));
    const out = await gw.listCallsInWindow(1_000, 2_000);
    expect(out.partial).toBe(false);
    expect(out.calls.map((c) => c.call_id)).toEqual(['a', 'b', 'c']);
    expect(seen.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /v3/list-calls', 'POST /v3/list-calls']);
    for (const r of seen) {
      expect(r.body).toMatchObject({
        filter_criteria: { start_timestamp: { op: 'bt', type: 'range', value: [1_000, 2_000] } },
        sort_order: 'descending',
        limit: LIST_CALLS_PAGE,
      });
    }
    expect([seen[0]?.body?.pagination_key, seen[1]?.body?.pagination_key]).toEqual([undefined, 'b']);
  });

  it('answers an empty window as zero calls, not partial', async () => {
    const { gw } = gatewayAnswering(() => json({ has_more: false, items: [] }));
    expect(await gw.listCallsInWindow(1_000, 2_000)).toEqual({ calls: [], partial: false });
  });

  it('records the window as partial at the page cap', async () => {
    const { gw } = gatewayAnswering((_req, n) => json({ has_more: true, items: [call(`c${n}`)], pagination_key: `c${n}` }));
    const out = await gw.listCallsInWindow(1_000, 2_000, 2);
    expect(out).toMatchObject({ partial: true });
    expect(out.calls).toHaveLength(2);
  });

  it('fails the run on a provider error rather than reporting zero calls', async () => {
    const { gw } = gatewayAnswering(() => json({ error: 'boom' }, 500));
    await expect(gw.listCallsInWindow(1_000, 2_000)).rejects.toMatchObject({ status: 500 });
  });
});
