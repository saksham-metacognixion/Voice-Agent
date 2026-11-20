import { adminDb } from '@portal/db';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EventsService } from '../src/modules/events';
import {
  JOBS,
  JobQueues,
  JobRecordsService,
  LOST_JOB_REASON,
  QUEUES,
  promptingBullId,
} from '../src/modules/jobs';
import type { ScriptedPromptProvider } from '../src/modules/prompting';
import { ScheduledJobsService } from '../src/modules/scheduled';
import type { FakeAuth0Tenant } from './auth0-double';
import {
  READY_BRIEF,
  type TestWorkspace,
  createWorkspace,
  startD5Harness,
  waitFor,
  waitForJob,
} from './d5-fixtures';

/*
 * D5 review finding 2: a `jobs` row left `queued`/`running` by a process death.
 *
 * BullMQ notices a dead worker on its own (the lock expires, the job is retried or failed
 * as stalled), but nothing then touches `jobs.status` — and `jobs_one_active_per_target_idx`
 * makes every later Generate *join* the dead row. The customer polls a `running` job no
 * worker owns, forever.
 *
 * The fix asks the queue rather than guessing from a clock: a row is written off only when
 * BullMQ says nothing will ever run its id again (missing, failed, completed). A job that
 * is waiting for a worker, being retried, or actually running is left alone however old.
 */

let app: NestFastifyApplication;
let stop: () => Promise<void>;
let customerTenant: FakeAuth0Tenant;
let provider: ScriptedPromptProvider;
let ws: TestWorkspace;
let jobs: JobRecordsService;
let queues: JobQueues;

beforeAll(async () => {
  const harness = await startD5Harness({ workers: true });
  app = harness.app;
  stop = harness.stop;
  customerTenant = harness.customerTenant;
  provider = harness.provider;
  ws = await createWorkspace('recovery');
  jobs = app.get(JobRecordsService);
  queues = app.get(JobQueues);
});

afterAll(async () => {
  await stop?.();
  await adminDb.$disconnect();
});

beforeEach(() => provider.reset());

async function headers(): Promise<Record<string, string>> {
  return {
    authorization: `Bearer ${await customerTenant.mint(ws.sub)}`,
    'x-workspace-id': ws.workspaceId,
  };
}

