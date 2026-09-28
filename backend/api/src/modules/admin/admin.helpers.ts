import { Prisma } from '@portal/db';
import type { AdminCustomerStatus } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';

/*
 * Small pure helpers every admin service shares: shape conversions and the one
 * classification the console repeats on every list (SA2 "Status").
 */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A path id that is not a uuid is a 404 before it reaches a Postgres cast (a 500). */
export function uuidParam(value: string, what: string): string {
  if (!UUID_RE.test(value)) throw AppError.notFound(what);
  return value;
}

/** A `where` fragment matching a uuid column on a full uuid, and nothing on anything shorter (Prisma has no prefix match on `@db.Uuid`). */
export function idMatch(q: string): Array<{ id: string }> {
  return UUID_RE.test(q) ? [{ id: q.toLowerCase() }] : [];
}

export function num(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'number' ? value : value.toNumber();
}

export function numOrNull(value: Prisma.Decimal | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' ? value : value.toNumber();
}

export function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/** JSON columns as a record, or an empty one; never throws on a scalar. */
export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export const DAY_MS = 86_400_000;
/** SA2: "At risk (0 balance > 3 d)". */
export const AT_RISK_AFTER_MS = 3 * DAY_MS;
/** SA2 "Churned": nothing for 60 days on a workspace that had gone live. */
export const CHURNED_AFTER_MS = 60 * DAY_MS;

/**
 * SA2 "Status", in precedence order: paused wins, then a wizard that never finished,
 * then an empty wallet that has stayed empty, then silence, else active.
 */
export function customerStatusOf(input: {
  pausedAt: Date | null;
  onboardingCompletedAt: Date | null;
  balance: number;
  /** When the balance last moved (the newest ledger row), or null. */
  balanceSince: Date | null;
  lastActivityAt: Date | null;
  now?: Date;
}): AdminCustomerStatus {
  const now = input.now ?? new Date();
  if (input.pausedAt) return 'paused';
  if (!input.onboardingCompletedAt) return 'onboarding';
  if (
    input.balance <= 0 &&
    input.balanceSince &&
    now.getTime() - input.balanceSince.getTime() > AT_RISK_AFTER_MS
  )
    return 'at_risk';
  if (input.lastActivityAt && now.getTime() - input.lastActivityAt.getTime() > CHURNED_AFTER_MS)
    return 'churned';
  if (
    !input.lastActivityAt &&
    now.getTime() - input.onboardingCompletedAt.getTime() > CHURNED_AFTER_MS
  )
    return 'churned';
  return 'active';
}

/** The trailing window for a range key. */
export function rangeWindow(
  range: '7d' | '30d' | '90d',
  now = new Date(),
): { from: Date; to: Date; days: number } {
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  return { from: new Date(now.getTime() - days * DAY_MS), to: now, days };
}

export function jsonValue(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}
