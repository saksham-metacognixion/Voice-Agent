import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, withWorkspace } from '@portal/db';
import type { ForwardingTest } from '@portal/schemas';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../common/errors/app-error';
import type { WorkspaceContext } from '../auth';
import { MintSlot, assertUnderTestWindow, countTestCall, headroom, liveCalls } from '../calls/call-headroom';
import { FORWARDING_TEST_MARKER_TTL_S, FORWARDING_TEST_RING_MS, type ForwardingTestMarker } from '../calls/forwarding-test';
import { PlatformConfigService } from '../config';
import { type ForwardingTestJob, JobQueues } from '../jobs';
import { REDIS, RedisCache, type RedisLike, redisKeys } from '../redis';
import { RetellGateway } from '../retell';
import { WalletService } from '../wallet';
import { forwardingTestOf } from './number-response';

/** Tests per number per hour. Each one rings the customer's own phone line. */
export const FORWARDING_TESTS_PER_HOUR = 5;
const WINDOW_S = 3_600;
/** The platform's floor. The outbound leg only rings: forwarded, it is turned away at once. */
const TEST_LEG_MAX_MS = 60_000;

/** What the row keeps: the wire shape plus the test it belongs to, so a stale job cannot settle a newer test. */
type StoredTest = ForwardingTest & { test_id: string };

/**
 * D17 "Test forwarding" (D4 Forwarding tab, spec p. 37: "we call their original number
 * and verify it lands"), for an Option B number — a number of ours with the customer's
 * existing line forwarded to it (§11.2).
 *
 *   1. marker   `fwdtest:{e164}` with `SET NX` — the lease (one test per number at a
 *               time) and what the §13.9 path recognises the forwarded call by.
 *   2. ring     an outbound call *from* the number *to* the customer's line, on the
 *               number's live agent, with a 60 s ceiling.
 *   3. landed   the carrier forwards it back; the inbound path matches the marker,
 *               answers with a busy tone (no call object, nothing billed) and queues
 *               `forwarding-test-landed`. The outbound leg ends `dial_busy`, billed zero.
 *               The number's `forwarding_status` becomes `ready`.
 *   4. expire   `forwarding-test-expire`, delayed by the ring window: still `calling` →
 *               `not_landed`. If someone picks up the customer's phone instead (no
 *               forwarding, or "when I don't answer" and they answered) — or the line's
 *               voicemail does — they hear the agent for up to a minute: the one way this
 *               test costs credits.
 *
 * The outbound leg is a test call (`metadata.test`), billed by `call_ended` like any call,
 * so it passes what every test call passes (call-headroom.ts): the SA12 `pause_web_tests`
 * switch, the workspace's ten-an-hour test window (shared with the browser test and "Call
 * my phone"), a free line of the plan and credits left after the other live calls — and
 * it takes its line in `active:{ws}` before it dials.
 *
 * Synchronous up to the ring, like the D16 SIP re-verify; the outcome arrives on the row,
 * which the portal polls while the test reads `calling`.
 */
@Injectable()
export class ForwardingTestService {
  private readonly log = new Logger(ForwardingTestService.name);

  constructor(
    private readonly retell: RetellGateway,
    private readonly cache: RedisCache,
    @Inject(REDIS) private readonly redis: RedisLike,
    private readonly wallet: WalletService,
    private readonly config: PlatformConfigService,
    private readonly queues: JobQueues,
  ) {}

