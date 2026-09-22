import { Injectable, Logger } from '@nestjs/common';
import Retell, { toFile } from 'retell-sdk';
import { RetellConfig } from './retell.config';
import type { AgentSpec, AllowOptions, InboundAllow, InboundDecline, KnowledgeSourcesInput, LlmSpec } from './retell.types';

/**
 * The version tag every phone number is bound to (§9.9, ADR 0003 §7). Retell resolves it
 * to the most recently *published* agent version, so a draft never answers a real call.
 */
const LATEST_PUBLISHED = 'latest_published';

/**
 * The only file that imports the Retell SDK (CLAUDE.md, "Retell isolation"; §13.1).
 *
 * It owns three things the rest of the backend must not know:
 *   - webhook URL construction (via RetellConfig),
 *   - the shape of Retell's request/response objects, including the inbound-webhook
 *     answer that D2 established (ADR 0003),
 *   - retry/backoff and timeouts, delegated to the SDK: `maxRetries` with exponential
 *     backoff on 408/409/429/5xx and connection errors, `timeout` per attempt.
 *
 * It does not own the tier → stack mapping's *values*. Those come from
 * `agent_stack_configs` (SA6) through `stackFor()` in retell.types.ts; this class only
 * applies them. Postgres is the source of truth and every Retell object is a projection
 * of it (architecture §8), so nothing here is read back to decide product behaviour.
 *
 * Nothing here runs on the inbound hot path (§13.9): that path is Redis-only and only
 * *shapes* its answer with the two pure builders at the bottom.
 */
@Injectable()
export class RetellGateway {
  private readonly log = new Logger(RetellGateway.name);
  private sdk?: Retell;

  constructor(readonly config: RetellConfig) {}

  /**
   * Built on first use, not in the constructor: the gateway is instantiated at boot in
   * every process (api and worker), and an unconfigured Retell must not stop either from
   * starting. The instance is memoised, so spying on `gw.client.x` in a test and calling
   * a gateway method afterwards hit the same object.
   */
  get client(): Retell {
    this.config.assertConfigured();
    return (this.sdk ??= new Retell({
      apiKey: this.config.apiKey,
      timeout: this.config.timeoutMs,
      maxRetries: this.config.maxRetries,
    }));
  }

  // ---------------------------------------------------------------- voices (W3)

  /** Global catalogue; cached in `voices` by the voice-cache job (§13.11). */
  listVoices() {
    return this.client.voice.list();
  }

  // ---------------------------------------------------------------- LLM (§13.3)

  createLlm(spec: LlmSpec) {
    return this.client.llm.create(this.llmBody(spec));
  }

  /** Edits the LLM's latest draft in place. Publishing the *agent* snapshots it. */
  updateLlm(llmId: string, spec: LlmSpec) {
    return this.client.llm.update(llmId, this.llmBody(spec));
  }

  deleteLlm(llmId: string) {
    return this.client.llm.delete(llmId);
  }

  private llmBody(spec: LlmSpec): Retell.LlmCreateParams {
    return {
      model: spec.model,
      general_prompt: spec.prompt,
      begin_message: spec.beginMessage ?? undefined,
      start_speaker: 'agent',
      knowledge_base_ids: spec.knowledgeBaseIds,
      default_dynamic_variables: spec.defaultDynamicVariables,
      general_tools: [
        { type: 'end_call', name: 'end_call', description: 'End the call when the conversation is over.' },
        ...(spec.transferNumbers ?? []).map<Retell.LlmCreateParams.TransferCallTool>((number, i) => ({
          type: 'transfer_call',
          name: `transfer_${i + 1}`,
          description: `Transfer the caller to ${number} when they ask for a person.`,
          transfer_destination: { type: 'predefined', number },
          transfer_option: { type: 'cold_transfer' },
        })),
      ],
    };
  }

  // ---------------------------------------------------------------- agent (§9.9, §13.6)

  /** Creates version 0 as a draft. Nothing answers on it until `publish()`. */
  createAgent(spec: AgentSpec) {
    return this.client.agent.create({ ...this.agentBody(spec), response_engine: this.engine(spec) });
  }

  /**
   * Updates the agent's latest *draft*. A published version is immutable — Retell answers
   * 422 "Cannot update published agent other than version title" — so when the latest
   * version is published, call `createAgentVersion()` first (found on D2, ADR 0003 §7).
   */
  updateAgent(agentId: string, spec: AgentSpec) {
    return this.client.agent.update(agentId, { ...this.agentBody(spec), response_engine: this.engine(spec) });
  }

