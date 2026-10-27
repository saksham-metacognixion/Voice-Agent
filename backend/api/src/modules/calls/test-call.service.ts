import { Inject, Injectable, Logger } from '@nestjs/common';
import { type Agent, type AgentVersion, adminDb, withWorkspace } from '@portal/db';
import type { AgentTier, TestPhoneCallRequest, TestPhoneCallResponse, TestWebCallResponse } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { AgentDraftSyncService, settingsOf } from '../agents';
import type { WorkspaceContext } from '../auth';
import { PlatformConfigService } from '../config';
import { REDIS, RedisCache, type RedisLike } from '../redis';
import { RetellGateway } from '../retell';
import { WalletService } from '../wallet';
import { MintSlot, assertUnderTestWindow, countTestCall, headroom, liveCalls, webCallTransport } from './call-headroom';
import { checkTestDestination } from './call-my-phone';
import { RecordingSigner } from './recording';

/** How long a live-transcript token outlives the call's ceiling (ADR 0011's reservation slack). */
const LIVE_TOKEN_SLACK_S = 300;

type TestTarget = { agent: Agent; version: AgentVersion };

/** A version that may be rung now: its platform copy, the rate it bills at and its ceiling. */
type ReadyTest = {
  rate: number;
  balance: number;
  tier: AgentTier;
  retellAgentId: string;
  retellAgentVersion: number;
  maxMs: number;
  /** The plan's concurrency cap, null = no limit — what the slot is re-checked against. */
  cap: number | null;
};

/**
 * §13.4 — the browser test call (W5, D3 Test tab).
 *
 *   POST /agents/:id/test/web {version_no} → {call_id, access_token, rate, balance}
 *
 * The request half. No `calls` row is written here: `call_started` creates it
 * from the metadata below (`is_test`, channel `web`), captures the rate, and reserves the
 * slot; `call_ended` bills it and `call_analyzed` fills the after-call card (§14.2). A
 * token that is never used costs nothing and leaves nothing behind.
 *
 * The version is passed to the platform explicitly — a draft is only ever reachable that
 * way, which is what keeps numbers on `latest_published` (§9.9, ADR 0003 §7). The tier in
 * the metadata is the *version's*, so a Premium draft is tested and billed at Premium
 * before anything is published.
 *
 * The call's ceiling is sized the way the inbound path sizes one (ADR 0011 §1): from what
 * is left of the wallet **after the other live calls' reservations** in `active:{ws}`, and
 * only while the plan's concurrency cap has a slot free. Sized from the raw balance, two
 * test calls in two tabs — or one beside a live phone call — could each be told they may
 * run the whole balance and together overdraw it past the grace. Sizing only reads, so
 * the line is then taken atomically before the platform is asked (`MintSlot`): two tabs
 * pressing in the same second cannot both pass on the same free line and credits.
 */
@Injectable()
export class TestCallService {
  private readonly log = new Logger(TestCallService.name);

  constructor(
    private readonly retell: RetellGateway,
    private readonly wallet: WalletService,
    private readonly config: PlatformConfigService,
    private readonly cache: RedisCache,
    @Inject(REDIS) private readonly redis: RedisLike,
    private readonly signer: RecordingSigner,
    private readonly draftSync: AgentDraftSyncService,
  ) {}