  async start(ctx: WorkspaceContext, numberId: string): Promise<void> {
    const row = await withWorkspace(ctx, async (db) => {
      const tenant = await db.tenant.findUniqueOrThrow({ where: { id: ctx.workspaceId }, select: { pausedAt: true } });
      const number = await db.phoneNumber.findFirst({
        where: { id: numberId, tenantId: ctx.workspaceId },
        select: {
          id: true,
          e164: true,
          status: true,
          pausedAt: true,
          forwardingFrom: true,
          forwardingTestJson: true,
          agent: { select: { id: true, tier: true, retellAgentId: true, publishedVersion: true, deletedAt: true } },
        },
      });
      const published =
        number?.agent?.publishedVersion != null
          ? await db.agentVersion.findUnique({
              where: { agentId_versionNo: { agentId: number.agent.id, versionNo: number.agent.publishedVersion } },
              select: { retellAgentVersion: true },
            })
          : null;
      return number ? { ...number, tenantPaused: tenant.pausedAt !== null, published } : null;
    });
    if (!row) throw AppError.notFound('Phone number');
    if (!row.forwardingFrom) throw new AppError('NOT_FORWARDING_NUMBER', 'Only a number your existing line forwards to can be tested this way.');
    if (row.tenantPaused) throw new AppError('WORKSPACE_PAUSED', 'This workspace is paused. Contact support to resume it.');
    if (!row.e164 || row.status !== 'active') throw new AppError('CONFLICT', 'This number is not connected yet. Try again once it is live.');
    if (row.pausedAt) throw new AppError('CONFLICT', 'This number is paused. Resume it to test the forwarding.');
    const agent = row.agent && !row.agent.deletedAt ? row.agent : null;
    if (!agent?.retellAgentId || row.published?.retellAgentVersion == null) {
      throw new AppError('AGENT_NOT_PUBLISHED', 'Point this number at a live agent before testing the forwarding.');
    }
    if (forwardingTestOf(row)?.status === 'calling') throw new AppError('FORWARDING_TEST_IN_PROGRESS', 'A forwarding test is already ringing for this number.');
    if (await this.config.killSwitch('pause_web_tests')) throw new AppError('TESTS_PAUSED', 'Test calls are paused for a few minutes. Please try again shortly.');
    await assertUnderTestWindow(this.cache, ctx.workspaceId);

    // The live tier's rate (the leg runs the number's published agent), and the line it
    // takes beside the other live calls — sized for the leg's 60 s ceiling.
    const [{ rate }, balance, live, caps] = await Promise.all([
      this.config.rateFor(agent.tier),
      this.wallet.balance(ctx.workspaceId),
      liveCalls(this.redis, ctx.workspaceId, this.log),
      this.config.capsFor(ctx.workspaceId).catch(() => null),
    ]);
    if (!(balance > 0)) throw new AppError('NO_CREDITS', 'You are out of credits. Buy a pack to test the forwarding.');
    const room = headroom({ balance, live, cap: caps?.concurrency_cap, rate, maxDurationS: TEST_LEG_MAX_MS / 1_000 });
    if (!room.ok && room.reason === 'cap') throw concurrencyLimit(room.cap);
    if (!room.ok) throw creditsHeld();

    const e164 = row.e164;
    const testId = randomUUID();
    const marker: ForwardingTestMarker = { test_id: testId, number_id: row.id, workspace_id: ctx.workspaceId, original: row.forwardingFrom };
    const markerValue = JSON.stringify(marker);
    // The lease and the hot path's cue in one write. Redis down means the inbound path
    // could not see the marker either, so there is no test worth ringing a phone for.
    let claimed: 'OK' | null;
    try {
      claimed = await this.redis.set(redisKeys.forwardingTest(e164), markerValue, 'EX', FORWARDING_TEST_MARKER_TTL_S, 'NX');
    } catch (error) {
      this.log.warn(`forwarding test ${numberId}: marker not written: ${error instanceof Error ? error.message : String(error)}`);
      throw new AppError('UPSTREAM_UNAVAILABLE', 'We could not start the test just now. Try again in a moment.');
    }
    if (claimed !== 'OK') throw new AppError('FORWARDING_TEST_IN_PROGRESS', 'A forwarding test is already ringing for this number.');

    let slot: MintSlot | null = null;
    try {
      // Counted once the lease is ours: a refused duplicate does not spend the budget.
      const used = await this.cache.increment(redisKeys.forwardingTestWindow(row.id), WINDOW_S);
      if (used !== null && used > FORWARDING_TESTS_PER_HOUR) {
        throw new AppError('RATE_LIMITED', `You can test the forwarding ${FORWARDING_TESTS_PER_HOUR} times an hour. Try again later.`);
      }

      slot = await MintSlot.take(this.redis, this.log, { workspaceId: ctx.workspaceId, maxMs: room.maxMs, rate, cap: room.cap, balance });
      if (slot.result === 'cap') throw concurrencyLimit(room.cap);
      if (slot.result === 'balance') throw creditsHeld();

      const startedAt = new Date();
      await this.store(ctx.workspaceId, row.id, { test_id: testId, status: 'calling', started_at: startedAt.toISOString(), finished_at: null, caller_id: null });
      try {
        const placed = await this.retell.createPhoneCall({
          fromNumber: e164,
          toNumber: row.forwardingFrom,
          agentId: agent.retellAgentId,
          agentVersion: row.published.retellAgentVersion,
          metadata: { tenant_id: ctx.workspaceId, agent_id: agent.id, number_id: row.id, test: true, forwarding_test: testId },
          maxCallDurationMs: room.maxMs,
        });
        await slot.bind(placed.call_id);
      } catch (error) {
        this.log.warn(`forwarding test ${numberId}: call refused upstream: ${error instanceof Error ? error.message : String(error)}`);
        await this.store(ctx.workspaceId, row.id, { test_id: testId, status: 'failed', started_at: startedAt.toISOString(), finished_at: new Date().toISOString(), caller_id: null });
        throw new AppError('UPSTREAM_UNAVAILABLE', 'We could not place the test call just now. Try again in a moment.');
      }

      await countTestCall(this.cache, ctx.workspaceId);
      await this.queues.enqueueForwardingTestExpire({ testId, numberId: row.id, workspaceId: ctx.workspaceId }, FORWARDING_TEST_RING_MS);
      await withWorkspace(ctx, (db) =>
        db.auditLog.create({
          data: { tenantId: ctx.workspaceId, actorUserId: ctx.userId, action: 'number.forwarding_test_started', targetType: 'phone_number', targetId: row.id, metaJson: { test_id: testId } },
        }),
      ).catch((error: unknown) => this.log.warn(`forwarding test ${numberId}: audit row not written: ${String(error)}`));
    } catch (error) {
      await this.cache.releaseLock(redisKeys.forwardingTest(e164), markerValue);
      await slot?.release();
      throw error;
    }
  }

