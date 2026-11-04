import { isIP } from 'node:net';
import { Logger } from '@nestjs/common';
import { type Prisma, adminDb } from '@portal/db';

const log = new Logger('AccountAudit');

/**
 * §6.2 "Audit log (workspace-scoped): login, …" (ADR 0036 §9). A sign-in belongs to a
 * person, not a workspace, so an account event is written once into the audit log of
 * every workspace the person belongs to — that is where an owner or admin reads it
 * (`GET /audit-log`, area `auth`). A person with no workspace has no row anywhere, which
 * is also why a failed sign-in for an unknown address leaves no trace a customer can see.
 *
 * `dedupeKey`: the provider's id for the event (a sign-in's time, a log id). A second
 * delivery of the same event finds a row with that key and writes nothing, so a replayed
 * webhook never shows one sign-in twice. Never throws: an audit row that could not be
 * written is logged, and the sign-in it describes has already happened.
 *
 * An address that is not a valid IP (the column is `inet`) is stored as null, never guessed.
 * `meta` must never carry a password, a token, a code or a link (CLAUDE.md, Secrets).
 */
export async function recordAccountEvent(input: {
  userId: string;
  action: string;
  ip?: string | null;
  meta?: Record<string, unknown>;
  dedupeKey?: string;
}): Promise<number> {
  try {
    const memberships = await adminDb.membership.findMany({ where: { userId: input.userId }, select: { tenantId: true } });
    if (memberships.length === 0) return 0;
    if (input.dedupeKey) {
      const seen = await adminDb.auditLog.findFirst({
        where: { actorUserId: input.userId, action: input.action, metaJson: { path: ['event_id'], equals: input.dedupeKey } },
        select: { id: true },
      });
      if (seen) return 0;
    }
    const meta = { ...(input.meta ?? {}), ...(input.dedupeKey ? { event_id: input.dedupeKey } : {}) } as Prisma.InputJsonValue;
    const created = await adminDb.auditLog.createMany({
      data: memberships.map((m) => ({
        tenantId: m.tenantId,
        actorUserId: input.userId,
        action: input.action,
        targetType: 'user',
        targetId: input.userId,
        ip: input.ip && isIP(input.ip) ? input.ip : null,
        metaJson: meta,
      })),
    });
    return created.count;
  } catch (error) {
    log.error(`${input.action} for ${input.userId} not audited: ${error instanceof Error ? error.message : String(error)}`);
    return 0;
  }
}
