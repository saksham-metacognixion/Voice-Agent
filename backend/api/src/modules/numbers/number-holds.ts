import { adminDb } from '@portal/db';
import { AppError } from '../../common/errors/app-error';

/** The one sentence for a number some other row holds — this workspace's or anyone's. */
export const NUMBER_IN_USE_MESSAGE = 'That number is already in use.';

/** Every status but `released` holds its number (`phone_numbers_e164_held_key`, QA-105). */
export const HOLDING_STATUSES = ['provisioning', 'active', 'paused', 'failed', 'releasing'] as const;

export interface NumberHolder {
  id: string;
  tenantId: string;
  planId: string | null;
}

/**
 * The row that holds `e164` now, in any workspace, or null when it is free.
 *
 * On `adminDb` because the question crosses workspaces by nature: under RLS another
 * workspace's row is invisible, the old check passed, and the insert met the unique index
 * as a bare `409 CONFLICT`. Only the holder's ids leave this function, and callers turn
 * them into a yes/no — nothing about the other workspace reaches a response.
 */
export async function numberHolder(e164: string): Promise<NumberHolder | null> {
  return adminDb.phoneNumber.findFirst({
    where: { e164, status: { in: [...HOLDING_STATUSES] } },
    select: { id: true, tenantId: true, planId: true },
  });
}

/**
 * Refuses a SIP number some row already holds, with `409 NUMBER_IN_USE`. `exceptPlanId` is
 * the caller's own plan: a W6 plan whose activation created (and failed) its row must still
 * be editable. A released row holds nothing and is never in the way.
 */
export async function assertNumberFree(e164: string, field: string, options: { exceptPlanId?: string } = {}): Promise<void> {
  const holder = await numberHolder(e164);
  if (!holder) return;
  if (options.exceptPlanId && holder.planId === options.exceptPlanId) return;
  throw numberInUse(field);
}

export function numberInUse(field: string): AppError {
  return new AppError('NUMBER_IN_USE', NUMBER_IN_USE_MESSAGE, [{ field, message: NUMBER_IN_USE_MESSAGE }]);
}