  /** `forwarding-test-landed`: the inbound path turned the forwarded call away. The forwarding works. */
  async landed(job: ForwardingTestJob): Promise<void> {
    const settled = await this.settle(job, 'landed');
    if (!settled) return;
    // The inbound path consumed the marker when it turned the call away; this is for a
    // landing settled any other way. This test's marker only, never a newer one.
    if (settled.e164 && settled.original) {
      const marker: ForwardingTestMarker = { test_id: job.testId, number_id: job.numberId, workspace_id: job.workspaceId, original: settled.original };
      await this.cache.releaseLock(redisKeys.forwardingTest(settled.e164), JSON.stringify(marker));
    }
    this.log.log(`forwarding test ${job.numberId}: landed (${job.callerId ?? 'ours'})`);
  }

  /** `forwarding-test-expire`: the ring window closed with nothing back. A landed test is left as it is. */
  async expire(job: ForwardingTestJob): Promise<void> {
    const settled = await this.settle(job, 'not_landed');
    if (settled) this.log.log(`forwarding test ${job.numberId}: not landed`);
  }

  /**
   * Moves this test (and only this test) to its outcome, while it is still `calling` — or,
   * for `landed`, after it was called `not_landed`. The marker outlives the ring window
   * (`FORWARDING_TEST_MARKER_TTL_S`), so a forward the carrier sends late is still turned
   * away by the inbound path; that is proof the forwarding works, and an expiry that
   * happened to run first must not have the last word.
   */
  private async settle(job: ForwardingTestJob, status: 'landed' | 'not_landed'): Promise<{ e164: string | null; original: string | null } | null> {
    return withWorkspace(job.workspaceId, async (db) => {
      const row = await db.phoneNumber.findFirst({
        where: { id: job.numberId, tenantId: job.workspaceId },
        select: { e164: true, forwardingFrom: true, forwardingTestJson: true },
      });
      const stored = row?.forwardingTestJson as Partial<StoredTest> | null | undefined;
      const open = stored?.status === 'calling' || (status === 'landed' && stored?.status === 'not_landed');
      if (!row || stored?.test_id !== job.testId || !open) return null;
      const next: StoredTest = {
        test_id: job.testId,
        status,
        started_at: stored.started_at ?? new Date().toISOString(),
        finished_at: new Date().toISOString(),
        caller_id: status === 'landed' ? (job.callerId ?? 'ours') : null,
      };
      await db.phoneNumber.update({
        where: { id: job.numberId },
        data: {
          forwardingTestJson: next as unknown as Prisma.InputJsonValue,
          // Proven, not just confirmed: the same state the customer's "it's on" sets.
          ...(status === 'landed' ? { forwardingStatus: 'ready' } : {}),
        },
      });
      await db.auditLog.create({
        data: {
          tenantId: job.workspaceId,
          actorUserId: null,
          action: status === 'landed' ? 'number.forwarding_verified' : 'number.forwarding_not_verified',
          targetType: 'phone_number',
          targetId: job.numberId,
          metaJson: { test_id: job.testId, caller_id: next.caller_id },
        },
      });
      return { e164: row.e164, original: row.forwardingFrom };
    });
  }

  private store(workspaceId: string, numberId: string, test: StoredTest): Promise<unknown> {
    return withWorkspace(workspaceId, (db) => db.phoneNumber.update({ where: { id: numberId }, data: { forwardingTestJson: test as unknown as Prisma.InputJsonValue } }));
  }
}

function concurrencyLimit(cap: number | null): AppError {
  return new AppError('CONCURRENCY_LIMIT', `Every line your plan allows (${cap}) is on a call right now. Try again when one finishes.`);
}

function creditsHeld(): AppError {
  return new AppError('NO_CREDITS', 'Your live calls are holding the rest of your credits. Try again when one finishes, or buy a pack.');
}
