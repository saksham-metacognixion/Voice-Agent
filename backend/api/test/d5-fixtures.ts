import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ZodValidationPipe } from 'nestjs-zod';
import { adminDb } from '@portal/db';
import { AllExceptionsFilter } from '../src/common/errors/all-exceptions.filter';
import { AgentsModule } from '../src/modules/agents';
import { AuthModule } from '../src/modules/auth';
import { BillingModule } from '../src/modules/billing';
import { CallsModule } from '../src/modules/calls';
import { PlatformConfigModule } from '../src/modules/config';
import { EventsModule } from '../src/modules/events';
import { JobsModule, WorkerRuntime } from '../src/modules/jobs';
import { PROMPT_PROVIDER, PromptingModule, ScriptedPromptProvider } from '../src/modules/prompting';
import { RedisModule } from '../src/modules/redis';
import { RetellGateway, RetellModule } from '../src/modules/retell';
import { RuntimeCacheModule } from '../src/modules/runtime-cache';
import { ScheduledModule } from '../src/modules/scheduled';
import { VoicesModule } from '../src/modules/voices';
import { WalletModule } from '../src/modules/wallet';
import { WebhooksModule, registerWebhookRawBody } from '../src/modules/webhooks';
import { WorkspacesModule } from '../src/modules/workspaces';
import { FakeAuth0Tenant } from './auth0-double';

/*
 * The D5 harness: a real Nest app with the real modules, real Postgres, real Redis and a
 * real BullMQ worker on a per-run queue prefix.
 *
 * Two things are substituted, and only two:
 *
 *   `RetellGateway`   — a double that records what it was asked to do and models the one
 *                       behaviour that matters (a published version is immutable, so a
 *                       new draft has to be branched). Talking to Retell from a test
 *                       would be slow, flaky and would leave objects behind in a shared
 *                       workspace.
 *   `PROMPT_PROVIDER` — the scripted provider, so a test can hand the pipeline a
 *                       malformed answer, a refusal or a timeout on demand. Everything
 *                       after the provider is the real code.
 *
 * Auth0 is the same double the D1 suite uses: two genuinely separate issuers, which is
 * what makes the tenancy assertions mean anything.
 */

process.env.APP_ENV ||= 'dev';
process.env.CAPTURE_FIXTURES = 'false';
process.env.STRIPE_SECRET_KEY ||= 'sk_test_e2e_placeholder_not_used_for_network';
process.env.STRIPE_WEBHOOK_SECRET ||= 'whsec_e2e_placeholder';
process.env.RETELL_API_KEY ||= 'key_e2e_placeholder_0123456789abcdef';
process.env.API_PUBLIC_URL ||= 'http://localhost:4000';
process.env.RECORDING_SIGNING_SECRET ||= 'e2e-recording-secret-long-enough-to-use';
process.env.AUTH0_CUSTOMER_ACTION_SECRET ||= 'e2e-auth0-shared-secret-long-enough';
/** The whole point: no network, no key, deterministic answers. */
process.env.GENERATION_PROVIDER = 'scripted';
process.env.BULLMQ_PREFIX = `portal:d5-${randomUUID().slice(0, 8)}`;

/** What the Retell double was asked to do, in order. */
export interface RetellCall {
  method: string;
  args: unknown[];
}

/**
 * A stand-in for Retell that models ADR 0003 §7 rather than mocking it away: an agent is
 * created at version 0 unpublished, publishing freezes that version, and the next edit
 * has to branch a new draft. A test that gets the publish dance wrong fails here in the
 * same way it would fail against the real API.
 */
export class FakeRetellGateway {
  readonly calls: RetellCall[] = [];
  /** agent_id → the versions it has, newest last. */
  readonly agents = new Map<string, Array<{ version: number; is_published: boolean }>>();
  readonly llms = new Set<string>();
  readonly deleted = new Set<string>();

  /** Method name → how many more times it should throw. */
  private readonly failures = new Map<string, { remaining: number; error: Error }>();
  /** Method name → how long it should hang before answering. */
  private readonly delays = new Map<string, number>();

  readonly config = {
    configured: true,
    missing: [] as string[],
    objectName: (name: string) => `dev-${name}`,
  };

  /** Makes the next `times` calls to `method` throw. */
  failNext(method: string, times = 1, error = new Error('retell is having a moment')): void {
    this.failures.set(method, { remaining: times, error });
  }

  delayNext(method: string, ms: number): void {
    this.delays.set(method, ms);
  }

  reset(): void {
    this.calls.length = 0;
    this.agents.clear();
    this.llms.clear();
    this.deleted.clear();
    this.failures.clear();
    this.delays.clear();
  }