  /** Opens draft N+1 from `baseVersion`. The only way to edit once N is published. */
  createAgentVersion(agentId: string, baseVersion: number) {
    return this.client.agent.createVersion(agentId, { base_version: baseVersion });
  }

  getAgent(agentId: string, version?: number) {
    return this.client.agent.retrieve(agentId, version === undefined ? undefined : { version });
  }

  listAgentVersions(agentId: string) {
    return this.client.agent.listVersions(agentId, { sort_order: 'descending', limit: 100 });
  }

  /**
   * Publishes one draft version in place. A version, once published, is immutable —
   * which is exactly `agent_versions`' contract, so `agents.published_version` and
   * Retell's published version move together (§13.6).
   */
  async publishAgent(agentId: string, version: number, title?: string): Promise<void> {
    // Not `client.agent.publish()`: Retell answers 200 with `content-type: application/json`
    // and an empty body, and the SDK's JSON parse throws on it (found on D2). Ask for the
    // raw response and judge it by status. Retries and backoff still apply.
    const response = (await this.client.post(`/publish-agent-version/${encodeURIComponent(agentId)}`, {
      body: { version, version_title: title },
      __binaryResponse: true,
    })) as Response;
    if (!response.ok) throw new Error(`publish-agent-version ${agentId} v${version}: HTTP ${response.status}`);
  }

  deleteAgent(agentId: string) {
    return this.client.agent.delete(agentId);
  }

  private engine(spec: AgentSpec): Retell.AgentCreateParams.ResponseEngineRetellLm {
    return { type: 'retell-llm', llm_id: spec.llmId };
  }

  private agentBody(spec: AgentSpec): Omit<Retell.AgentCreateParams, 'response_engine'> {
    return {
      agent_name: this.config.objectName(spec.name),
      voice_id: spec.voiceId,
      voice_model: spec.voiceModel,
      voice_speed: spec.voiceSpeed,
      voice_temperature: spec.voiceTemperature,
      language: spec.language,
      max_call_duration_ms: spec.maxCallDurationMs,
      post_call_analysis_data: spec.postCallAnalysis,
      post_call_analysis_model: spec.postCallAnalysisModel,  // typed by AgentSpec; see retell.types.ts
      denoising_mode: spec.denoisingMode,
      stt_mode: spec.sttMode,
      timezone: spec.timezone,
      // Ours, always. The account-level webhook is ignored once this is set.
      webhook_url: this.config.agentWebhookUrl,
      webhook_events: ['call_started', 'call_ended', 'call_analyzed', 'transfer_started', 'transfer_ended'],
      webhook_timeout_ms: 10_000,
      // Keep transcripts and recordings on Retell; §17 retention is enforced by our
      // own delete job, not by Retell's defaults.
      data_storage_setting: 'everything',
      opt_in_signed_url: true,
    };
  }

  // ---------------------------------------------------------------- calls (§13.4)

  /**
   * Browser test call (W5). `agentVersion` is mandatory here on purpose: a draft is
   * only ever reachable through this parameter, and passing it explicitly is what keeps
   * "numbers always run latest_published" true (§9.9).
   */
  createWebCall(input: {
    agentId: string;
    agentVersion: number;
    dynamicVariables?: Record<string, string>;
    metadata: Record<string, unknown>;
    maxCallDurationMs?: number;
  }) {
    return this.client.call.createWebCall({
      agent_id: input.agentId,
      agent_version: input.agentVersion,
      retell_llm_dynamic_variables: input.dynamicVariables,
      metadata: input.metadata,
      agent_override:
        input.maxCallDurationMs === undefined
          ? undefined
          : { agent: { max_call_duration_ms: input.maxCallDurationMs } },
    });
  }

  /** Outbound (Phase 2, §14.2). Same balance/cap checks as inbound happen before this. */
  createPhoneCall(input: {
    fromNumber: string;
    toNumber: string;
    /** Required when `fromNumber` has no outbound agent bound. */
    agentId?: string;
    agentVersion?: number;
    metadata?: Record<string, unknown>;
    maxCallDurationMs?: number;
  }) {
    return this.client.call.createPhoneCall({
      from_number: input.fromNumber,
      to_number: input.toNumber,
      override_agent_id: input.agentId,
      override_agent_version: input.agentVersion,
      metadata: input.metadata,
      agent_override:
        input.maxCallDurationMs === undefined
          ? undefined
          : { agent: { max_call_duration_ms: input.maxCallDurationMs } },
    });
  }

