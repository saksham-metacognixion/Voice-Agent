import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, adminDb, isUniqueViolation } from '@portal/db';
import type { NewMessageMode } from '@portal/schemas';
import { EMAIL_SENDER } from './notifications.tokens';
import { type EmailSender, type OutboundEmail, maskEmail } from './email.sender';

/** A member who may receive an email, with their effective §15 preferences. */
export interface Recipient {
  userId: string;
  email: string;
  name: string | null;
  role: 'owner' | 'admin' | 'editor' | 'viewer';
  settings: EffectiveSettings;
}

export interface EffectiveSettings {
  new_message: NewMessageMode;
  low_balance_email: boolean;
  low_balance_sms: boolean;
  weekly_summary: boolean;
}

/** The §15 defaults, applied when a workspace has no default row either. */
export const DEFAULT_SETTINGS: EffectiveSettings = { new_message: 'instant', low_balance_email: true, low_balance_sms: false, weekly_summary: true };

export interface DeliverInput {
  workspaceId: string;
  userId: string | null;
  kind: 'low_balance' | 'rental_overdue' | 'number_released' | 'daily_digest' | 'auto_topup_failed' | 'invite';
  /** Exactly-once key. Same key → the second call is a `duplicate` and sends nothing. */
  dedupeKey: string;
  email: OutboundEmail;
  /** Customer-safe facts about the message, for support. The body itself is stored beside them by `deliver()`. */
  payload?: Record<string, unknown>;
  /**
   * Values filled into `{name}` placeholders of the subject and body at send time only —
   * an invite link, whose token exists nowhere but in the invitee's inbox (A8 stores its
   * hash). The row keeps the placeholder, so nothing secret is ever stored; the price is
   * that `retryFailed()` cannot rebuild such an email, and writes a failed one off instead
   * (the sender resends from the Team page, which mints a new link).
   */
  secrets?: Record<string, string>;
}

export type DeliverOutcome =
  | { outcome: 'sent'; notificationId: string }
  | { outcome: 'duplicate'; notificationId: string | null }
  | { outcome: 'failed'; notificationId: string; error: string };

/** After this many failed sends a row is left alone for a human. */
export const MAX_SEND_ATTEMPTS = 5;

/**
 * §13.1 `notifications` (D7): the outbox that makes every customer message exactly-once.
 *
 *     decide to notify ──▶ INSERT notifications (dedupe_key UNIQUE, ON CONFLICT DO NOTHING)
 *                            │ 0 rows: someone else already did — stop
 *                            ▼ 1 row: this process owns the send
 *                          sender.send() ──▶ status sent | failed (retried by retryFailed)
 *
 * The row is the claim. Two workers evaluating the same low-balance crossing, or the
 * hourly digest sweep running twice for one workspace-day, race on the INSERT and exactly
 * one wins; the other sees a duplicate and does nothing. A crash between the INSERT and
 * the send leaves a `pending` row that `retryFailed()` picks up — so the failure mode of
 * a dying worker is a late email, never two. That only holds because the row carries the
 * body from the INSERT: a `pending` row written before the send, without the text, would
 * be one `retryFailed()` can only write off.
 *
 * Everything runs on `adminDb`: notifications are produced by schedules and listeners,
 * which have no request context (ADR 0006).
 */
@Injectable()
export class NotificationsService {
  private readonly log = new Logger(NotificationsService.name);

  constructor(@Inject(EMAIL_SENDER) readonly sender: EmailSender) {}

  /** Members of the workspace with their effective notification settings. Owners and admins first. */
  async recipients(workspaceId: string, roles: Array<Recipient['role']> = ['owner', 'admin']): Promise<Recipient[]> {
    const [members, settings] = await Promise.all([
      adminDb.membership.findMany({
        where: { tenantId: workspaceId, role: { in: roles } },
        include: { user: { select: { id: true, email: true, name: true } } },
        orderBy: { role: 'asc' },
      }),
      adminDb.notificationSetting.findMany({ where: { tenantId: workspaceId } }),
    ]);
    const workspaceDefault = settings.find((s) => s.userId === null);
    return members.map((m) => {
      const own = settings.find((s) => s.userId === m.userId);
      const row = own ?? workspaceDefault;
      return {
        userId: m.userId,
        email: m.user.email,
        name: m.user.name,
        role: m.role,
        settings: row ? effective(row) : DEFAULT_SETTINGS,
      };
    });
  }

