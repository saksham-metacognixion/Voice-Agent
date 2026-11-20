import { Injectable, Logger } from '@nestjs/common';
import { adminDb } from '@portal/db';
import { type AuthLogEntry, type AuthWebhookEvent, authLogEntry } from '@portal/schemas';
import { recordAccountEvent } from './account-audit';
import { auditActionForLog } from './auth-log-events';
import { Auth0ManagementService } from './auth0-management.service';

/** Log types that change whether a second factor is enrolled. */
const MFA_ENROLMENT_LOGS: Readonly<Record<string, boolean>> = { gd_enrollment_complete: true, gd_unenroll: false };

/**
 * The worker side of the identity provider's account events (ADR 0036 §5, §9): what a
 * sign-in, a failed one, a second factor or a password change does to our records. Runs
 * from the `webhooks` queue, so every event is stored once in `webhook_events` (deduped
 * on the provider's id) before it gets here, and a redelivery is a 204 at the door.
 */
@Injectable()
export class AccountEventsService {
  private readonly log = new Logger(AccountEventsService.name);

  constructor(private readonly auth0: Auth0ManagementService) {}

  /**
   * One tenant-log entry → one audit row in each of the person's workspaces. An entry with
   * no `user_id`, or one for a `sub` we have no row for (a mistyped address, a sign-up that
   * was refused), records nothing: that is how a failed sign-in for an address nobody owns
   * stays invisible to every customer.
   */
  async handleLog(payload: unknown): Promise<{ outcome: string; reason?: string }> {
    const parsed = authLogEntry.safeParse(payload);
    if (!parsed.success) return { outcome: 'ignored', reason: 'not a log entry' };
    const entry: AuthLogEntry = parsed.data;
    const action = auditActionForLog(entry.data.type);
    if (!action) return { outcome: 'ignored', reason: `log type ${entry.data.type} is not audited` };
    const sub = entry.data.user_id;
    if (!sub) return { outcome: 'ignored', reason: 'no user' };
    const user = await adminDb.user.findUnique({ where: { authProviderId: sub }, select: { id: true } });
    if (!user) return { outcome: 'ignored', reason: 'unknown user' };
    // D6 Team "MFA ✓": an enrolment or a removal is known here before the person's next
    // request carries the claim AuthGuard reads.
    const enrolled = MFA_ENROLMENT_LOGS[entry.data.type];
    if (enrolled !== undefined) await adminDb.user.update({ where: { id: user.id }, data: { mfaEnabled: enrolled } });
    const rows = await recordAccountEvent({
      userId: user.id,
      action,
      ip: entry.data.ip ?? null,
      dedupeKey: entry.log_id,
      meta: {
        log_type: entry.data.type,
        at: entry.data.date ?? null,
        connection: entry.data.connection ?? null,
        strategy: entry.data.strategy ?? null,
        user_agent: entry.data.user_agent?.slice(0, 200) ?? null,
      },
    });
    return { outcome: 'audited', reason: `${action} in ${rows} workspace(s)` };
  }

  /**
   * §6.2 "login 5 failures / 15 min" (ADR 0036 §8): the delayed half of a `limit_wc`
   * entry. Lifts the block at the provider, then audits `auth.sign_in_unblocked` in the
   * person's workspaces. A provider failure throws and BullMQ retries; the block meanwhile
   * stays, which errs on the locked side. The person can still use the unblock link Auth0
   * mailed them.
   */
  async liftSignInBlock(job: { logId: string; sub: string | null; identifier: string | null }): Promise<{ outcome: string; reason?: string }> {
    const provider = await this.auth0.liftBruteForceBlocks(job);
    const user = job.sub
      ? await adminDb.user.findUnique({ where: { authProviderId: job.sub }, select: { id: true } })
      : job.identifier
        ? await adminDb.user.findUnique({ where: { email: job.identifier }, select: { id: true } })
        : null;
    if (user && provider === 'applied') {
      await recordAccountEvent({ userId: user.id, action: 'auth.sign_in_unblocked', dedupeKey: `unblock:${job.logId}`, meta: { cause: 'block_expired' } });
    }
    return { outcome: provider === 'applied' ? 'unblocked' : 'ignored', reason: `provider ${provider}` };
  }

  /**
   * §6.3 A6 "→ all other sessions revoked" (ADR 0036 §5). Three things end: every access
   * token issued before the change (`users.sessions_revoked_at`, which `AuthGuard` checks
   * on every request), every provider session and refresh token, and every "remember this
   * device". `sessions_revoked_at` is the change's own time and only ever moves forward,
   * so a retried job never ends a session the person opened after it.
   */
  async passwordChanged(event: AuthWebhookEvent): Promise<{ outcome: string; reason?: string }> {
    const user = await adminDb.user.findUnique({ where: { authProviderId: event.external_id }, select: { id: true, sessionsRevokedAt: true } });
    if (!user) return { outcome: 'ignored', reason: 'unknown user' };
    const at = event.occurred_at && !Number.isNaN(Date.parse(event.occurred_at)) ? new Date(event.occurred_at) : new Date();
    if (!user.sessionsRevokedAt || user.sessionsRevokedAt < at) {
      await adminDb.user.updateMany({ where: { id: user.id, OR: [{ sessionsRevokedAt: null }, { sessionsRevokedAt: { lt: at } }] }, data: { sessionsRevokedAt: at } });
    }
    // Provider calls after the row: a failure here throws, BullMQ retries, and the row
    // above has already refused every older token in the meantime.
    const sessions = await this.auth0.revokeSessions(event.external_id);
    const devices = await this.auth0.forgetRememberedDevices(event.external_id);
    await recordAccountEvent({
      userId: user.id,
      action: 'auth.sessions_revoked',
      dedupeKey: event.event_id ?? `password:${event.external_id}:${at.toISOString()}`,
      meta: { cause: 'password_changed', provider: sessions, remembered_devices: devices },
    });
    this.log.log(`user ${user.id}: password changed — sessions before ${at.toISOString()} revoked (provider ${sessions}, devices ${devices})`);
    return { outcome: 'revoked' };
  }
}
