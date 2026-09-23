import Retell from 'retell-sdk';
import { describe, expect, it } from 'vitest';

/**
 * The platform ends support for `/v2/create-web-call` on 30 Sep 2026 and flags any v2
 * `list-calls` traffic. retell-sdk 6 already posts both to `/v3`; this pins it, so an
 * SDK downgrade or a hand-rolled request fails here instead of in a Monday notice.
 */
describe('retell-sdk endpoints the gateway depends on', () => {
  function recorder() {
    const paths: string[] = [];
    const client = new Retell({
      apiKey: 'test',
      maxRetries: 0,
      fetch: (async (input: string | URL | Request) => {
        paths.push(new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname);
        return new Response(JSON.stringify({ has_more: false, items: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    });
    return { client, paths };
  }

  it('creates web calls on /v3/create-web-call', async () => {
    const { client, paths } = recorder();
    await client.call.createWebCall({ agent_id: 'agent_x' });
    expect(paths).toEqual(['/v3/create-web-call']);
  });

  it('lists calls on /v3/list-calls', async () => {
    const { client, paths } = recorder();
    await client.call.list({ limit: 1 });
    expect(paths).toEqual(['/v3/list-calls']);
  });
});