  /** Claims the dedupe key and sends. See the class comment for why the INSERT comes first: one round trip, and the unique index is the referee. */
  async deliver(input: DeliverInput): Promise<DeliverOutcome> {
    let row: { id: string };
    try {
      row = await adminDb.notification.create({
        data: {
          tenantId: input.workspaceId,
          userId: input.userId,
          kind: input.kind,
          dedupeKey: input.dedupeKey,
          channel: 'email',
          recipient: input.email.to,
          subject: input.email.subject,
          // The body is ours (no secrets) and the recipient is a member's own address, so
          // both live on the row from the start — what a retry after a crash re-sends from.
          payloadJson: storedPayload(withSecretFlag(input), input.email) as Prisma.InputJsonValue,
          status: 'pending',
        },
        select: { id: true },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await adminDb.notification.findUnique({ where: { dedupeKey: input.dedupeKey }, select: { id: true } });
      return { outcome: 'duplicate', notificationId: existing?.id ?? null };
    }
    return this.send(row.id, input.email, withSecretFlag(input), input.secrets);
  }

  /** Records that nothing will be sent for this key, so the decision is not re-made every run. */
  async skip(input: Omit<DeliverInput, 'email' | 'userId'> & { reason: string }): Promise<{ outcome: 'skipped' | 'duplicate' }> {
    const { count } = await adminDb.notification.createMany({
      data: [
        {
          tenantId: input.workspaceId,
          kind: input.kind,
          dedupeKey: input.dedupeKey,
          channel: 'none',
          status: 'skipped',
          error: input.reason.slice(0, 200),
          payloadJson: (input.payload ?? {}) as Prisma.InputJsonValue,
        },
      ],
      skipDuplicates: true,
    });
    return { outcome: count === 1 ? 'skipped' : 'duplicate' };
  }

  /**
   * Re-sends rows a crash or a provider outage left `pending`/`failed`, oldest first.
   * The email is rebuilt from the row (`subject` + `payload_json.text`), so the retry
   * needs nothing that was only in memory.
   */
  async retryFailed(now = new Date(), limit = 50): Promise<{ retried: number; sent: number }> {
    const rows = await adminDb.notification.findMany({
      where: {
        channel: 'email',
        status: { in: ['pending', 'failed'] },
        attempts: { lt: MAX_SEND_ATTEMPTS },
        updatedAt: { lt: new Date(now.getTime() - 5 * 60_000) },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true, recipient: true, subject: true, payloadJson: true },
    });
    let sent = 0;
    for (const row of rows) {
      const payload = (row.payloadJson ?? {}) as Record<string, unknown> & { text?: string; html?: string };
      if (payload.one_time_secret) {
        // Its link was only ever in memory (`DeliverInput.secrets`); re-sending the
        // placeholder would mail a broken link. A resend mints a new one.
        await adminDb.notification.update({ where: { id: row.id }, data: { status: 'failed', attempts: MAX_SEND_ATTEMPTS, error: 'one-time link not stored; resend from the Team page' } });
        continue;
      }
      if (!row.recipient || !row.subject || !payload.text) {
        await adminDb.notification.update({ where: { id: row.id }, data: { status: 'failed', attempts: MAX_SEND_ATTEMPTS, error: 'row carries no re-sendable body' } });
        continue;
      }
      const result = await this.send(row.id, { to: row.recipient, subject: row.subject, text: payload.text, html: payload.html }, payload);
      if (result.outcome === 'sent') sent += 1;
    }
    if (rows.length) this.log.log(`notifications: retried ${rows.length} unsent, ${sent} delivered`);
    return { retried: rows.length, sent };
  }

  /** `payload` is kept alongside the body: the facts a support agent reads, plus what a retry needs to rebuild the email. */
  private async send(id: string, email: OutboundEmail, payload: Record<string, unknown>, secrets?: Record<string, string>): Promise<DeliverOutcome> {
    // The body is ours (no secrets) and `recipient` is a member's own address, so both may
    // live on the row; that is what lets `retryFailed()` re-send from the database alone.
    // A one-time secret is filled into the outgoing copy only, never into `stored`.
    const stored = storedPayload(payload, email);
    try {
      const { id: providerId } = await this.sender.send(secrets ? fillSecrets(email, secrets) : email);
      await adminDb.notification.update({
        where: { id },
        data: {
          status: 'sent',
          sentAt: new Date(),
          attempts: { increment: 1 },
          error: null,
          payloadJson: { ...stored, provider_id: providerId, sender: this.sender.name } as Prisma.InputJsonValue,
        },
      });
      this.log.log(`notification ${id}: sent to ${maskEmail(email.to)} via ${this.sender.name}`);
      return { outcome: 'sent', notificationId: id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await adminDb.notification
        .update({
          where: { id },
          data: { status: 'failed', attempts: { increment: 1 }, error: message.slice(0, 500), payloadJson: stored as Prisma.InputJsonValue },
        })
        .catch(() => undefined);
      this.log.error(`notification ${id}: send to ${maskEmail(email.to)} failed: ${message}`);
      return { outcome: 'failed', notificationId: id, error: message };
    }
  }
}

function withSecretFlag(input: Pick<DeliverInput, 'payload' | 'secrets'>): Record<string, unknown> {
  return input.secrets ? { ...(input.payload ?? {}), one_time_secret: true } : (input.payload ?? {});
}

/** The email as sent: each `{name}` placeholder replaced by its secret. */
export function fillSecrets(email: OutboundEmail, secrets: Record<string, string>): OutboundEmail {
  const fill = (text: string) => text.replace(/\{([a-z_]+)\}/g, (match, name: string) => secrets[name] ?? match);
  return { ...email, subject: fill(email.subject), text: fill(email.text), ...(email.html ? { html: fill(email.html) } : {}) };
}

/** `payload_json`: the support-facing facts plus the re-sendable body. */
function storedPayload(payload: Record<string, unknown> | undefined, email: OutboundEmail): Record<string, unknown> {
  return { ...(payload ?? {}), text: email.text, ...(email.html ? { html: email.html } : {}) };
}

function effective(row: { newMessage: string; lowBalanceEmail: boolean; lowBalanceSms: boolean; weeklySummary: boolean }): EffectiveSettings {
  const mode = row.newMessage === 'daily' || row.newMessage === 'off' ? row.newMessage : 'instant';
  return { new_message: mode, low_balance_email: row.lowBalanceEmail, low_balance_sms: row.lowBalanceSms, weekly_summary: row.weeklySummary };
}