async function req(method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown) {
  const base = await headers();
  return app.inject({
    method,
    url,
    headers: body === undefined ? base : { ...base, 'content-type': 'application/json' },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function readyAgent(): Promise<string> {
  const agentId = (await req('POST', '/agents', { template_id: 'receptionist' })).json()
    .id as string;
  await req('PATCH', `/agents/${agentId}/draft`, { brief: READY_BRIEF });
  return agentId;
}

/** A row the way a worker that died at the wrong moment leaves it: no queue job behind it. */
async function orphanRow(agentId: string, status: 'queued' | 'running' = 'running') {
  const { jobId } = await jobs.createOrJoin({
    workspaceId: ws.workspaceId,
    type: JOBS.generateAgent,
    agentId,
    steps: { mode: 'generate', base_version: 1 },
  });
  await adminDb.job.update({ where: { id: jobId }, data: { status } });
  return jobId;
}

/** Makes the row look untouched for five minutes, the way a dead worker leaves it. */
async function backdate(jobId: string, ms = 5 * 60_000) {
  await adminDb.job.update({
    where: { id: jobId },
    data: { updatedAt: new Date(Date.now() - ms) },
  });
}

// ---------------------------------------------------------------------------
describe('the job sweeper', () => {
  it('writes off a running row whose queue job is gone, and the agent can be generated again', async () => {
    const agentId = await readyAgent();
    const dead = await orphanRow(agentId, 'running');
    await backdate(dead);

    const lost = await jobs.reconcileStale();
    expect(lost.map((l) => l.jobId)).toContain(dead);
    expect(lost.find((l) => l.jobId === dead)).toMatchObject({
      agentId,
      workspaceId: ws.workspaceId,
      queueState: 'missing',
    });

    const row = await adminDb.job.findUniqueOrThrow({ where: { id: dead } });
    expect(row.status).toBe('failed');
    expect((row.stepsJson as Record<string, unknown>).error_kind).toBe('lost');

    // What the customer sees: failed, with a reason they can act on.
    const shown = await req('GET', `/jobs/${dead}`);
    expect(shown.json()).toMatchObject({ status: 'failed', error: LOST_JOB_REASON });

    // And the next Generate is a *new* job that actually runs.
    const next = await req('POST', `/agents/${agentId}/generate`, {});
    expect(next.statusCode).toBe(202);
    expect(next.json().job_id).not.toBe(dead);
    expect((await waitForJob(next.json().job_id)).status).toBe('succeeded');
  });

  it('writes off a queued row whose enqueue never happened (the API died between the two)', async () => {
    const agentId = await readyAgent();
    const dead = await orphanRow(agentId, 'queued');
    await backdate(dead);
    const lost = await jobs.reconcileStale();
    expect(lost.map((l) => l.jobId)).toContain(dead);
    expect((await adminDb.job.findUniqueOrThrow({ where: { id: dead } })).status).toBe('failed');
  });

  it('leaves a row alone while its job is waiting for a worker — a stopped worker is not a dead job', async () => {
    const agentId = await readyAgent();
    const queue = queues.queue(QUEUES.prompting);
    await queue.pause();
    let jobId: string;
    try {
      const res = await req('POST', `/agents/${agentId}/generate`, {});
      expect(res.statusCode).toBe(202);
      jobId = res.json().job_id;
      await backdate(jobId);

      const lost = await jobs.reconcileStale();
      expect(lost.map((l) => l.jobId)).not.toContain(jobId);
      expect((await adminDb.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe('queued');
    } finally {
      await queue.resume();
    }
    // The worker comes back and the job runs to completion.
    expect((await waitForJob(jobId)).status).toBe('succeeded');
  });

  it('leaves a row alone while its job is actively running, however stale the row looks', async () => {
    const agentId = await readyAgent();
    provider.push({ kind: 'delay', ms: 1_500 });
    const res = await req('POST', `/agents/${agentId}/generate`, {});
    const jobId = res.json().job_id as string;
    await waitFor('the job to be running', async () => {
      const row = await adminDb.job.findUniqueOrThrow({ where: { id: jobId } });
      return row.status === 'running' ? row : null;
    });
    await backdate(jobId);

    const lost = await jobs.reconcileStale();
    expect(lost.map((l) => l.jobId)).not.toContain(jobId);

    expect((await waitForJob(jobId)).status).toBe('succeeded');
  });

  it('writes off a row whose queue job BullMQ itself failed — the stalled-worker case', async () => {
    const agentId = await readyAgent();
    const { jobId } = await jobs.createOrJoin({
      workspaceId: ws.workspaceId,
      type: JOBS.generateAgent,
      agentId,
      steps: { mode: 'generate' },
    });
    await adminDb.job.update({ where: { id: jobId }, data: { status: 'running' } });

    // A queue job under the row's deterministic id that fails without ever reaching our
    // handler's catch — exactly what "job stalled more than allowable limit" looks like.
    const queue = queues.queue(QUEUES.prompting);
    await queue.add(
      'handler-that-does-not-exist',
      {},
      { jobId: promptingBullId(JOBS.generateAgent, jobId)!, attempts: 1 },
    );
    await waitFor(
      'BullMQ to fail the job',
      async () =>
        (await queues.stateOf(QUEUES.prompting, promptingBullId(JOBS.generateAgent, jobId)!)) ===
        'failed',
    );
    await backdate(jobId);

    const lost = await jobs.reconcileStale();
    expect(lost.find((l) => l.jobId === jobId)?.queueState).toBe('failed');
    expect((await adminDb.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe('failed');
  });

  it('is idempotent — a second sweep finds nothing to do', async () => {
    const agentId = await readyAgent();
    const dead = await orphanRow(agentId);
    await backdate(dead);
    expect((await jobs.reconcileStale()).map((l) => l.jobId)).toContain(dead);
    expect((await jobs.reconcileStale()).map((l) => l.jobId)).not.toContain(dead);
    const row = await adminDb.job.findUniqueOrThrow({ where: { id: dead } });
    expect(row.status).toBe('failed');
  });

  it('does not touch a fresh row — the create-then-enqueue window is never mistaken for death', async () => {
    const agentId = await readyAgent();
    const fresh = await orphanRow(agentId);
    const lost = await jobs.reconcileStale();
    expect(lost.map((l) => l.jobId)).not.toContain(fresh);
    expect((await adminDb.job.findUniqueOrThrow({ where: { id: fresh } })).status).toBe('running');
    await adminDb.job.update({ where: { id: fresh }, data: { status: 'failed' } });
  });

  it('tells the customer’s stream that the job it is watching is not coming back', async () => {
    const agentId = await readyAgent();
    const dead = await orphanRow(agentId);
    await backdate(dead);

    const frames: Array<{ type: string; data: Record<string, unknown> }> = [];
    const unsubscribe = app
      .get(EventsService)
      .subscribe(ws.workspaceId, (event) => frames.push(event as never));
    try {
      const swept = await app.get(ScheduledJobsService).jobSweeper();
      expect(swept.lost).toBeGreaterThanOrEqual(1);
      const frame = frames.find((f) => f.type === 'generation_failed' && f.data.job_id === dead);
      expect(frame?.data).toMatchObject({ agent_id: agentId, reason: LOST_JOB_REASON });
    } finally {
      unsubscribe();
    }
  });
});

// ---------------------------------------------------------------------------
describe('the join path recovers without waiting for the sweeper', () => {
  it('a Generate that would join a dead job writes it off and starts a fresh one', async () => {
    const agentId = await readyAgent();
    const dead = await orphanRow(agentId, 'running');
    await backdate(dead, 60_000);

    const res = await req('POST', `/agents/${agentId}/generate`, {});
    expect(res.statusCode).toBe(202);
    expect(res.json().job_id).not.toBe(dead);

    expect((await adminDb.job.findUniqueOrThrow({ where: { id: dead } })).status).toBe('failed');
    expect((await waitForJob(res.json().job_id)).status).toBe('succeeded');
    expect(await adminDb.agentVersion.count({ where: { agentId } })).toBe(2);
  });

  it('a Generate that would join a job that is genuinely in flight still joins it', async () => {
    const agentId = await readyAgent();
    provider.push({ kind: 'delay', ms: 800 });
    const first = await req('POST', `/agents/${agentId}/generate`, {});
    await backdate(first.json().job_id, 60_000);

    const second = await req('POST', `/agents/${agentId}/generate`, {});
    expect(second.json().job_id).toBe(first.json().job_id);
    expect((await waitForJob(first.json().job_id)).status).toBe('succeeded');
    expect(provider.calls.filter((c) => c.kind === 'generate')).toHaveLength(1);
  });

  it('a very young dead row is joined, not written off — the grace protects the enqueue window', async () => {
    const agentId = await readyAgent();
    const young = await orphanRow(agentId, 'queued');
    const res = await req('POST', `/agents/${agentId}/generate`, {});
    expect(res.json().job_id).toBe(young);
    await adminDb.job.update({ where: { id: young }, data: { status: 'failed' } });
  });
});
