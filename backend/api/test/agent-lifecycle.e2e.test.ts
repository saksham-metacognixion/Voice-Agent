import { randomUUID } from 'node:crypto';
import { adminDb } from '@portal/db';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GUARDRAIL_HEADING } from '../src/modules/prompting';
import type { ScriptedPromptProvider } from '../src/modules/prompting';
import { VoicesService } from '../src/modules/voices';
import { WalletService } from '../src/modules/wallet';
import type { FakeAuth0Tenant } from './auth0-double';
import {
  type FakeRetellGateway,
  READY_BRIEF,
  createUser,
  createWorkspace,
  startD5Harness,
  waitFor,
  waitForJob,
} from './d5-fixtures';

/*
 * The D5 exit check, run as one story and then picked apart:
 *
 *   user → workspace → trial credits → agent from a template → brief → generate
 *     → 202 + job_id → worker → Anthropic-shaped answer → zod → guardrails → lint
 *     → version → SSE → select → publish → Retell version → SSE
 *
 * The SSE half runs against a real HTTP port, because `GET /events` hijacks the Fastify
 * reply and `app.inject()` cannot hold a stream open.
 */

let app: NestFastifyApplication;
let stop: () => Promise<void>;
let customerTenant: FakeAuth0Tenant;
let retell: FakeRetellGateway;
let provider: ScriptedPromptProvider;
let baseUrl = '';

beforeAll(async () => {
  const harness = await startD5Harness({ listen: true, workers: true });
  app = harness.app;
  stop = harness.stop;
  customerTenant = harness.customerTenant;
  retell = harness.retell;
  provider = harness.provider;
  baseUrl = await app.getUrl();
  await app.get(VoicesService).refreshCache();
});

afterAll(async () => {
  await stop?.();
  await adminDb.$disconnect();
});

async function authHeaders(sub: string, workspaceId?: string): Promise<Record<string, string>> {
  return {
    authorization: `Bearer ${await customerTenant.mint(sub)}`,
    ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}),
  };
}

