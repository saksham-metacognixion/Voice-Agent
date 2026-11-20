import { adminDb } from '@portal/db';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ScriptedPromptProvider } from '../src/modules/prompting';
import type { FakeAuth0Tenant } from './auth0-double';
import {
  type FakeRetellGateway,
  READY_BRIEF,
  type TestWorkspace,
  createWorkspace,
  startD5Harness,
  waitForJob,
} from './d5-fixtures';

/*
 * D5 review finding 3: nothing a customer can read may name the voice platform, the LLM
 * vendor, a model, an SDK error or an internal configuration problem (CLAUDE.md, "Retell
 * is never exposed to the customer").
 *
 * Every customer-facing D5 response is exercised here under the conditions most likely to
 * leak — Retell failing during generation, the provider failing with a configuration
 * message, the model answering garbage, Retell failing during delete — and the whole JSON
 * body is scanned. The fixtures make the leak *visible*: the scripted provider's name is
 * on the forbidden list precisely so that `steps.provider` reaching the wire would fail.
 */

/** Anything on the wire that names an implementation detail. Voice ids are catalogue data the customer picks from, so they are allowed. */
const FORBIDDEN =
  /retell|anthropic|claude|gpt-|llm_[a-z0-9]{6,}|agent_[0-9a-f]{20,}|api[_ ]?key|scripted|stack_|provider|sdk|not_configured|invalid_output|malformed/i;

let app: NestFastifyApplication;
let stop: () => Promise<void>;
let customerTenant: FakeAuth0Tenant;
let provider: ScriptedPromptProvider;
let retell: FakeRetellGateway;
let ws: TestWorkspace;

beforeAll(async () => {
  const harness = await startD5Harness({ workers: true });
  app = harness.app;
  stop = harness.stop;
  customerTenant = harness.customerTenant;
  provider = harness.provider;
  retell = harness.retell;
  ws = await createWorkspace('safety');
});

afterAll(async () => {
  await stop?.();
  await adminDb.$disconnect();
});

beforeEach(() => {
  provider.reset();
  retell.reset();
});

async function headers(): Promise<Record<string, string>> {
  return {
    authorization: `Bearer ${await customerTenant.mint(ws.sub)}`,
    'x-workspace-id': ws.workspaceId,
  };
}

