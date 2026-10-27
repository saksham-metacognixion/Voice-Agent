import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ZodValidationPipe } from 'nestjs-zod';
import Retell from 'retell-sdk';
import { adminDb } from '@portal/db';
import { AllExceptionsFilter } from '../src/common/errors/all-exceptions.filter';
import { ActivationModule } from '../src/modules/activation';
import { AdminModule } from '../src/modules/admin';
import { SupportModule } from '../src/modules/support';
import { AgentsModule } from '../src/modules/agents';
import { AlertsModule, OpsAlertService, type OpsAlert } from '../src/modules/alerts';
import { AuthModule } from '../src/modules/auth';
import { CryptoModule } from '../src/modules/crypto';
import { KnowledgeModule } from '../src/modules/knowledge';
import { NotificationsModule } from '../src/modules/notifications';
import { NumbersModule } from '../src/modules/numbers';
import { BillingModule } from '../src/modules/billing';
import { CallsModule } from '../src/modules/calls';
import { PlatformConfigModule } from '../src/modules/config';
import { EventsModule } from '../src/modules/events';
import { JobsModule, WorkerRuntime } from '../src/modules/jobs';
import { PROMPT_PROVIDER, PromptingModule, ScriptedPromptProvider } from '../src/modules/prompting';
import { RedisModule } from '../src/modules/redis';
import { type ProviderCallFacts, type RetellCallFacts, RetellGateway, RetellModule } from '../src/modules/retell';
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
/**
 * Placeholders only, so a suite that builds a Nest graph without `startD5Harness()` —
 * `worker-module.e2e.test.ts` builds the real `WorkerModule` — still gets an `AuthConfig`.
 * `startD5Harness()` overwrites all four with its two fake tenants, and the tenancy
 * assertions run against those. `||=`, so a developer's .env still wins locally.
 *
 * Not optional: turbo runs tasks in strict env mode, so nothing outside
 * turbo.json's globalPassThroughEnv reaches CI, and CI has no .env to fall back on.
 */