  async startWebCall(ctx: WorkspaceContext, agentId: string, versionNo?: number): Promise<TestWebCallResponse> {
    await this.assertTestsOn();
    const target = await this.target(ctx, agentId, versionNo);
    const { agent, version } = target;
    const ready = await this.ready(ctx, target);
    const slot = await this.takeSlot(ctx.workspaceId, ready);

    const call = await this.retell
      .createWebCall({
        agentId: ready.retellAgentId,
        agentVersion: ready.retellAgentVersion,
        metadata: { tenant_id: ctx.workspaceId, agent_id: agent.id, version_no: version.versionNo, tier: ready.tier, test: true },
        maxCallDurationMs: ready.maxMs,
      })
      .catch(async (error: unknown) => {
        await slot.release();
        this.log.warn(`agent ${agent.id} v${version.versionNo}: test call refused upstream: ${String(error)}`);
        throw new AppError('UPSTREAM_UNAVAILABLE', 'We could not start the test call just now. Try again in a moment.');
      });
    await slot.bind(call.call_id);

    // Counted once the platform has minted: a refusal upstream is not one of the ten.
    await countTestCall(this.cache, ctx.workspaceId);

    // The live transcript's credential (LiveTranscriptRelay): this call, this workspace,
    // valid for as long as the call may run plus the slack a reservation gets.
    const live = this.signer.sign({ callId: call.call_id, workspaceId: ctx.workspaceId }, new Date(), Math.ceil(ready.maxMs / 1_000) + LIVE_TOKEN_SLACK_S, 'live');

    return {
      call_id: call.call_id,
      access_token: call.access_token,
      rate: ready.rate,
      balance: Math.round(ready.balance * 100) / 100,
      version_no: version.versionNo,
      max_call_duration_s: Math.floor(ready.maxMs / 1_000),
      live_token: live.token,
      ...webCallTransport(call),
    };
  }

  /**
   * D17 "Call my phone" (W5, spec p. 24, Phase 2): the same version, the same checks and
   * the same ceiling as the browser test — and the same ten-an-hour window, which the two
   * share — but the agent rings the customer's own phone from one of the workspace's
   * numbers. On top of the browser test's checks:
   *
   *   - a paid pack first. The trial is browser test calls only (§5.4), and the portal
   *     hides the button until the first purchase (W7);
   *   - a live number to call from: the one answering for this agent, else any of the
   *     workspace's. The draft is passed to the platform as an override, never bound to
   *     the number, which keeps running `latest_published` (§9.9);
   *   - a destination the customer could plausibly own (`checkTestDestination`): real, in
   *     the number's or the workspace's country, not premium-rate, and not one of the
   *     platform's own numbers — that would ring another agent, possibly someone else's.
   *
   * The call is billed by `call_ended` at the version's rate like any test call
   * (`metadata.test`), shows in D2 as an outbound test, and its after-call card fills the
   * same way. A phone that is not answered ends unconnected and is billed zero.
   */
  async startPhoneCall(ctx: WorkspaceContext, agentId: string, body: TestPhoneCallRequest): Promise<TestPhoneCallResponse> {
    await this.assertTestsOn();
    const target = await this.target(ctx, agentId, body.version_no);
    const { agent, version } = target;

    const line = await withWorkspace(ctx, async (db) => {
      const [tenant, paid, numbers] = await Promise.all([
        db.tenant.findUniqueOrThrow({ where: { id: ctx.workspaceId }, select: { country: true } }),
        db.purchase.count({ where: { tenantId: ctx.workspaceId, status: 'paid' } }),
        db.phoneNumber.findMany({
          where: { tenantId: ctx.workspaceId, status: 'active', pausedAt: null, e164: { not: null } },
          select: { id: true, e164: true, country: true, agentId: true },
          orderBy: { createdAt: 'asc' },
        }),
      ]);
      return { tenant, paid, numbers };
    });
    if (line.paid === 0) throw new AppError('PURCHASE_REQUIRED', 'Calling your phone opens once you have bought a pack. Until then, test in the browser.');
    const from = line.numbers.find((n) => n.agentId === agent.id) ?? line.numbers[0];
    if (!from?.e164) throw new AppError('NO_NUMBER', 'Your workspace has no live number to call from yet.');

    const countries = [...new Set([from.country, line.tenant.country].filter((c): c is string => Boolean(c)))];
    const destination = checkTestDestination(body.to, countries);
    if (!destination.ok) {
      const [code, message] =
        destination.reason === 'country'
          ? (['DESTINATION_COUNTRY', `We can call a phone in ${countries.join(' or ')} from this number.`] as const)
          : destination.reason === 'type'
            ? (['DESTINATION_TYPE', 'That kind of number cannot be called for a test. Use a mobile or a landline.'] as const)
            : (['VALIDATION_FAILED', 'That is not a phone number we can call.'] as const);
      throw new AppError(code, message, [{ field: 'to', message }]);
    }
    // Across workspaces on purpose: any number on the platform answers with an agent, and
    // so does a line forwarded to one (Option B, `forwarding_from`) — the customer's own
    // business line, most likely, which would loop the agent back to itself on both legs.
    const ours = await adminDb.phoneNumber.findFirst({
      where: { OR: [{ e164: destination.e164 }, { forwardingFrom: destination.e164 }], status: { not: 'released' } },
      select: { id: true },
    });
    if (ours) {
      const message = 'That number is answered by an agent, directly or by forwarding. Use a mobile or landline that rings a person.';
      throw new AppError('DESTINATION_IS_AGENT', message, [{ field: 'to', message }]);
    }

    const ready = await this.ready(ctx, target);
    const slot = await this.takeSlot(ctx.workspaceId, ready);
    const call = await this.retell
      .createPhoneCall({
        fromNumber: from.e164,
        toNumber: destination.e164,
        agentId: ready.retellAgentId,
        agentVersion: ready.retellAgentVersion,
        metadata: { tenant_id: ctx.workspaceId, agent_id: agent.id, version_no: version.versionNo, tier: ready.tier, test: true, number_id: from.id },
        maxCallDurationMs: ready.maxMs,
      })
      .catch(async (error: unknown) => {
        await slot.release();
        this.log.warn(`agent ${agent.id} v${version.versionNo}: call-my-phone refused upstream: ${String(error)}`);
        throw new AppError('UPSTREAM_UNAVAILABLE', 'We could not place the call just now. Try again in a moment.');
      });
    await slot.bind(call.call_id);

    await countTestCall(this.cache, ctx.workspaceId);
    await withWorkspace(ctx, (db) =>
      db.auditLog.create({
        data: {
          tenantId: ctx.workspaceId,
          actorUserId: ctx.userId,
          action: 'agent.test_phone_call',
          targetType: 'agent',
          targetId: agent.id,
          // The country, not the number: the audit log is read by every owner and admin.
          metaJson: { call_id: call.call_id, version_no: version.versionNo, from_number_id: from.id, to_country: destination.country },
        },
      }),
    ).catch((error: unknown) => this.log.warn(`agent ${agent.id}: call-my-phone audit row not written: ${String(error)}`));

    return {
      call_id: call.call_id,
      from_number: from.e164,
      to_number: destination.e164,
      rate: ready.rate,
      balance: Math.round(ready.balance * 100) / 100,
      version_no: version.versionNo,
      max_call_duration_s: Math.floor(ready.maxMs / 1_000),
    };
  }

