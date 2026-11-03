import Retell from 'retell-sdk';
import { describe, expect, it } from 'vitest';

/**
 * The platform ended support for `/v2/create-web-call` on 30 Sep 2026 and removed the
 * legacy list endpoints on 15 Jun 2026 (docs.retellai.com/deprecation-notice/2026/
 * 06-15_legacy_list_endpoints): requests to them now fail. retell-sdk 6 already sends
 * every replacement; this pins it, so an SDK downgrade or a hand-rolled request fails
 * here instead of in a notice from the platform.
 */
describe('retell-sdk endpoints the gateway depends on', () => {
  function recorder() {
    const requests: string[] = [];
    const client = new Retell({
      apiKey: 'test',
      maxRetries: 0,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        requests.push(`${(init?.method ?? 'GET').toUpperCase()} ${url.pathname}`);
        return new Response(JSON.stringify({ has_more: false, items: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    });
    return { client, requests };
  }

  it('creates web calls on /v3/create-web-call', async () => {
    const { client, requests } = recorder();
    await client.call.createWebCall({ agent_id: 'agent_x' });
    expect(requests).toEqual(['POST /v3/create-web-call']);
  });

  // The migration guide's table, legacy → replacement. Calls and chats move to /v3, the
  // rest to /v2; chats also change method.
  const replacements: Array<[string, string, (c: Retell) => Promise<unknown>]> = [
    ['POST /v2/list-calls', 'POST /v3/list-calls', (c) => c.call.list({ limit: 1 })],
    ['GET /list-chat', 'POST /v3/list-chats', (c) => c.chat.list()],
    ['GET /list-phone-numbers', 'GET /v2/list-phone-numbers', (c) => c.phoneNumber.list()],
    ['GET /list-retell-llms', 'GET /v2/list-retell-llms', (c) => c.llm.list()],
    ['GET /list-conversation-flows', 'GET /v2/list-conversation-flows', (c) => c.conversationFlow.list()],
    ['GET /list-conversation-flow-components', 'GET /v2/list-conversation-flow-components', (c) => c.conversationFlowComponent.list()],
    ['GET /list-test-runs/{id}', 'GET /v2/list-test-runs/batch_1', (c) => c.tests.listTestRuns('batch_1')],
    ['GET /list-batch-tests', 'GET /v2/list-batch-tests', (c) => c.tests.listBatchTests({ type: 'retell-llm', llm_id: 'llm_1' } as never)],
    ['GET /list-test-case-definitions', 'GET /v2/list-test-case-definitions', (c) => c.tests.listTestCaseDefinitions({ type: 'retell-llm', llm_id: 'llm_1' } as never)],
  ];

  it.each(replacements)('replaces %s with %s', async (_legacy, replacement, call) => {
    const { client, requests } = recorder();
    await call(client);
    expect(requests).toEqual([replacement]);
  });

  it('sends nothing to a removed legacy list path', async () => {
    const { client, requests } = recorder();
    for (const [, , call] of replacements) await call(client);
    const legacy = /^(GET|POST) \/(v2\/list-calls|list-chat|list-phone-numbers|list-retell-llms|list-conversation-flows|list-conversation-flow-components|list-test-runs|list-batch-tests|list-test-case-definitions)\b/;
    expect(requests.filter((r) => legacy.test(r))).toEqual([]);
  });
});