process.env.AUTH0_CUSTOMER_DOMAIN ||= 'e2e-customers.placeholder.test';
process.env.AUTH0_CUSTOMER_AUDIENCE ||= 'https://api.test';
process.env.AUTH0_STAFF_DOMAIN ||= 'e2e-staff.placeholder.test';
process.env.AUTH0_STAFF_AUDIENCE ||= 'https://admin-api.test';
/** The whole point: no network, no key, deterministic answers. */
process.env.GENERATION_PROVIDER = 'scripted';
/** D6: SIP credentials are envelope-encrypted under a local master in tests (KMS in staging/prod). */
process.env.SIP_CREDENTIALS_LOCAL_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
delete process.env.SIP_CREDENTIALS_KMS_KEY_ID;
delete process.env.OPS_ALERT_WEBHOOK_URL;
process.env.BULLMQ_PREFIX = `portal:d5-${randomUUID().slice(0, 8)}`;
/** D6: retried activation scenarios would otherwise wait 5 s + 10 s per test. */
process.env.ACTIVATION_BACKOFF_MS ||= '150';

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

  /** e164 → the platform's number object. */
  readonly phoneNumbers = new Map<string, FakePhoneNumber>();
  /** knowledge_base_id → the platform's KB object. */
  readonly knowledgeBases = new Map<string, FakeKnowledgeBase>();
  /** How many `getKnowledgeBase` reads a KB stays `in_progress` after a create or add. */
  kbIngestPolls = 1;

  readonly config = {
    configured: true,
    missing: [] as string[],
    env: 'dev',
    objectName: (name: string) => `dev-${name}`,
    inboundWebhookUrl: (token: string) => `${process.env.API_PUBLIC_URL ?? 'http://localhost:4000'}/webhooks/retell/inbound/${token}`,
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
    this.phoneNumbers.clear();
    this.knowledgeBases.clear();
    this.providerCalls.length = 0;
    this.callObjects.clear();
    this.kbIngestPolls = 1;
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
      {
        // The one voice here that is native in French and nothing else: `voices.e2e` needs a
        // non-native entry to assert the en-US ranking against, and Adrian, Cleo and Margot
        // are all native in en-US (the first two by their American accent, Margot because the
        // catalogue sends her an explicit en-US). Accent `French` with no languages is exactly
        // how the real catalogue carries her — see test/fixtures/retell/api/list-voices.json.
        voice_id: 'cartesia-Pierre',
        voice_name: 'Pierre',
        provider: 'cartesia',
        gender: 'male',
        accent: 'French',
        preview_audio_url: 'https://example.test/pierre.mp3',
      },
    ]);
  }

  /** The signature path is real elsewhere; nothing in D5 verifies a Retell signature. */
  verifyWebhookSignature(): Promise<boolean> {
    return Promise.resolve(true);
  }

  // ---------------------------------------------------------------- calls (D7 reconciliation)

  /** What `list-calls` would return: a test seeds the platform's view of a window here. */
  readonly providerCalls: ProviderCallFacts[] = [];

  listCallsInWindow(sinceMs: number, untilMs: number): Promise<{ calls: ProviderCallFacts[]; partial: boolean }> {
    return this.record('listCallsInWindow', [sinceMs, untilMs], () => ({
      calls: this.providerCalls.filter((c) => c.start_timestamp !== null && c.start_timestamp >= sinceMs && c.start_timestamp < untilMs).map((c) => ({ ...c })),
      partial: false,
    }));
  }

  /** What `get-call` answers, by call id: a test seeds the platform's copy of a call whose webhooks were lost. Absent → 404 (null). */
  readonly callObjects = new Map<string, RetellCallFacts>();

  retrieveCallFacts(callId: string): Promise<RetellCallFacts | null> {
    return this.record('retrieveCallFacts', [callId], () => {
      const call = this.callObjects.get(callId);
      return call ? structuredClone(call) : null;
    });
  }

  // ---------------------------------------------------------------- numbers (D6, §11)

  /** §13.4 browser test call: the minted token, with the transport fields the SDK needs. */
  createWebCall(input: { agentId: string; agentVersion: number; metadata: Record<string, unknown>; maxCallDurationMs?: number }) {
    return this.record('createWebCall', [input], () => ({
      call_id: `call_web_${Math.random().toString(16).slice(2, 14)}`,
      access_token: 'fake-access-token',
      agent_id: input.agentId,
      agent_version: input.agentVersion,
      call_status: 'registered',
      transport: 'livekit',
      url: 'wss://fake.livekit.test',
      ice_servers: [],
    }));
  }

  /** D17 outbound: "Call my phone" and the forwarding test. The platform answers with the registered call. */
  createPhoneCall(input: { fromNumber: string; toNumber: string; agentId?: string; agentVersion?: number; metadata?: Record<string, unknown>; maxCallDurationMs?: number }) {
    return this.record('createPhoneCall', [input], () => ({
      call_id: `call_out_${Math.random().toString(16).slice(2, 14)}`,
      call_type: 'phone_call',
      direction: 'outbound',
      from_number: input.fromNumber,
      to_number: input.toNumber,
      agent_id: input.agentId,
      agent_version: input.agentVersion,
      call_status: 'registered',
      metadata: input.metadata,
    }));
  }

  createPhoneNumber(input: { numberToken: string; agentId: string; country: 'US' | 'CA'; areaCode?: number; tollFree?: boolean; provider?: 'twilio' | 'telnyx'; nickname: string; allowedInboundCountries?: string[] }) {
    return this.record('createPhoneNumber', [input], () => {
      const area = input.areaCode ?? (input.country === 'CA' ? 450 : 620);
      const e164 = `+1${area}${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
      const number: FakePhoneNumber = {
        phone_number: e164,
        phone_number_type: input.provider === 'telnyx' ? 'retell-telnyx' : 'retell-twilio',
        phone_number_pretty: e164,
        nickname: this.config.objectName(input.nickname),
        area_code: area,
        toll_free: input.tollFree ?? false,
        country_code: input.country,
        inbound_agents: [{ agent_id: input.agentId, agent_version: 'latest_published', weight: 1 }],
        inbound_webhook_url: this.config.inboundWebhookUrl(input.numberToken),
      };
      this.phoneNumbers.set(e164, number);
      return { ...number };
    });
  }

  importPhoneNumber(input: { numberToken: string; agentId: string; e164: string; terminationUri: string; sipUsername?: string; sipPassword?: string; nickname: string }) {
    return this.record('importPhoneNumber', [redactSip(input)], () => {
      if (this.phoneNumbers.has(input.e164)) throw notFoundLike(400, `phone number ${input.e164} already exists`);
      const number: FakePhoneNumber = {
        phone_number: input.e164,
        phone_number_type: 'custom',
        phone_number_pretty: input.e164,
        nickname: this.config.objectName(input.nickname),
        inbound_agents: [{ agent_id: input.agentId, agent_version: 'latest_published', weight: 1 }],
        inbound_webhook_url: this.config.inboundWebhookUrl(input.numberToken),
        sip: { termination_uri: input.terminationUri, username: input.sipUsername ?? null, password_seen: Boolean(input.sipPassword) },
        sip_outbound_trunk_config: { termination_uri: input.terminationUri, auth_username: input.sipUsername ?? null, transport: 'TCP' },
      };
      this.phoneNumbers.set(input.e164, number);
      return { ...number };
    });
  }

  /** D16 re-verify. The password is recorded as seen, never kept — like the platform, which never returns it. */
  updateSipTrunk(e164: string, input: { terminationUri: string; username?: string | null; password?: string | null }) {
    return this.record('updateSipTrunk', [e164, { terminationUri: input.terminationUri, username: input.username ?? null, password: input.password ? '[redacted]' : null }], () => {
      const number = this.phoneNumbers.get(e164);
      if (!number) throw notFoundLike(404, `phone number ${e164} not found`);
      const username = input.username ?? number.sip_outbound_trunk_config?.auth_username ?? null;
      number.sip = { termination_uri: input.terminationUri, username, password_seen: Boolean(input.password) || Boolean(number.sip?.password_seen) };
      number.sip_outbound_trunk_config = { termination_uri: input.terminationUri, auth_username: username, transport: number.sip_outbound_trunk_config?.transport ?? 'TCP' };
      return { ...number };
    });
  }

  sipTrunkOf(number: { sip_outbound_trunk_config?: { termination_uri?: string | null; auth_username?: string | null; transport?: string | null } | null }) {
    const trunk = number.sip_outbound_trunk_config ?? null;
    return { terminationUri: trunk?.termination_uri ?? null, username: trunk?.auth_username ?? null, transport: trunk?.transport ?? null };
  }

  /** D16: the retrieval file behind a `knowledge_base_retrieved_contents_url`, seeded by a test. Absent → the CDN's 403. */
  readonly knowledgeFiles = new Map<string, unknown>();

  fetchKnowledgeRetrievals(url: string): Promise<unknown> {
    return this.record('fetchKnowledgeRetrievals', [url.split('?')[0]], () => {
      if (!this.knowledgeFiles.has(url)) throw new Error('knowledge retrievals: HTTP 403');
      return structuredClone(this.knowledgeFiles.get(url));
    });
  }

  updatePhoneNumber(e164: string, input: { agentId?: string; numberToken?: string; nickname?: string }) {
    return this.record('updatePhoneNumber', [e164, input], () => {
      const number = this.phoneNumbers.get(e164);
      if (!number) throw notFoundLike(404, `phone number ${e164} not found`);
      if (input.agentId) number.inbound_agents = [{ agent_id: input.agentId, agent_version: 'latest_published', weight: 1 }];
      if (input.numberToken) number.inbound_webhook_url = this.config.inboundWebhookUrl(input.numberToken);
      if (input.nickname) number.nickname = this.config.objectName(input.nickname);
      return { ...number };
    });
  }

  getPhoneNumber(e164: string) {
    return this.record('getPhoneNumber', [e164], () => {
      const number = this.phoneNumbers.get(e164);
      if (!number) throw notFoundLike(404, `phone number ${e164} not found`);
      return { ...number };
    });
  }

  listPhoneNumbers() {
    return this.record('listPhoneNumbers', [], () => ({ has_more: false, items: [...this.phoneNumbers.values()].map((n) => ({ ...n })) }));
  }

  deletePhoneNumber(e164: string) {
    return this.record('deletePhoneNumber', [e164], () => {
      if (!this.phoneNumbers.delete(e164)) throw notFoundLike(404, `phone number ${e164} not found`);
      this.deleted.add(e164);
      return undefined;
    });
  }

  // ---------------------------------------------------------------- knowledge (D6, W4)

  createKnowledgeBase(input: { name: string; autoRefresh?: boolean; texts?: Array<{ title: string; text: string }>; urls?: string[]; files?: Array<{ filename: string; contentType: string; bytes: Buffer }> }) {
    return this.record('createKnowledgeBase', [{ ...input, files: input.files?.map((f) => ({ filename: f.filename, size: f.bytes.length })) }], () => {
      const kb: FakeKnowledgeBase = {
        knowledge_base_id: `knowledge_base_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        knowledge_base_name: this.config.objectName(input.name),
        status: 'in_progress',
        knowledge_base_sources: [],
        pollsLeft: this.kbIngestPolls,
      };
      this.knowledgeBases.set(kb.knowledge_base_id, kb);
      this.addSourcesTo(kb, input);
      return this.kbView(kb);
    });
  }

  addKnowledgeSources(kbId: string, input: { texts?: Array<{ title: string; text: string }>; urls?: string[]; files?: Array<{ filename: string; contentType: string; bytes: Buffer }> }) {
    return this.record('addKnowledgeSources', [kbId, { ...input, files: input.files?.map((f) => ({ filename: f.filename, size: f.bytes.length })) }], () => {
      const kb = this.kbOrThrow(kbId);
      this.addSourcesTo(kb, input);
      kb.status = 'refreshing_in_progress';
      kb.pollsLeft = this.kbIngestPolls;
      return this.kbView(kb);
    });
  }

  deleteKnowledgeSource(kbId: string, sourceId: string) {
    return this.record('deleteKnowledgeSource', [kbId, sourceId], () => {
      const kb = this.kbOrThrow(kbId);
      const before = kb.knowledge_base_sources.length;
      // Retell will not empty a knowledge base (D9 wizard run, live).
      if (before === 1 && kb.knowledge_base_sources[0]!.source_id === sourceId) throw notFoundLike(400, 'cannot delete the last source, delete the knowledge base instead');
      kb.knowledge_base_sources = kb.knowledge_base_sources.filter((s) => s.source_id !== sourceId);
      if (kb.knowledge_base_sources.length === before) throw notFoundLike(404, `source ${sourceId} not found`);
      return this.kbView(kb);
    });
  }

  getKnowledgeBase(kbId: string) {
    return this.record('getKnowledgeBase', [kbId], () => {
      const kb = this.kbOrThrow(kbId);
      if (kb.status === 'in_progress' || kb.status === 'refreshing_in_progress') {
        if (kb.pollsLeft <= 0) kb.status = kb.failNextIngest ? 'error' : 'complete';
        kb.pollsLeft -= 1;
      }
      return this.kbView(kb);
    });
  }

  listKnowledgeBases() {
    return this.record('listKnowledgeBases', [], () => [...this.knowledgeBases.values()].map((kb) => this.kbView(kb)));
  }

  async findKnowledgeBaseByName(name: string) {
    const wanted = this.config.objectName(name);
    const all = await this.listKnowledgeBases();
    return all.find((kb) => kb.knowledge_base_name === wanted) ?? null;
  }

  deleteKnowledgeBase(kbId: string) {
    return this.record('deleteKnowledgeBase', [kbId], () => {
      this.knowledgeBases.delete(kbId);
      return undefined;
    });
  }

  /** Makes the next ingest end in `error` instead of `complete`. */
  failNextIngest(kbId?: string): void {
    for (const kb of this.knowledgeBases.values()) if (!kbId || kb.knowledge_base_id === kbId) kb.failNextIngest = true;
    this.pendingIngestFailure = true;
  }
  private pendingIngestFailure = false;

  private addSourcesTo(kb: FakeKnowledgeBase, input: { texts?: Array<{ title: string; text: string }>; urls?: string[]; files?: Array<{ filename: string }> }): void {
    if (this.pendingIngestFailure) {
      kb.failNextIngest = true;
      this.pendingIngestFailure = false;
    }
    for (const text of input.texts ?? []) kb.knowledge_base_sources.push({ type: 'text', source_id: `source_${randomUUID().slice(0, 12)}`, title: text.title, content_url: 'https://example.test/text' });
    for (const url of input.urls ?? []) kb.knowledge_base_sources.push({ type: 'url', source_id: `source_${randomUUID().slice(0, 12)}`, url });
    for (const file of input.files ?? []) kb.knowledge_base_sources.push({ type: 'document', source_id: `source_${randomUUID().slice(0, 12)}`, filename: file.filename, file_url: 'https://example.test/file', file_size: 1 });
  }

  private kbOrThrow(kbId: string): FakeKnowledgeBase {
    const kb = this.knowledgeBases.get(kbId);
    if (!kb) throw notFoundLike(404, `knowledge base ${kbId} not found`);
    return kb;
  }

  private kbView(kb: FakeKnowledgeBase) {
    return { knowledge_base_id: kb.knowledge_base_id, knowledge_base_name: kb.knowledge_base_name, status: kb.status, knowledge_base_sources: kb.knowledge_base_sources.map((s) => ({ ...s })) };
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

interface FakePhoneNumber {
  phone_number: string;
  phone_number_type: 'retell-twilio' | 'retell-telnyx' | 'custom';
  phone_number_pretty: string;
  nickname: string;
  area_code?: number;
  toll_free?: boolean;
  country_code?: string;
  inbound_agents: Array<{ agent_id: string; agent_version: string | number; weight: number }>;
  inbound_webhook_url: string;
  sip?: { termination_uri: string; username: string | null; password_seen: boolean };
  sip_outbound_trunk_config?: { termination_uri: string; auth_username: string | null; transport: string };
}

type FakeKbSource =
  | { type: 'text'; source_id: string; title: string; content_url: string }
  | { type: 'url'; source_id: string; url: string }
  | { type: 'document'; source_id: string; filename: string; file_url: string; file_size: number };

interface FakeKnowledgeBase {
  knowledge_base_id: string;
  knowledge_base_name: string;
  status: 'in_progress' | 'complete' | 'error' | 'refreshing_in_progress';
  knowledge_base_sources: FakeKbSource[];
  pollsLeft: number;
  failNextIngest?: boolean;
}

/** The SDK's own error class, so `retellErrorStatus()` classifies it exactly as it would a real answer. */
function notFoundLike(status: number, message: string): Error {
  return Retell.APIError.generate(status, { message }, message, new Headers());
}

function redactSip<T extends { sipPassword?: string }>(input: T): Omit<T, 'sipPassword'> & { sipPassword?: string } {
  const { sipPassword, ...rest } = input;
  return { ...rest, ...(sipPassword ? { sipPassword: '[redacted]' } : {}) };
}

/** Captures ops alerts instead of posting them anywhere. */
export class CapturingAlerts {
  readonly alerts: OpsAlert[] = [];
  readonly service = new OpsAlertService({ name: 'capture', deliver: async (alert) => void this.alerts.push(alert) });
}

@Module({
  imports: [
    AuthModule,
    RedisModule,
    AlertsModule,
    CryptoModule,
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
    KnowledgeModule,
    NotificationsModule,
    NumbersModule,
    ActivationModule,
    VoicesModule,
    WebhooksModule,
    ScheduledModule,
    SupportModule,
    AdminModule,
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
  /** D12: the staff tenant, for `/admin/*` tokens (mint with `{ mfa: true }`). */
  staffTenant: FakeAuth0Tenant;
  retell: FakeRetellGateway;
  provider: ScriptedPromptProvider;
  /** D6: every ops alert the app raised, in order. */
  alerts: CapturingAlerts;
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
  const alerts = new CapturingAlerts();

  const moduleRef = await Test.createTestingModule({ imports: [D5TestModule] })
    .overrideProvider(RetellGateway)
    .useValue(retell)
    .overrideProvider(PROMPT_PROVIDER)
    .useValue(provider)
    .overrideProvider(OpsAlertService)
    .useValue(alerts.service)
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
    staffTenant,
    retell,
    provider,
    alerts,
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
