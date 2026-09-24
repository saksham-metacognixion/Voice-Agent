import { Inject, Injectable, Logger } from '@nestjs/common';
import { withWorkspace } from '@portal/db';
import type { TestWebCallResponse } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { AgentDraftSyncService, settingsOf } from '../agents';
import type { WorkspaceContext } from '../auth';
import { PlatformConfigService } from '../config';
import { REDIS, RedisCache, type RedisLike, redisKeys } from '../redis';
import { RetellGateway, clampDuration } from '../retell';
import { WalletService } from '../wallet';
import { roundCredits } from '../wallet/fifo';
import { parseActiveHash } from './inbound.decide';
import { RecordingSigner } from './recording';

/** §13.4: ten browser test calls per workspace per hour. */
export const TEST_CALLS_PER_HOUR = 10;
const WINDOW_S = 3_600;
/** How long a live-transcript token outlives the call's ceiling (ADR 0011's reservation slack). */
const LIVE_TOKEN_SLACK_S = 300;

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
 * run the whole balance and together overdraw it past the grace.
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
    if (await this.config.killSwitch('pause_web_tests')) {
      throw new AppError('TESTS_PAUSED', 'Test calls are paused for a few minutes. Please try again shortly.');
    }

    const target = await withWorkspace(ctx, async (db) => {
      const tenant = await db.tenant.findUniqueOrThrow({ where: { id: ctx.workspaceId }, select: { pausedAt: true } });
      if (tenant.pausedAt) throw new AppError('WORKSPACE_PAUSED', 'This workspace is paused. Contact support to resume it.');
      const agent = await db.agent.findFirst({ where: { id: agentId, tenantId: ctx.workspaceId, deletedAt: null } });
      if (!agent) throw AppError.notFound('Agent');
      const no = versionNo ?? agent.draftVersion ?? agent.publishedVersion;
      if (!no) throw new AppError('BRIEF_INCOMPLETE', 'Generate the agent before testing it.');
      const version = await db.agentVersion.findUnique({ where: { agentId_versionNo: { agentId, versionNo: no } } });
      if (!version) throw AppError.notFound('Version');
      return { agent, version };
    });

    const { agent, version } = target;
    const settings = settingsOf(version, agent);
    const { rate } = await this.config.rateFor(settings.tier);
    const balance = await this.wallet.balance(ctx.workspaceId);
    if (!(balance > 0)) throw new AppError('NO_CREDITS', 'You are out of credits. Buy a pack to keep testing.');

    // The other live calls: their count is the concurrency check, their reservations are
    // what this call must leave alone. Redis unreachable reads as "none" — the inbound
    // path fails open on the same policy (ADR 0003 §12), and call_started reserves anyway.
    const others = await this.liveCalls(ctx.workspaceId);
    const caps = await this.config.capsFor(ctx.workspaceId).catch(() => null);
    if (caps && caps.concurrency_cap > 0 && others.count >= caps.concurrency_cap) {
      throw new AppError('CONCURRENCY_LIMIT', `Every line your plan allows (${caps.concurrency_cap}) is on a call right now. Try again when one finishes.`);
    }
    const remaining = roundCredits(balance - others.credits);
    if (!(remaining > 0)) {
      throw new AppError('NO_CREDITS', 'Your live calls are holding the rest of your credits. Try again when one finishes, or buy a pack.');
    }

    await this.assertUnderRateLimit(ctx.workspaceId);

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
      throw new AppError('BRIEF_INCOMPLETE', 'This version is still being prepared. Try again in a few seconds.');
    }

    // min(the version's ceiling, what the wallet covers after the other live calls),
    // inside the platform's [60 s, 2 h] — the inbound path's formula (ADR 0011 §1).
    const coveredMs = rate > 0 ? (remaining / rate) * 60_000 : Number.POSITIVE_INFINITY;
    const maxMs = clampDuration(Math.min(settings.max_call_duration_s * 1_000, coveredMs));

    const call = await this.retell
      .createWebCall({
        agentId: retellAgentId,
        agentVersion: retellAgentVersion,
        metadata: { tenant_id: ctx.workspaceId, agent_id: agent.id, version_no: version.versionNo, tier: settings.tier, test: true },
        maxCallDurationMs: maxMs,
      })
      .catch((error: unknown) => {
        this.log.warn(`agent ${agent.id} v${version.versionNo}: test call refused upstream: ${String(error)}`);
        throw new AppError('UPSTREAM_UNAVAILABLE', 'We could not start the test call just now. Try again in a moment.');
      });

    // Counted once the platform has minted: a refusal upstream is not one of the ten.
    await this.cache.increment(redisKeys.testCallWindow(ctx.workspaceId), WINDOW_S);

    // The live transcript's credential (LiveTranscriptRelay): this call, this workspace,
    // valid for as long as the call may run plus the slack a reservation gets.
    const live = this.signer.sign({ callId: call.call_id, workspaceId: ctx.workspaceId }, new Date(), Math.ceil(maxMs / 1_000) + LIVE_TOKEN_SLACK_S, 'live');

    const extra = call as unknown as { url?: string; transport?: string; ice_servers?: Record<string, unknown>[]; expires_at?: number };
    return {
      call_id: call.call_id,
      access_token: call.access_token,
      rate,
      balance: Math.round(balance * 100) / 100,
      version_no: version.versionNo,
      max_call_duration_s: Math.floor(maxMs / 1_000),
      live_token: live.token,
      ...(extra.transport ? { transport: extra.transport } : {}),
      ...(extra.url ? { url: extra.url } : {}),
      ...(extra.ice_servers ? { ice_servers: extra.ice_servers } : {}),
      ...(typeof extra.expires_at === 'number' ? { expires_at: extra.expires_at } : {}),
    };
  }

  /** The live entries of `active:{ws}` — how many, and the credits they hold between them. */
  private async liveCalls(workspaceId: string): Promise<{ count: number; credits: number }> {
    try {
      const { live } = parseActiveHash(await this.redis.hgetall(redisKeys.activeCalls(workspaceId)), Date.now());
      return { count: live.length, credits: live.reduce((sum, a) => sum + a.credits, 0) };
    } catch (error) {
      this.log.warn(`active:{${workspaceId}}: could not read the live calls before a test call: ${String(error)}`);
      return { count: 0, credits: 0 };
    }
  }

  /**
   * §13.4's fixed hourly window: the counter starts with the first call of the hour and
   * expires an hour later whatever comes after it (`RedisCache.increment`, `SET NX` + `INCR`
   * — a `SET … EX` on every call would push the window out for as long as the calls keep
   * coming). It is read here and bumped after the platform has answered, so a burst can
   * slip one over and a refused mint costs nothing; Redis down means allow. A test call
   * spends real minutes — but the customer's own, which the balance check gates, so the
   * limit is abuse control and not the wallet.
   */
  private async assertUnderRateLimit(workspaceId: string): Promise<void> {
    const used = Number(await this.cache.get(redisKeys.testCallWindow(workspaceId)));
    if (Number.isFinite(used) && used >= TEST_CALLS_PER_HOUR) {
      throw new AppError('TEST_RATE_LIMIT', `That is ${TEST_CALLS_PER_HOUR} test calls this hour. Try again a little later.`);
    }
  }
}