  getCall(callId: string) {
    return this.client.call.retrieve(callId);
  }

  /** Nightly reconciliation (§14.2): everything Retell saw in a window, vs `calls`. One page. */
  listCalls(sinceMs: number, untilMs = Date.now(), paginationKey?: string) {
    return this.client.call.list({
      filter_criteria: { start_timestamp: { op: 'bt', type: 'range', value: [sinceMs, untilMs] } },
      sort_order: 'descending',
      limit: LIST_CALLS_PAGE,
      pagination_key: paginationKey,
    });
  }

  /**
   * D7 `reconcile-calls`: every call the platform started in `[sinceMs, untilMs)`, paged
   * until the platform runs out, reduced to the facts the reconciliation compares. `partial`
   * is true when the page cap was hit — the caller records the run as partial rather than
   * reporting drift against an incomplete list.
   */
  async listCallsInWindow(sinceMs: number, untilMs: number, maxPages = LIST_CALLS_MAX_PAGES): Promise<{ calls: ProviderCallFacts[]; partial: boolean }> {
    const calls: ProviderCallFacts[] = [];
    const seen = new Set<string>();
    let paginationKey: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const { items, hasMore, paginationKey: next } = callListPage(await this.listCalls(sinceMs, untilMs, paginationKey));
      for (const raw of items) {
        const facts = providerCallFacts(raw);
        if (facts && !seen.has(facts.call_id)) {
          seen.add(facts.call_id);
          calls.push(facts);
        }
      }
      // The platform says when it is done; a cursor that does not move is treated the same.
      if (!hasMore || items.length === 0 || !next || next === paginationKey) return { calls, partial: false };
      paginationKey = next;
    }
    return { calls, partial: true };
  }

  deleteCall(callId: string) {
    return this.client.call.delete(callId);
  }

  // ---------------------------------------------------------------- numbers (§11, §13.8)

  /** Option A/B: a number Retell buys from Twilio/Telnyx. US/CA only today (ADR 0003 §4). */
  createPhoneNumber(input: {
    numberToken: string;
    agentId: string;
    country: 'US' | 'CA';
    areaCode?: number;
    tollFree?: boolean;
    provider?: 'twilio' | 'telnyx';
    nickname: string;
    allowedInboundCountries?: string[];
  }) {
    return this.client.phoneNumber.create({
      country_code: input.country,
      area_code: input.areaCode,
      toll_free: input.tollFree,
      number_provider: input.provider,
      nickname: this.config.objectName(input.nickname),
      inbound_agents: this.binding(input.agentId),
      inbound_webhook_url: this.config.inboundWebhookUrl(input.numberToken),
      allowed_inbound_country_list: input.allowedInboundCountries,
    });
  }

  /** Option C: the customer's own SIP trunk. Costs us 0/min (§5.3). */
  importPhoneNumber(input: {
    numberToken: string;
    agentId: string;
    e164: string;
    terminationUri: string;
    sipUsername?: string;
    sipPassword?: string;
    nickname: string;
  }) {
    return this.client.phoneNumber.import({
      phone_number: input.e164,
      termination_uri: input.terminationUri,
      sip_trunk_auth_username: input.sipUsername,
      sip_trunk_auth_password: input.sipPassword,
      nickname: this.config.objectName(input.nickname),
      inbound_agents: this.binding(input.agentId),
      inbound_webhook_url: this.config.inboundWebhookUrl(input.numberToken),
    });
  }

  /** Re-point a number (agent change, token rotation). Every field given replaces. */
  updatePhoneNumber(e164: string, input: { agentId?: string; numberToken?: string; nickname?: string }) {
    return this.client.phoneNumber.update(e164, {
      inbound_agents: input.agentId ? this.binding(input.agentId) : undefined,
      inbound_webhook_url: input.numberToken ? this.config.inboundWebhookUrl(input.numberToken) : undefined,
      nickname: input.nickname ? this.config.objectName(input.nickname) : undefined,
    });
  }

  getPhoneNumber(e164: string) {
    return this.client.phoneNumber.retrieve(e164);
  }

  listPhoneNumbers() {
    return this.client.phoneNumber.list();
  }

  deletePhoneNumber(e164: string) {
    return this.client.phoneNumber.delete(e164);
  }

  /**
   * One agent, weight 1, pinned to the `latest_published` tag — the §9.9 rule, without a
   * Retell call on every publish. The tag is **not** the default: a binding with no
   * `agent_version` runs `latest`, unpublished drafts included, so an edit after publish
   * would answer live calls (ADR 0003 §7, verified on D2).
   */
  private binding(agentId: string): Retell.PhoneNumberCreateParams.InboundAgent[] {
    return [{ agent_id: agentId, agent_version: LATEST_PUBLISHED, weight: 1 }];
  }

  // ---------------------------------------------------------------- knowledge (W4)

  /**
   * One knowledge base per agent (ADR 0003 §8). `name` is the caller's deterministic
   * name; the environment prefix is added here, so `findKnowledgeBaseByName` must be
   * given the same bare name.
   */
  async createKnowledgeBase(input: KnowledgeSourcesInput & { name: string; autoRefresh?: boolean }) {
    return this.client.knowledgeBase.create({
      knowledge_base_name: this.config.objectName(input.name),
      enable_auto_refresh: input.autoRefresh,
      ...(await this.knowledgeSourceParams(input)),
    });
  }

  async addKnowledgeSources(kbId: string, input: KnowledgeSourcesInput) {
    return this.client.knowledgeBase.addSources(kbId, await this.knowledgeSourceParams(input));
  }

  listKnowledgeBases() {
    return this.client.knowledgeBase.list();
  }

  /** The idempotency lookup: a KB created by a run that died before persisting its id. */
  async findKnowledgeBaseByName(name: string) {
    const wanted = this.config.objectName(name);
    const all = await this.listKnowledgeBases();
    return all.find((kb) => kb.knowledge_base_name === wanted) ?? null;
  }

  private async knowledgeSourceParams(input: KnowledgeSourcesInput): Promise<Retell.KnowledgeBaseAddSourcesParams> {
    const files = input.files?.length
      ? await Promise.all(input.files.map((f) => toFile(f.bytes, f.filename, { type: f.contentType })))
      : undefined;
    return {
      knowledge_base_texts: input.texts?.length ? input.texts : undefined,
      knowledge_base_urls: input.urls?.length ? input.urls : undefined,
      knowledge_base_files: files,
    };
  }

  deleteKnowledgeSource(kbId: string, sourceId: string) {
    return this.client.knowledgeBase.deleteSource(sourceId, { knowledge_base_id: kbId });
  }

  /** Poll `status` until `complete` or `error`; ingestion is asynchronous. */
  getKnowledgeBase(kbId: string) {
    return this.client.knowledgeBase.retrieve(kbId);
  }

  deleteKnowledgeBase(kbId: string) {
    return this.client.knowledgeBase.delete(kbId);
  }

  // ---------------------------------------------------------------- account

  /** Our Retell-side ceiling. The per-workspace cap (§14.3) must sum below this. */
  getConcurrency() {
    return this.client.concurrency.retrieve();
  }

  // ---------------------------------------------------------------- webhooks (§13.10, §14.2)

  /**
   * `x-retell-signature` = `v=<ms>,d=<hmac-sha256-hex(rawBody + ms, apiKey)>`, accepted
   * within ±5 minutes. It must be computed over the bytes on the wire — that is why
   * modules/webhooks keeps `request.rawBody` — and it is keyed with the API key, not a
   * separate secret (ADR 0003 §A).
   */
  async verifyWebhookSignature(rawBody: Buffer | string | undefined, signature: string | undefined): Promise<boolean> {
    if (!rawBody || !signature) return false;
    if (!this.config.configured) {
      // An empty key would just never match. Say why, rather than logging a flood of
      // "bad signature" on an environment that is only missing RETELL_API_KEY.
      this.log.error(`cannot verify a Retell webhook: ${this.config.missing.join(', ')} unset`);
      return false;
    }
    const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    try {
      return await Retell.verify(body, this.config.apiKey, signature);
    } catch (error) {
      this.log.warn(`signature check threw: ${String(error)}`);
      return false;
    }
  }

  /** Test helper and fixture generator: produce a signature Retell would accept. */
  signWebhookBody(rawBody: string): Promise<string> {
    this.config.assertConfigured();
    return Retell.sign(rawBody, this.config.apiKey);
  }

  // ---------------------------------------------------------------- inbound answers (§13.9)

  /** Pure. Used on the hot path, so it does no I/O and throws on nothing. */
  static inboundAllow(options: AllowOptions): InboundAllow {
    const call_inbound: InboundAllow['call_inbound'] = {
      override_agent_id: options.agentId,
      dynamic_variables: options.dynamicVariables,
      metadata: options.metadata,
    };
    if (options.agentVersion !== undefined) call_inbound.override_agent_version = options.agentVersion;
    if (options.maxCallDurationMs !== undefined) {
      call_inbound.agent_override = { agent: { max_call_duration_ms: clampDuration(options.maxCallDurationMs) } };
    }
    return { call_inbound };
  }

  /**
   * The decline mechanism (§21, ADR 0003 §1): HTTP 200 with `reject: true`. Anything
   * else — 4xx, 5xx, a timeout — is *not* a decline: Retell falls back to the number's
   * bound agent and answers the call. A decline creates no call on Retell's side and
   * costs nothing; our own `calls` row (status missed, decline_reason) is written by an
   * enqueued job, never here.
   */
  static inboundDecline(): InboundDecline {
    return { call_inbound: { reject: true } };
  }
}