  countOf(method: string): number {
    return this.calls.filter((call) => call.method === method).length;
  }

  private async record<T>(method: string, args: unknown[], result: () => T): Promise<T> {
    this.calls.push({ method, args });
    const delay = this.delays.get(method);
    if (delay) {
      this.delays.delete(method);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    const failure = this.failures.get(method);
    if (failure && failure.remaining > 0) {
      failure.remaining -= 1;
      if (failure.remaining === 0) this.failures.delete(method);
      throw failure.error;
    }
    return result();
  }

  createLlm(spec: unknown) {
    return this.record('createLlm', [spec], () => {
      const llmId = `llm_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
      this.llms.add(llmId);
      return { llm_id: llmId, version: 0 };
    });
  }

  updateLlm(llmId: string, spec: unknown) {
    return this.record('updateLlm', [llmId, spec], () => ({ llm_id: llmId, version: 0 }));
  }

  deleteLlm(llmId: string) {
    return this.record('deleteLlm', [llmId], () => {
      this.llms.delete(llmId);
      this.deleted.add(llmId);
      return undefined;
    });
  }

  createAgent(spec: unknown) {
    return this.record('createAgent', [spec], () => {
      const agentId = `agent_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
      this.agents.set(agentId, [{ version: 0, is_published: false }]);
      return { agent_id: agentId, version: 0, is_published: false };
    });
  }

  updateAgent(agentId: string, spec: unknown) {
    return this.record('updateAgent', [agentId, spec], () => {
      const latest = this.latestOf(agentId);
      // The D2 finding: Retell answers 422 rather than editing a published version.
      if (latest.is_published) throw new Error('Cannot update published agent other than version title');
      return { agent_id: agentId, version: latest.version, is_published: false };
    });
  }

  createAgentVersion(agentId: string, baseVersion: number) {
    return this.record('createAgentVersion', [agentId, baseVersion], () => {
      const versions = this.versionsOf(agentId);
      const next = this.latestOf(agentId).version + 1;
      versions.push({ version: next, is_published: false });
      return { agent_id: agentId, version: next, base_version: baseVersion, is_published: false };
    });
  }

  getAgent(agentId: string, version?: number) {
    return this.record('getAgent', [agentId, version], () => {
      const versions = this.versionsOf(agentId);
      const found = version === undefined ? this.latestOf(agentId) : versions.find((v) => v.version === version);
      if (!found) throw new Error(`agent ${agentId} has no version ${version}`);
      return { agent_id: agentId, ...found };
    });
  }

  publishAgent(agentId: string, version: number) {
    return this.record('publishAgent', [agentId, version], () => {
      const versions = this.versionsOf(agentId);
      const found = versions.find((v) => v.version === version);
      if (!found) throw new Error(`agent ${agentId} has no version ${version}`);
      if (found.is_published) throw new Error('version is already published');
      found.is_published = true;
      return undefined;
    });
  }

  deleteAgent(agentId: string) {
    return this.record('deleteAgent', [agentId], () => {
      this.agents.delete(agentId);
      this.deleted.add(agentId);
      return undefined;
    });
  }

  listVoices() {
    return this.record('listVoices', [], () => [
      {
        voice_id: '11labs-Adrian',
        voice_name: 'Adrian',
        provider: 'elevenlabs',
        gender: 'male',
        accent: 'American',
        preview_audio_url: 'https://example.test/adrian.mp3',
      },
      {
        voice_id: 'cartesia-Cleo',
        voice_name: 'Cleo',
        provider: 'cartesia',
        gender: 'female',
        accent: 'American',
        language: 'en-US',
        preview_audio_url: 'https://example.test/cleo.mp3',
      },
      {
        voice_id: 'cartesia-Margot',
        voice_name: 'Margot',
        provider: 'cartesia',
        gender: 'female',
        accent: 'Canadian',
        languages: ['fr-CA', 'en-US'],
        preview_audio_url: 'https://example.test/margot.mp3',
      },
    ]);
  }

  /** The signature path is real elsewhere; nothing in D5 verifies a Retell signature. */
  verifyWebhookSignature(): Promise<boolean> {
    return Promise.resolve(true);
  }

  private versionsOf(agentId: string) {
    const versions = this.agents.get(agentId);
    if (!versions) throw new Error(`agent ${agentId} does not exist on Retell`);
    return versions;
  }

  private latestOf(agentId: string) {
    const versions = this.versionsOf(agentId);
    const latest = versions[versions.length - 1];
    if (!latest) throw new Error(`agent ${agentId} has no versions`);
    return latest;
  }
}

@Module({
  imports: [
    AuthModule,
    RedisModule,
    PlatformConfigModule,
    JobsModule,
    EventsModule,
    RetellModule,
    WalletModule,
    BillingModule,
    RuntimeCacheModule,
    CallsModule,
    WorkspacesModule,
    AgentsModule,
    PromptingModule,
    VoicesModule,
    WebhooksModule,
    ScheduledModule,
  ],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class D5TestModule {}

export interface D5Harness {
  app: NestFastifyApplication;
  customerTenant: FakeAuth0Tenant;
  retell: FakeRetellGateway;
  provider: ScriptedPromptProvider;
  stop: () => Promise<void>;
}

export async function startD5Harness(options: { listen?: boolean; workers?: boolean } = {}): Promise<D5Harness> {
  const customerTenant = new FakeAuth0Tenant('customers', 'https://api.test');
  const staffTenant = new FakeAuth0Tenant('staff', 'https://admin-api.test');
  await customerTenant.start();
  await staffTenant.start();
  process.env.AUTH0_CUSTOMER_DOMAIN = customerTenant.domain;
  process.env.AUTH0_CUSTOMER_AUDIENCE = customerTenant.audience;
  process.env.AUTH0_STAFF_DOMAIN = staffTenant.domain;
  process.env.AUTH0_STAFF_AUDIENCE = staffTenant.audience;

  const retell = new FakeRetellGateway();
  const provider = new ScriptedPromptProvider();

  const moduleRef = await Test.createTestingModule({ imports: [D5TestModule] })
    .overrideProvider(RetellGateway)
    .useValue(retell)
    .overrideProvider(PROMPT_PROVIDER)
    .useValue(provider)
    .compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  registerWebhookRawBody(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  if (options.listen) await app.listen(0, '127.0.0.1');
  if (options.workers !== false) await app.get(WorkerRuntime).start();

  return {
    app,
    customerTenant,
    retell,
    provider,
    stop: async () => {
      await app.close();
      await customerTenant.stop();
      await staffTenant.stop();
    },
  };
}

export interface TestUser {
  userId: string;
  sub: string;
  email: string;
}

/** A `users` row with no workspace — what the Auth0 webhook leaves behind. */
export async function createUser(label: string): Promise<TestUser> {
  const run = randomUUID().slice(0, 8);
  const sub = `auth0|${label}-${run}`;
  const email = `${label}-${run}@example.test`;
  const user = await adminDb.user.create({ data: { authProviderId: sub, email, name: label } });
  return { userId: user.id, sub, email };
}

export interface TestWorkspace extends TestUser {
  workspaceId: string;
}

/** A workspace with an owner, created straight in the database — not through the route. */
export async function createWorkspace(label: string, over: { name?: string } = {}): Promise<TestWorkspace> {
  const user = await createUser(label);
  const tenant = await adminDb.tenant.create({
    data: { name: over.name ?? `${label} ${user.userId.slice(0, 6)}`, country: 'CA', timezone: 'America/Toronto' },
  });
  await adminDb.membership.create({ data: { tenantId: tenant.id, userId: user.userId, role: 'owner' } });
  await adminDb.notificationSetting.create({ data: { tenantId: tenant.id, userId: null } });
  return { ...user, workspaceId: tenant.id };
}

/** Adds an existing user to a workspace in a given role. */
export async function addMember(workspaceId: string, label: string, role: 'admin' | 'editor' | 'viewer'): Promise<TestUser> {
  const user = await createUser(label);
  await adminDb.membership.create({ data: { tenantId: workspaceId, userId: user.userId, role } });
  return user;
}

/** Polls until `check` returns something truthy. Jobs are asynchronous by design. */
export async function waitFor<T>(what: string, check: () => Promise<T | null | undefined | false>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
      last = value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}

/** Waits for a `jobs` row to leave the queued/running states. */
export async function waitForJob(jobId: string, timeoutMs = 15_000) {
  return waitFor(
    `job ${jobId} to finish`,
    async () => {
      const row = await adminDb.job.findUnique({ where: { id: jobId } });
      return row && (row.status === 'succeeded' || row.status === 'failed') ? row : null;
    },
    timeoutMs,
  );
}

/** A brief complete enough for §13.3 to accept it. */
export const READY_BRIEF = {
  about_business: 'A family dental clinic in Laval with two dentists and one hygienist.',
  goal: 'Answer calls, share opening hours, and take detailed messages for the team.',
  services: ['Check-ups', 'Cleanings'],
  agent_name: 'Sophie',
};