  private async assertTestsOn(): Promise<void> {
    if (await this.config.killSwitch('pause_web_tests')) {
      throw new AppError('TESTS_PAUSED', 'Test calls are paused for a few minutes. Please try again shortly.');
    }
  }

  /** The agent and the version under test (default: the draft), with a script to ring. */
  private target(ctx: WorkspaceContext, agentId: string, versionNo?: number): Promise<TestTarget> {
    return withWorkspace(ctx, async (db) => {
      const tenant = await db.tenant.findUniqueOrThrow({ where: { id: ctx.workspaceId }, select: { pausedAt: true } });
      if (tenant.pausedAt) throw new AppError('WORKSPACE_PAUSED', 'This workspace is paused. Contact support to resume it.');
      const agent = await db.agent.findFirst({ where: { id: agentId, tenantId: ctx.workspaceId, deletedAt: null } });
      if (!agent) throw AppError.notFound('Agent');
      const no = versionNo ?? agent.draftVersion ?? agent.publishedVersion;
      if (!no) throw new AppError('AGENT_NOT_GENERATED', 'Generate the agent before testing it.');
      const version = await db.agentVersion.findUnique({ where: { agentId_versionNo: { agentId, versionNo: no } } });
      if (!version) throw AppError.notFound('Version');
      // Nothing to ring yet: the brief has not been turned into a script. Distinct from a
      // version that has one and is still reaching the platform (VERSION_SYNCING below).
      if (!version.promptText) throw new AppError('AGENT_NOT_GENERATED', 'Generate the agent before testing it.');
      return { agent, version };
    });
  }