/**
 * The HTTP status behind a failed gateway call, or undefined for a network/timeout error.
 * The only place the SDK's error class is named; every other module classifies on the
 * number (4xx is the request's fault and permanent, the rest is worth a retry).
 */
/** Retell's list-calls page size; a window with more than 1000 × 10 calls is recorded as partial. */
export const LIST_CALLS_PAGE = 1000;
export const LIST_CALLS_MAX_PAGES = 10;

/** What reconciliation compares, reduced from a `CallResponse`. `cost_cents` is `combined_cost` rounded (ADR 0003 §3). */
export interface ProviderCallFacts {
  call_id: string;
  call_type: 'phone_call' | 'web_call' | 'unknown';
  call_status: string | null;
  start_timestamp: number | null;
  end_timestamp: number | null;
  duration_s: number | null;
  disconnection_reason: string | null;
  cost_cents: number | null;
  /** `metadata.tenant_id` when the call carried our metadata (ADR 0011 §2). */
  workspace_id: string | null;
}

/**
 * One page of `list-calls` as retell-sdk 6 returns it: `{has_more, items, pagination_key}`
 * (`CallListResponse`). Anything else is a provider error, never "zero calls" — the
 * reconciliation would otherwise report every call in `calls` as extra and page ops with
 * false drift every night. Pinned by `retell.list-calls.test.ts` against the SDK type.
 */