async function call(
  method: string,
  path: string,
  auth: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.inject({
    method: method as 'GET',
    url: path,
    headers: body === undefined ? auth : { ...auth, 'content-type': 'application/json' },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.statusCode, body: res.body ? (res.json() as Record<string, unknown>) : {} };
}

/**
 * Opens `GET /events` and collects frames until `stop()` is called. Uses fetch rather
 * than EventSource for the same reason the portal does: `EventSource` cannot send
 * `Authorization` or `X-Workspace-Id` (CLAUDE.md).
 */
async function openStream(auth: Record<string, string>, topics?: string) {
  const controller = new AbortController();
  const frames: Array<{ topic: string; type: string; data: Record<string, unknown> }> = [];
  const url = `${baseUrl}/events${topics ? `?topics=${encodeURIComponent(topics)}` : ''}`;

  const response = await fetch(url, { headers: { ...auth, accept: 'text/event-stream' }, signal: controller.signal });
  if (!response.ok || !response.body) throw new Error(`SSE open failed: ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() ?? '';
        for (const chunk of chunks) {
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          const event = JSON.parse(line.slice(6)) as { topic: string; type: string; data: Record<string, unknown> };
          frames.push(event);
        }
      }
    } catch {
      // Aborted by the test.
    }
  })();

  return {
    frames,
    waitForType: (type: string, timeoutMs = 15_000) =>
      waitFor(`an SSE frame of type ${type}`, async () => frames.find((f) => f.type === type) ?? null, timeoutMs),
    close: async () => {
      controller.abort();
      await pump;
    },
  };
}

// ---------------------------------------------------------------------------
describe('the whole D5 flow, once, in order', () => {
  it('goes from a signed-up user to a published agent on Retell', async () => {
    // ---- 1. a user, as the Auth0 webhook would have left them
    const user = await createUser('flow');
    const noWorkspace = await authHeaders(user.sub);

    // ---- 2. the workspace, with its trial credits
    const created = await call('POST', '/workspaces', noWorkspace, {
      name: `Flow Clinic ${randomUUID().slice(0, 6)}`,
      country: 'CA',
      timezone: 'America/Toronto',
    });
    expect(created.status).toBe(201);
    const workspaceId = created.body.id as string;
    const auth = await authHeaders(user.sub, workspaceId);

    expect(await app.get(WalletService).balance(workspaceId)).toBe(20);
    expect((await call('GET', '/members', auth)).body).toHaveLength(1);

    // ---- 3. the SSE stream the wizard holds open while it works
    const stream = await openStream(auth);

    try {
      // ---- 4. an agent from a template
      const agent = await call('POST', '/agents', auth, { template_id: 'receptionist', industry: 'dental' });
      expect(agent.status).toBe(201);
      const agentId = agent.body.id as string;
      expect(agent.body.draft_version).toBe(1);

      // ---- 5. the brief, autosaved
      const patched = await call('PATCH', `/agents/${agentId}/draft`, auth, {
        brief: READY_BRIEF,
        voice_id: '11labs-Adrian',
        tier: 'premium',
      });
      expect(patched.status).toBe(200);
      // The draft carries the choice; the live agent (and its billing tier) does not, yet.
      expect(patched.body.draft).toMatchObject({ settings: { tier: 'premium', voice_id: '11labs-Adrian' } });
      expect(patched.body.tier).toBe('standard');
      await stream.waitForType('draft_updated');

      // ---- 6. generate: 202 now, work later
      const accepted = await call('POST', `/agents/${agentId}/generate`, auth, {});
      expect(accepted.status).toBe(202);
      const jobId = accepted.body.job_id as string;

      await stream.waitForType('generation_started');
      const generated = await stream.waitForType('generated');
      expect(generated.topic).toBe(`agent:${agentId}`);
      expect(generated.data.version_no).toBe(2);
      expect(generated.data.brief_card).toBeTruthy();

      const job = await waitForJob(jobId);
      expect(job.status).toBe('succeeded');

      // ---- 7. the version: validated, guardrailed, linted
      const version = await call('GET', `/agents/${agentId}/versions/2`, auth);
      expect(version.body.source).toBe('generated');
      expect(version.body.prompt_text).toContain(GUARDRAIL_HEADING);
      expect(version.body.editable_prompt).not.toContain(GUARDRAIL_HEADING);
      expect((version.body.lint as { publishable: boolean }).publishable).toBe(true);

      // ---- 8. feedback, which appends rather than rewrites
      const feedback = await call('POST', `/agents/${agentId}/feedback`, auth, {
        text: 'Ask for the callback number before anything else.',
      });
      expect(feedback.status).toBe(202);
      await waitForJob(feedback.body.job_id as string);
      const patchedFrame = await stream.waitForType('patched');
      expect(patchedFrame.data.version_no).toBe(3);

      // ---- 9. pick the version to publish
      const selected = await call('POST', `/agents/${agentId}/draft/select`, auth, { version_no: 3 });
      expect(selected.body.draft_version).toBe(3);

      // ---- 10. publish
      const published = await call('POST', `/agents/${agentId}/publish`, auth, {});
      expect(published.status).toBe(201);
      expect(published.body).toMatchObject({ version_no: 3, status: 'live', already_published: false });

      const publishFrame = await stream.waitForType('published');
      expect(publishFrame.data.version_no).toBe(3);

      // ---- 11. and Retell has it
      const row = await adminDb.agent.findUniqueOrThrow({ where: { id: agentId } });
      expect(row.status).toBe('live');
      expect(row.publishedVersion).toBe(3);
      // Publishing is what made the draft's tier and voice live — and billable.
      expect(row.tier).toBe('premium');
      expect(row.voiceId).toBe('11labs-Adrian');
      expect(row.retellAgentId).toBeTruthy();
      expect(retell.agents.get(row.retellAgentId!)?.some((v) => v.is_published)).toBe(true);

      const llmSpec = retell.calls.filter((c) => c.method === 'createLlm' || c.method === 'updateLlm').at(-1)!
        .args.at(-1) as { prompt: string };
      expect(llmSpec.prompt).toContain('Never claim to be human');

      // ---- 12. the checklist agrees the customer is through onboarding
      const checklist = await call('GET', '/workspace/checklist', auth);
      expect(checklist.body).toMatchObject({
        workspace_created: true,
        agent_created: true,
        agent_generated: true,
        agent_published: true,
        complete: true,
      });

      // ---- 13. history is intact and immutable
      const versions = await call('GET', `/agents/${agentId}/versions`, auth);
      expect((versions.body as unknown as Array<{ version_no: number; source: string }>).map((v) => v.source)).toEqual([
        'feedback',
        'generated',
        'manual',
      ]);
    } finally {
      await stream.close();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
describe('SSE for the agent topic (§16)', () => {
  it('carries every lifecycle event a customer is waiting on', async () => {
    const ws = await createWorkspace('sse');
    const auth = await authHeaders(ws.sub, ws.workspaceId);
    const stream = await openStream(auth);

    try {
      const agentId = (await call('POST', '/agents', auth, { template_id: 'receptionist' })).body.id as string;
      expect((await stream.waitForType('created')).data.agent_id).toBe(agentId);

      await call('PATCH', `/agents/${agentId}/draft`, auth, { brief: READY_BRIEF });
      await stream.waitForType('draft_updated');

      const jobId = (await call('POST', `/agents/${agentId}/generate`, auth, {})).body.job_id as string;
      await stream.waitForType('generation_started');
      await stream.waitForType('generated');
      await waitForJob(jobId);

      await call('POST', `/agents/${agentId}/draft/select`, auth, { version_no: 1 });
      await stream.waitForType('draft_selected');

      await call('POST', `/agents/${agentId}/draft/select`, auth, { version_no: 2 });
      await call('POST', `/agents/${agentId}/publish`, auth, {});
      await stream.waitForType('published');

      await call('POST', `/agents/${agentId}/pause`, auth);
      await stream.waitForType('paused');

      await call('POST', `/agents/${agentId}/resume`, auth);
      await stream.waitForType('resumed');

      await call('DELETE', `/agents/${agentId}`, auth);
      await stream.waitForType('deleted');

      // Every frame belongs to this agent's topic and no other.
      expect(stream.frames.every((f) => f.topic === `agent:${agentId}` || f.topic === 'wallet')).toBe(true);
    } finally {
      await stream.close();
    }
  }, 60_000);

  it('tells the customer when a generation fails, without leaking why', async () => {
    const ws = await createWorkspace('sse-failure');
    const auth = await authHeaders(ws.sub, ws.workspaceId);
    const stream = await openStream(auth);

    try {
      const agentId = (await call('POST', '/agents', auth, { template_id: 'receptionist' })).body.id as string;
      await call('PATCH', `/agents/${agentId}/draft`, auth, { brief: READY_BRIEF });

      provider.push({ kind: 'fail', error: 'refused', message: 'internal model detail nobody should see' });
      const jobId = (await call('POST', `/agents/${agentId}/generate`, auth, {})).body.job_id as string;

      const failed = await stream.waitForType('generation_failed');
      expect(failed.data.reason).not.toContain('internal model detail');
      expect(String(failed.data.reason)).toMatch(/could not write|try again/i);

      // The detail is on the job, where an engineer looks.
      const job = await waitForJob(jobId);
      expect(job.error).toContain('internal model detail');
    } finally {
      await stream.close();
      provider.reset();
    }
  }, 60_000);

  it('never delivers one workspace’s agent events to another', async () => {
    const mine = await createWorkspace('sse-mine');
    const theirs = await createWorkspace('sse-theirs');

    const mineStream = await openStream(await authHeaders(mine.sub, mine.workspaceId));
    const theirStream = await openStream(await authHeaders(theirs.sub, theirs.workspaceId));

    try {
      const auth = await authHeaders(mine.sub, mine.workspaceId);
      const agentId = (await call('POST', '/agents', auth, { template_id: 'receptionist' })).body.id as string;
      await call('PATCH', `/agents/${agentId}/draft`, auth, { brief: READY_BRIEF });
      await mineStream.waitForType('draft_updated');

      // Give the other stream every chance to receive something it should not.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(theirStream.frames).toEqual([]);
      expect(mineStream.frames.length).toBeGreaterThan(0);
    } finally {
      await mineStream.close();
      await theirStream.close();
    }
  }, 60_000);

  it('narrows to the topics the client asked for', async () => {
    const ws = await createWorkspace('sse-topics');
    const auth = await authHeaders(ws.sub, ws.workspaceId);

    const agentId = (await call('POST', '/agents', auth, { template_id: 'receptionist' })).body.id as string;
    const stream = await openStream(auth, `agent:${agentId}`);

    try {
      await call('PATCH', `/agents/${agentId}/draft`, auth, { brief: READY_BRIEF });
      await stream.waitForType('draft_updated');
      expect(stream.frames.every((f) => f.topic === `agent:${agentId}`)).toBe(true);
    } finally {
      await stream.close();
    }
  }, 60_000);

  it('refuses a stream for a workspace the caller does not belong to', async () => {
    const mine = await createWorkspace('sse-forbidden');
    const theirs = await createWorkspace('sse-forbidden-other');

    const response = await fetch(`${baseUrl}/events`, {
      headers: { ...(await authHeaders(mine.sub, theirs.workspaceId)), accept: 'text/event-stream' },
    });
    expect(response.status).toBe(403);
    await response.body?.cancel();
  });
});