  /**
   * Everything between "this version may be tested" and minting: the rate for its tier,
   * the wallet after the other live calls, the plan's free line, the hourly window, the
   * draft's platform copy, and the call's ceiling.
   */
  private async ready(ctx: WorkspaceContext, { agent, version }: TestTarget): Promise<ReadyTest> {
    const settings = settingsOf(version, agent);
    const { rate } = await this.config.rateFor(settings.tier);
    const balance = await this.wallet.balance(ctx.workspaceId);
    if (!(balance > 0)) throw new AppError('NO_CREDITS', 'You are out of credits. Buy a pack to keep testing.');

    // The other live calls: their count is the concurrency check, their reservations are
    // what this call must leave alone (call-headroom.ts).
    const live = await liveCalls(this.redis, ctx.workspaceId, this.log);
    const caps = await this.config.capsFor(ctx.workspaceId).catch(() => null);
    const room = headroom({ balance, live, cap: caps?.concurrency_cap, rate, maxDurationS: settings.max_call_duration_s });
    if (!room.ok && room.reason === 'cap') throw concurrencyLimit(room.cap);
    if (!room.ok) throw creditsHeld();

    await assertUnderTestWindow(this.cache, ctx.workspaceId);

    // The draft is re-synced before every test of it: W3's voice and language edits are
    // saved onto the version without a platform round trip, and a test must ring what the
    // customer built. A published or older version is immutable and already has its copy.
    let retellAgentId = agent.retellAgentId;
    let retellAgentVersion = version.retellAgentVersion;
    if (version.publishedAt === null && version.versionNo === agent.draftVersion && version.promptText) {
      const synced = await this.draftSync.syncVersion(ctx.workspaceId, agent.id, version.versionNo).catch((error: unknown) => {
        this.log.warn(`agent ${agent.id} v${version.versionNo}: draft sync before a test call failed: ${String(error)}`);
        throw new AppError('UPSTREAM_UNAVAILABLE', 'We could not prepare the test call just now. Try again in a moment.');
      });
      if (synced.status === 'ok') {
        retellAgentId = synced.retellAgentId;
        retellAgentVersion = synced.retellAgentVersion;
      }
    }
    if (!retellAgentId || retellAgentVersion === null) {
      // Not the brief's fault: the version exists and has a prompt, the platform copy is
      // still being written (a test straight after Improve). Its own code, so the portal
      // does not answer it with "tell us more about the business" (QA-021).
      throw new AppError('VERSION_SYNCING', 'This version is still being prepared. Try again in a few seconds.');
    }

    // min(the version's ceiling, what the wallet covers after the other live calls),
    // inside the platform's [60 s, 2 h] — the inbound path's formula (ADR 0011 §1).
    return { rate, balance, tier: settings.tier, retellAgentId, retellAgentVersion, maxMs: room.maxMs, cap: room.cap };
  }

  /** The line `ready()` sized, taken atomically before minting. A lost race is the refusal `ready()` would have given. */
  private async takeSlot(workspaceId: string, ready: ReadyTest): Promise<MintSlot> {
    const slot = await MintSlot.take(this.redis, this.log, { workspaceId, maxMs: ready.maxMs, rate: ready.rate, cap: ready.cap, balance: ready.balance });
    if (slot.result === 'cap') throw concurrencyLimit(ready.cap);
    if (slot.result === 'balance') throw creditsHeld();
    return slot;
  }
}

function concurrencyLimit(cap: number | null): AppError {
  return new AppError('CONCURRENCY_LIMIT', `Every line your plan allows (${cap}) is on a call right now. Try again when one finishes.`);
}

function creditsHeld(): AppError {
  return new AppError('NO_CREDITS', 'Your live calls are holding the rest of your credits. Try again when one finishes, or buy a pack.');
}