export function callListPage(response: unknown): { items: unknown[]; hasMore: boolean; paginationKey?: string } {
  if (!response || typeof response !== 'object') throw new Error(`list-calls answered ${response === null ? 'null' : typeof response}, not a page`);
  const r = response as Record<string, unknown>;
  if (!Array.isArray(r.items)) throw new Error('list-calls answered without an items array');
  return {
    items: r.items,
    hasMore: r.has_more === true,
    paginationKey: typeof r.pagination_key === 'string' && r.pagination_key ? r.pagination_key : undefined,
  };
}

export function providerCallFacts(raw: unknown): ProviderCallFacts | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.call_id !== 'string' || !r.call_id) return null;
  const start = typeof r.start_timestamp === 'number' && Number.isFinite(r.start_timestamp) ? r.start_timestamp : null;
  const end = typeof r.end_timestamp === 'number' && Number.isFinite(r.end_timestamp) ? r.end_timestamp : null;
  const cost = (r.call_cost as { combined_cost?: unknown } | undefined)?.combined_cost;
  const metadata = r.metadata && typeof r.metadata === 'object' ? (r.metadata as Record<string, unknown>) : {};
  return {
    call_id: r.call_id,
    call_type: r.call_type === 'phone_call' || r.call_type === 'web_call' ? r.call_type : 'unknown',
    call_status: typeof r.call_status === 'string' ? r.call_status : null,
    start_timestamp: start,
    end_timestamp: end,
    duration_s: start !== null && end !== null && end >= start ? Math.round(((end - start) / 1000) * 1000) / 1000 : null,
    disconnection_reason: typeof r.disconnection_reason === 'string' ? r.disconnection_reason : null,
    cost_cents: typeof cost === 'number' && Number.isFinite(cost) ? Math.round(cost) : null,
    workspace_id: typeof metadata.tenant_id === 'string' ? metadata.tenant_id : null,
  };
}

export function retellErrorStatus(error: unknown): number | undefined {
  if (error instanceof Retell.APIError) return typeof error.status === 'number' ? error.status : undefined;
  return undefined;
}

/** True for a Retell answer that means "no such object" — a delete that already happened. */
export function isRetellNotFound(error: unknown): boolean {
  return retellErrorStatus(error) === 404;
}

/** Retell rejects values outside [60 s, 2 h]; clamping keeps a tiny balance callable. */
export function clampDuration(ms: number): number {
  return Math.min(7_200_000, Math.max(60_000, Math.round(ms)));
}
