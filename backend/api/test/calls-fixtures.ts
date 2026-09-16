import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ZodValidationPipe } from 'nestjs-zod';
import { adminDb } from '@portal/db';
import { AllExceptionsFilter } from '../src/common/errors/all-exceptions.filter';
import { AuthModule } from '../src/modules/auth';
import { BillingModule } from '../src/modules/billing';
import { CallsModule } from '../src/modules/calls';
import { PlatformConfigModule } from '../src/modules/config';
import { EventsModule } from '../src/modules/events';
import { JobsModule, WorkerRuntime } from '../src/modules/jobs';
import { RedisModule } from '../src/modules/redis';
import { RetellModule } from '../src/modules/retell';
import { RuntimeCacheModule } from '../src/modules/runtime-cache';
import { ScheduledModule } from '../src/modules/scheduled';
import { WalletModule } from '../src/modules/wallet';
import { WebhooksModule, registerWebhookRawBody } from '../src/modules/webhooks';
import { FakeAuth0Tenant } from './auth0-double';

/*
 * Shared plumbing for the D4 call-path suites: a real Nest app with the real modules, a
 * real BullMQ worker on a per-run queue prefix, real Postgres and real Redis. Nothing
 * between the wire and the ledger is mocked — the only stand-in is Auth0, because two
 * genuinely separate issuers are what make the tenancy assertions mean something.
 */

process.env.APP_ENV ||= 'dev';
process.env.CAPTURE_FIXTURES = 'false';
process.env.STRIPE_SECRET_KEY ||= 'sk_test_e2e_placeholder_not_used_for_network';
process.env.STRIPE_WEBHOOK_SECRET ||= 'whsec_e2e_placeholder';
// Signing and verification both use this, so a placeholder exercises the real HMAC path.
process.env.RETELL_API_KEY ||= 'key_e2e_placeholder_0123456789abcdef';
process.env.API_PUBLIC_URL ||= 'http://localhost:4000';
process.env.RECORDING_SIGNING_SECRET ||= 'e2e-recording-secret-long-enough-to-use';
/** Every run gets its own BullMQ namespace, so a dev worker on the same Redis never steals a job. */
process.env.BULLMQ_PREFIX = `portal:e2e-${randomUUID().slice(0, 8)}`;

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
    WebhooksModule,
    ScheduledModule,
  ],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class CallsTestModule {}

export interface TestHarness {
  app: NestFastifyApplication;
  customerTenant: FakeAuth0Tenant;
  staffTenant: FakeAuth0Tenant;
  stop: () => Promise<void>;
}

/** Boots the app, its Auth0 doubles and a live BullMQ worker. `listen` also binds a port (SSE). */
export async function startHarness(options: { listen?: boolean; workers?: boolean } = {}): Promise<TestHarness> {
  const customerTenant = new FakeAuth0Tenant('customers', 'https://api.test');
  const staffTenant = new FakeAuth0Tenant('staff', 'https://admin-api.test');
  await customerTenant.start();
  await staffTenant.start();
  process.env.AUTH0_CUSTOMER_DOMAIN = customerTenant.domain;
  process.env.AUTH0_CUSTOMER_AUDIENCE = customerTenant.audience;
  process.env.AUTH0_STAFF_DOMAIN = staffTenant.domain;
  process.env.AUTH0_STAFF_AUDIENCE = staffTenant.audience;

  const moduleRef = await Test.createTestingModule({ imports: [CallsTestModule] }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  registerWebhookRawBody(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  if (options.listen) await app.listen(0, '127.0.0.1');
  if (options.workers !== false) await app.get(WorkerRuntime).start();

  return {
    app,
    customerTenant,
    staffTenant,
    stop: async () => {
      await app.close();
      await customerTenant.stop();
      await staffTenant.stop();
    },
  };
}

export interface CallWorkspace {
  tenantId: string;
  userId: string;
  sub: string;
  agentId: string;
  retellAgentId: string;
  numberId: string;
  e164: string;
  token: string;
}

/** A workspace that can take a phone call: live agent, active number, an inbound token. */
export async function createCallWorkspace(label: string, overrides: { tier?: 'standard' | 'premium'; maxCallDurationS?: number } = {}): Promise<CallWorkspace> {
  const run = randomUUID().slice(0, 8);
  const tenant = await adminDb.tenant.create({ data: { name: `${label} ${run}`, country: 'CA', timezone: 'America/Toronto' } });
  const user = await adminDb.user.create({ data: { authProviderId: `auth0|${label}-${run}`, email: `${label}-${run}@example.test`, name: label } });
  await adminDb.membership.create({ data: { tenantId: tenant.id, userId: user.id, role: 'owner' } });
  const retellAgentId = `agent_${run}${'0'.repeat(18)}`.slice(0, 26);
  const agent = await adminDb.agent.create({
    data: {
      tenantId: tenant.id,
      name: `${label} receptionist`,
      status: 'live',
      tier: overrides.tier ?? 'standard',
      retellAgentId,
      publishedVersion: 1,
      maxCallDurationS: overrides.maxCallDurationS ?? 600,
    },
  });
  const e164 = `+1450${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
  const token = `tok_${randomUUID().replace(/-/g, '')}`;
  const number = await adminDb.phoneNumber.create({
    data: {
      tenantId: tenant.id,
      agentId: agent.id,
      e164,
      type: 'retell_twilio',
      status: 'active',
      inboundToken: token,
      country: 'CA',
    },
  });
  return { tenantId: tenant.id, userId: user.id, sub: user.authProviderId, agentId: agent.id, retellAgentId, numberId: number.id, e164, token };
}

/** Polls until `check` returns a truthy value, or fails with `what`. Jobs are asynchronous by design. */
export async function waitFor<T>(what: string, check: () => Promise<T | null | undefined | false>, timeoutMs = 10_000): Promise<T> {
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

/** A Retell lifecycle webhook body, shaped exactly like the D2 fixtures. */
export function lifecycleEvent(
  event: 'call_started' | 'call_ended' | 'call_analyzed',
  call: Record<string, unknown>,
): Record<string, unknown> {
  return { event, call: { call_type: 'phone_call', direction: 'inbound', ...call }, event_timestamp: Date.now() };
}

/** The `call_inbound` body Retell posts to the per-number authorisation URL. */
export function inboundEvent(input: { callId?: string; from?: string; to: string; agentId?: string }): Record<string, unknown> {
  return {
    event: 'call_inbound',
    event_timestamp: Date.now(),
    call_inbound: {
      call_id: input.callId,
      agent_id: input.agentId ?? 'agent_unused',
      agent_version: 1,
      from_number: input.from ?? '+19375550100',
      to_number: input.to,
    },
  };
}

export function callId(prefix = 'call'): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

/**
 * Waits for the metering job to finish a call: the row exists **and** `credits_charged`
 * has been written. Both halves matter — a row that does not exist yet reads as
 * `undefined`, which is not `null`, and a check written the obvious way would pass before
 * anything had happened.
 */
export async function waitForBilled(id: string) {
  return waitFor(`call ${id} to be billed`, async () => {
    const row = await adminDb.call.findUnique({ where: { id } });
    return row && row.creditsCharged !== null ? row : null;
  });
}

export async function ledgerSum(tenantId: string): Promise<number> {
  const agg = await adminDb.creditLedger.aggregate({ where: { tenantId }, _sum: { delta: true } });
  return agg._sum.delta?.toNumber() ?? 0;
}
