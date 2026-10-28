import { Injectable, Logger } from '@nestjs/common';
import { Prisma, withWorkspace } from '@portal/db';
import type { SipVerification, SipVerifyReason, SipVerifyRequest } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { withTimeout } from '../../common/timeout';
import type { WorkspaceContext } from '../auth';
import { SipCredentialsCipher } from '../crypto';
import { RedisCache, redisKeys } from '../redis';
import { RetellGateway, isRetellNotFound } from '../retell';
import { SIP_VERIFY_LEASE_MS } from './number-response';
import { SipProbe, type SipProbeOutcome } from './sip-probe';

/** Checks per workspace per hour. Each one dials a host the customer named, so it is budgeted. */
export const SIP_VERIFY_PER_HOUR = 10;
const WINDOW_S = 3_600;
/** One platform round trip; the whole check stays well inside the lease. */
const PLATFORM_TIMEOUT_MS = 10_000;
const TRUNK_TIMEOUT_MS = 6_000;

/** Trunk answers that mean "this will not work", and the reason each is reported as. */
const TRUNK_FAILURES: ReadonlySet<SipProbeOutcome> = new Set([
  'auth_rejected',
  'auth_required',
  'unreachable',
  'timeout',
  'dns_failed',
  'non_public',
  'port_not_allowed',
  'tls_failed',
  'not_sip',
]);
/** Reachable, but the password is unconfirmed: the trunk answered without asking, or refused us by address. */
const TRUNK_WARNINGS: ReadonlySet<SipProbeOutcome> = new Set(['answered', 'forbidden']);

/**
 * D16 SIP re-verify (`POST /numbers/:id/sip/verify`, owner/admin): checks an imported
 * number's trunk with its stored credentials — or with new ones the customer typed — and
 * re-syncs the voice platform's copy.
 *
 *   1. lease     `phone_numbers.sip_verify_started_at`, claimed by a conditional UPDATE;
 *                a second request while one runs is `409 SIP_VERIFY_IN_PROGRESS`, and the
 *                lease expires on its own after `SIP_VERIFY_LEASE_MS`.
 *   2. trunk     one SIP OPTIONS, digest-answered (`SipProbe`), public addresses only.
 *   3. platform  only when the trunk did not fail: the number must still exist there, and
 *                its termination URI and credentials are written again (`updateSipTrunk`)
 *                — the platform never returns a password, so re-sending ours is the only
 *                way to know it holds the right one.
 *   4. store     the outcome (`sip_verification_json`, no secrets) and, for new credentials
 *                that did not fail, the new envelope — a typo never replaces working ones.
 *
 * Synchronous on purpose: the candidate password lives on this request's stack and is
 * gone with it, instead of waiting in a job payload. No transaction is open across a
 * network call (KMS, the trunk, the platform). The password reaches no log, response,
 * audit row or error message.
 */
@Injectable()
export class SipVerificationService {
  private readonly log = new Logger(SipVerificationService.name);

  constructor(
    private readonly retell: RetellGateway,
    private readonly sip: SipCredentialsCipher,
    private readonly probe: SipProbe,
    private readonly cache: RedisCache,
  ) {}

