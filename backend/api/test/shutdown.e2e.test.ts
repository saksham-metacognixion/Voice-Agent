import { adminDb } from '@portal/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestHarness, createCallWorkspace, startHarness } from './calls-fixtures';

/**
 * The API must be able to stop while a dashboard holds `GET /events` open. Fastify's close
 * forces only *idle* connections, and a hijacked SSE response is never idle: before the
 * events controller ended its streams on shutdown, one open tab kept the old process alive
 * for ever, and the `nest --watch` restart (dev) or the graceful stop (deploy) behind it.
 */
let harness: TestHarness;

beforeAll(async () => {
  harness = await startHarness({ listen: true, workers: false });
});

afterAll(async () => {
  await harness.customerTenant.stop();
  await harness.staffTenant.stop();
  await adminDb.$disconnect();
});

describe('app.close() with an open SSE stream', () => {
  it('ends the stream and finishes instead of waiting on it for ever', async () => {
    const ws = await createCallWorkspace('shutdown');
    const baseUrl = await harness.app.getUrl();
    const headers = { authorization: `Bearer ${await harness.customerTenant.mint(ws.sub)}`, 'x-workspace-id': ws.tenantId };

    const response = await fetch(`${baseUrl}/events`, { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('retry: 3000');

    const outcome = await Promise.race([
      harness.app.close().then(() => 'closed' as const),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 8_000)),
    ]);
    expect(outcome).toBe('closed');

    // The client saw the end of the stream (fetch-event-source then reconnects on `retry`).
    const rest = await Promise.race([
      (async () => {
        for (;;) {
          const { done } = await reader.read();
          if (done) return 'ended' as const;
        }
      })(),
      new Promise<'open'>((resolve) => setTimeout(() => resolve('open'), 2_000)),
    ]);
    expect(rest).toBe('ended');
  }, 20_000);
});