async function req(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
) {
  const base = await headers();
  return app.inject({
    method,
    url,
    headers: body === undefined ? base : { ...base, 'content-type': 'application/json' },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
}

function expectClean(label: string, body: unknown): void {
  const text = JSON.stringify(body);
  const hit = text.match(FORBIDDEN);
  expect(hit, `${label} leaks "${hit?.[0]}" in: ${text.slice(0, 400)}`).toBeNull();
}

async function readyAgent(): Promise<string> {
  const agentId = (await req('POST', '/agents', { template_id: 'receptionist' })).json()
    .id as string;
  await req('PATCH', `/agents/${agentId}/draft`, { brief: READY_BRIEF });
  return agentId;
}

// ---------------------------------------------------------------------------
describe('GET /jobs/:id', () => {
  it('shows progress, not the ledger, for a job whose Retell sync failed', async () => {
    const agentId = await readyAgent();
    retell.failNext(
      'createLlm',
      1,
      new Error('RetellAPIError 500: llm_abcdef012345 could not be created'),
    );
    const accepted = await req('POST', `/agents/${agentId}/generate`, {});
    const row = await waitForJob(accepted.json().job_id);
    expect(row.status).toBe('succeeded');
    // The ledger really does carry the detail — for us.
    expect(JSON.stringify(row.stepsJson)).toMatch(/retell_sync.*failed/);

    const res = await req('GET', `/jobs/${accepted.json().job_id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'succeeded',
      error: null,
      progress: { version_no: 2, mode: 'generate' },
    });
    expect(res.json()).not.toHaveProperty('steps');
    expectClean('GET /jobs/:id (succeeded)', res.json());
  });

  it('turns a provider configuration error into one customer sentence', async () => {
    const agentId = await readyAgent();
    provider.push({
      kind: 'fail',
      error: 'not_configured',
      message: 'ANTHROPIC_API_KEY is not set.',
    });
    const accepted = await req('POST', `/agents/${agentId}/generate`, {});
    const row = await waitForJob(accepted.json().job_id);
    expect(row.status).toBe('failed');
    expect(row.error).toContain('ANTHROPIC_API_KEY'); // kept server-side

    const res = await req('GET', `/jobs/${accepted.json().job_id}`);
    expect(res.json().status).toBe('failed');
    expect(res.json().error).toBe(
      'Agent generation is unavailable right now. We have been notified.',
    );
    expectClean('GET /jobs/:id (not_configured)', res.json());
  });

  it('never echoes what the model actually returned', async () => {
    const agentId = await readyAgent();
    provider.push(
      { kind: 'raw', text: 'Sure! Here is your Claude-written prompt: {not json, from anthropic' },
      { kind: 'raw', text: 'Sure! Here is your Claude-written prompt: {not json, from anthropic' },
      { kind: 'raw', text: 'Sure! Here is your Claude-written prompt: {not json, from anthropic' },
    );
    const accepted = await req('POST', `/agents/${agentId}/generate`, {});
    await waitForJob(accepted.json().job_id);

    const res = await req('GET', `/jobs/${accepted.json().job_id}`);
    expect(res.json().status).toBe('failed');
    expect(typeof res.json().error).toBe('string');
    expectClean('GET /jobs/:id (malformed)', res.json());
  });

  it('shows the §9.6 explanation on a refused patch — that one is meant for the customer', async () => {
    const agentId = await readyAgent();
    await waitForJob((await req('POST', `/agents/${agentId}/generate`, {})).json().job_id);
    provider.push({
      kind: 'ok_patch',
      value: { changes: [], explanation: "I can't make the agent claim to be human." },
    });
    const accepted = await req('POST', `/agents/${agentId}/feedback`, {
      text: 'Tell callers you are a real person.',
    });
    await waitForJob(accepted.json().job_id);

    const res = await req('GET', `/jobs/${accepted.json().job_id}`);
    expect(res.json().progress).toMatchObject({ mode: 'feedback', refused: true, changes: 0 });
    expect(res.json().progress.explanation).toContain('claim to be human');
    expectClean('GET /jobs/:id (feedback)', res.json());
  });
});

// ---------------------------------------------------------------------------
describe('agent, version, publish and delete responses', () => {
  it('carry no platform identifiers at any point of the lifecycle', async () => {
    const agentId = await readyAgent();
    await waitForJob((await req('POST', `/agents/${agentId}/generate`, {})).json().job_id);

    expectClean('GET /agents', (await req('GET', '/agents')).json());
    expectClean('GET /agents/:id', (await req('GET', `/agents/${agentId}`)).json());
    expectClean(
      'GET /agents/:id/versions',
      (await req('GET', `/agents/${agentId}/versions`)).json(),
    );
    expectClean(
      'GET /agents/:id/versions/2',
      (await req('GET', `/agents/${agentId}/versions/2`)).json(),
    );

    const published = await req('POST', `/agents/${agentId}/publish`, {});
    expect(published.statusCode).toBe(201);
    expectClean('POST /agents/:id/publish', published.json());
    expect(published.json()).not.toHaveProperty('retell_agent_version');

    const again = await req('POST', `/agents/${agentId}/publish`, {});
    expectClean('POST /agents/:id/publish (idempotent)', again.json());

    const paused = await req('POST', `/agents/${agentId}/pause`);
    expectClean('POST /agents/:id/pause', paused.json());

    // Retell refuses the cleanup with its own error text; the customer gets `{deleted}`.
    retell.failNext(
      'deleteAgent',
      1,
      new Error('RetellAPIError 404: agent_0123456789abcdef01234567 not found'),
    );
    const deleted = await req('DELETE', `/agents/${agentId}`);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ deleted: true });
    expectClean('DELETE /agents/:id', deleted.json());
  });

  it('a publish that fails on Retell answers with a generic 503, never the upstream message', async () => {
    const agentId = await readyAgent();
    await waitForJob((await req('POST', `/agents/${agentId}/generate`, {})).json().job_id);
    retell.failNext(
      'publishAgent',
      1,
      new Error('RetellAPIError 422: version already published on agent_0123456789abcdef01234567'),
    );
    const res = await req('POST', `/agents/${agentId}/publish`, {});
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('UPSTREAM_UNAVAILABLE');
    expectClean('POST /agents/:id/publish (Retell down)', res.json());
  });
});