  async verify(ctx: WorkspaceContext, numberId: string, body: SipVerifyRequest): Promise<SipVerification> {
    const row = await withWorkspace(ctx, (db) =>
      db.phoneNumber.findFirst({
        where: { id: numberId, tenantId: ctx.workspaceId },
        select: { id: true, type: true, e164: true, status: true, plan: { select: { id: true, sipJson: true } } },
      }),
    );
    if (!row) throw AppError.notFound('Phone number');
    if (row.type !== 'custom_sip') throw new AppError('NOT_SIP_NUMBER', 'Only a number imported from your own phone system can be re-verified.');
    if (!row.e164 || (row.status !== 'active' && row.status !== 'paused') || !row.plan?.sipJson) {
      throw new AppError('CONFLICT', 'This number is not connected yet. Try again once it is live.');
    }
    if (!this.sip.configured) throw new AppError('NOT_CONFIGURED', 'Checking a phone system is unavailable right now. We have been notified.');
    const plan = { id: row.plan.id, sipJson: row.plan.sipJson };
    const e164 = row.e164;

    const claimedAt = new Date();
    const claimed = await withWorkspace(ctx, (db) =>
      db.phoneNumber.updateMany({
        where: { id: numberId, tenantId: ctx.workspaceId, OR: [{ sipVerifyStartedAt: null }, { sipVerifyStartedAt: { lt: new Date(claimedAt.getTime() - SIP_VERIFY_LEASE_MS) } }] },
        data: { sipVerifyStartedAt: claimedAt },
      }),
    );
    if (claimed.count === 0) throw new AppError('SIP_VERIFY_IN_PROGRESS', 'This number is already being checked.');

    try {
      // Counted once the lease is ours: a refused duplicate does not spend the budget.
      const used = await this.cache.increment(redisKeys.sipVerifyWindow(ctx.workspaceId), WINDOW_S);
      if (used !== null && used > SIP_VERIFY_PER_HOUR) {
        throw new AppError('RATE_LIMITED', `You can check a phone system ${SIP_VERIFY_PER_HOUR} times an hour. Try again later.`);
      }

      const stored = await this.sip.open(plan.id, plan.sipJson);
      const candidate = {
        host: body.host ?? stored.host,
        username: body.username ?? stored.username,
        password: body.password ?? stored.password,
      };
      if (candidate.password && !candidate.username) {
        throw new AppError('VALIDATION_FAILED', 'A password needs a username.', [{ field: 'username', message: 'Enter the username that goes with this password.' }]);
      }
      const changed = candidate.host !== stored.host || candidate.username !== stored.username || candidate.password !== stored.password;

      const trunk = await this.probe.probe(candidate.host, { username: candidate.username, password: candidate.password }, TRUNK_TIMEOUT_MS);
      let reason: SipVerifyReason | null = TRUNK_FAILURES.has(trunk.outcome) ? (trunk.outcome as SipVerifyReason) : null;
      let platform: NonNullable<SipVerification['checks']>['platform'] = 'skipped';
      if (!reason) {
        try {
          await withTimeout(PLATFORM_TIMEOUT_MS, () => this.retell.getPhoneNumber(e164));
          await withTimeout(PLATFORM_TIMEOUT_MS, () => this.retell.updateSipTrunk(e164, { terminationUri: candidate.host, username: candidate.username, password: candidate.password }));
          platform = 'synced';
        } catch (error) {
          platform = isRetellNotFound(error) ? 'missing' : 'error';
          reason = platform === 'missing' ? 'not_on_platform' : 'provider_error';
          this.log.warn(`sip verify ${numberId}: platform ${platform}: ${error instanceof Error ? error.message : 'error'}`);
        }
      }
      if (!reason && TRUNK_WARNINGS.has(trunk.outcome)) reason = trunk.outcome as SipVerifyReason;
      const status: SipVerification['status'] = reason === null ? 'verified' : TRUNK_WARNINGS.has(reason as SipProbeOutcome) ? 'warning' : 'failed';

      const keep = changed && status !== 'failed';
      // Sealed before the transaction: in staging and prod the data key comes from KMS.
      const sealed = keep ? await this.sip.seal(plan.id, { number: stored.number, ...candidate }) : null;
      const result: SipVerification = {
        status,
        checked_at: new Date().toISOString(),
        reason,
        checks: { trunk: trunk.outcome, platform },
        credentials_updated: keep,
      };
      await withWorkspace(ctx, async (db) => {
        if (sealed) await db.phonePlan.update({ where: { id: plan.id }, data: { sipJson: sealed as unknown as Prisma.InputJsonValue } });
        await db.phoneNumber.update({ where: { id: numberId }, data: { sipVerificationJson: result as unknown as Prisma.InputJsonValue } });
        await db.auditLog.create({
          data: {
            tenantId: ctx.workspaceId,
            actorUserId: ctx.userId,
            action: 'number.sip_verified',
            targetType: 'phone_number',
            targetId: numberId,
            ip: ctx.ip ?? null,
            // Outcome words and which fields changed — never a value of one.
            metaJson: {
              status,
              reason,
              trunk: trunk.outcome,
              platform,
              credentials_updated: keep,
              changed: changed ? { host: candidate.host !== stored.host, username: candidate.username !== stored.username, password: candidate.password !== stored.password } : null,
            },
          },
        });
      });
      this.log.log(`sip verify ${numberId}: ${status}${reason ? ` (${reason})` : ''}, trunk ${trunk.outcome}, platform ${platform}${keep ? ', credentials updated' : ''}`);
      return result;
    } finally {
      // Only our own lease: one that expired and was taken over belongs to the newer check.
      await withWorkspace(ctx, (db) => db.phoneNumber.updateMany({ where: { id: numberId, sipVerifyStartedAt: claimedAt }, data: { sipVerifyStartedAt: null } })).catch(() => null);
    }
  }
}
