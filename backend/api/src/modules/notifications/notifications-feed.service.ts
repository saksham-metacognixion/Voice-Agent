import { Injectable, Logger } from '@nestjs/common';
import { Prisma, adminDb, withWorkspace } from '@portal/db';
import type { NotificationKind, NotificationsResponse, NotificationsSeenResponse } from '@portal/schemas';
import type { WorkspaceContext } from '../auth';
import { EventsService } from '../events';
import { FEED_CHANNELS, FEED_KINDS, feedMeta, isFeedKind, isUnread } from './notifications-feed.rules';

/** The bell's SSE topic (§7.2, ADR 0041): one `new` frame per row written, carrying the kind only. */
export const NotificationEvents = { topic: 'notifications', new: 'new' } as const;

/** How many rows the bell lists. Older news is on the pages the rows link to. */
export const FEED_LIMIT = 20;

export interface RecordInput {
  workspaceId: string;
  kind: Extract<NotificationKind, 'message_captured' | 'number_active' | 'member_joined'>;
  /** Exactly-once key, like an email's: a second record of the same event is a no-op. */
  dedupeKey: string;
  /** Customer-safe facts the bell shows (`feedMeta` picks the keys). */
  payload: Record<string, unknown>;
}

/**
 * §7.2 notifications bell (ADR 0041) — a read over the D7 outbox, not a second table.
 *
 * The rows an email already left behind (low balance, failed auto top-up, rental, release)
 * are the bell's rows too; the three events the spec names that send no email — a message
 * captured, a number gone live, a member joined — are written here as `in_app` rows with
 * the same exactly-once key, and nobody mails them. A member sees their own rows and the
 * workspace-level ones (`user_id` NULL); "unread" is a per-membership timestamp.
 */
@Injectable()
export class NotificationsFeedService {
  private readonly log = new Logger(NotificationsFeedService.name);

  constructor(private readonly events: EventsService) {}

  /** GET /notifications — the caller's feed, newest first. */
  async list(ctx: WorkspaceContext): Promise<NotificationsResponse> {
    const { seenAt, rows } = await withWorkspace(ctx, async (db) => {
      const [membership, rows] = await Promise.all([
        db.membership.findUnique({ where: { tenantId_userId: { tenantId: ctx.workspaceId, userId: ctx.userId } }, select: { notificationsSeenAt: true } }),
        db.notification.findMany({
          where: {
            tenantId: ctx.workspaceId,
            OR: [{ userId: ctx.userId }, { userId: null }],
            kind: { in: [...FEED_KINDS] },
            channel: { in: [...FEED_CHANNELS] },
          },
          orderBy: { createdAt: 'desc' },
          take: FEED_LIMIT,
          select: { id: true, kind: true, payloadJson: true, createdAt: true },
        }),
      ]);
      return { seenAt: membership?.notificationsSeenAt ?? null, rows };
    });
    const items = rows
      .filter((r) => isFeedKind(r.kind))
      .map((r) => ({
        id: r.id,
        kind: r.kind as NotificationKind,
        meta: feedMeta(r.payloadJson),
        created_at: r.createdAt.toISOString(),
        unread: isUnread(r.createdAt, seenAt),
      }));
    return { items, unread: items.filter((i) => i.unread).length, seen_at: seenAt?.toISOString() ?? null };
  }

  /** POST /notifications/seen — the caller opened the bell. */
  async markSeen(ctx: WorkspaceContext, now = new Date()): Promise<NotificationsSeenResponse> {
    await withWorkspace(ctx, (db) =>
      db.membership.update({ where: { tenantId_userId: { tenantId: ctx.workspaceId, userId: ctx.userId } }, data: { notificationsSeenAt: now } }),
    );
    return { seen_at: now.toISOString() };
  }

  /**
   * An in-app row for an event that sends no email. The INSERT is the claim (the dedupe
   * key is unique), so a replayed webhook or a retried job records it once; a second
   * call is a quiet no-op. On `adminDb`, like every outbox write: the callers are
   * webhook handlers and jobs with no request context.
   */
  async record(input: RecordInput): Promise<{ recorded: boolean }> {
    const { count } = await adminDb.notification.createMany({
      data: [
        {
          tenantId: input.workspaceId,
          userId: null,
          kind: input.kind,
          dedupeKey: input.dedupeKey,
          channel: 'in_app',
          status: 'sent',
          sentAt: new Date(),
          payloadJson: input.payload as Prisma.InputJsonValue,
        },
      ],
      skipDuplicates: true,
    });
    if (count === 1) {
      await this.events.publish(input.workspaceId, NotificationEvents.topic, NotificationEvents.new, { kind: input.kind }).catch((e: unknown) => this.log.warn(`notifications frame not published: ${String(e)}`));
    }
    return { recorded: count === 1 };
  }
}
