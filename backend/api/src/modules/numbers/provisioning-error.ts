import { AppError } from '../../common/errors/app-error';
import { retellErrorStatus } from '../retell';

/**
 * Why a provisioning or activation step stopped, classified once for the worker, the
 * job row and the customer:
 *
 *   retryable   a transient failure (platform 5xx/429/408, network, Postgres) — BullMQ
 *               may try again within the attempt budget
 *   permanent   the request itself is wrong (platform 4xx, a lint failure, no plan, no
 *               paid purchase, over the plan cap) — retrying would fail identically
 *
 * `customerReason` is the one sentence the customer may read; `message` is the
 * diagnostic for the job row and the log and may name the platform.
 */
export type ProvisioningErrorKind =
  | 'not_published'
  | 'no_plan'
  | 'no_purchase'
  | 'plan_limit'
  | 'lint_failed'
  | 'workspace_paused'
  | 'agent_missing'
  | 'number_missing'
  | 'number_released'
  | 'not_configured'
  | 'rejected'
  | 'area_code_unavailable'
  | 'unavailable'
  | 'internal';

export class ProvisioningError extends Error {
  constructor(
    readonly kind: ProvisioningErrorKind,
    readonly customerReason: string,
    message: string,
    readonly options: { retryable?: boolean; status?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'ProvisioningError';
    if (options.cause !== undefined) this.cause = options.cause;
  }

  get retryable(): boolean {
    return this.options.retryable ?? RETRYABLE_KINDS.has(this.kind);
  }
}

const RETRYABLE_KINDS = new Set<ProvisioningErrorKind>(['unavailable', 'internal']);

/** AppError codes from the publish step that mean "do not try again". */
const PERMANENT_APP_CODES = new Set([
  'LINT_FAILED',
  'BRIEF_INCOMPLETE',
  'AGENT_NOT_GENERATED',
  'AGENT_NOT_PUBLISHED',
  'NOT_FOUND',
  'WORKSPACE_PAUSED',
  'NOT_CONFIGURED',
  'BAD_REQUEST',
  'VALIDATION_FAILED',
  'PLAN_LIMIT',
  'NO_CREDITS',
  'FORBIDDEN_ROLE',
]);

/**
 * Turns whatever a step threw into a `ProvisioningError`. Pure and exported for the unit
 * test: this is the retry policy, and it should be readable in one place.
 */
export function classifyError(error: unknown): ProvisioningError {
  if (error instanceof ProvisioningError) return error;

  if (error instanceof AppError) {
    const body = error.getResponse() as { message?: string; fields?: Array<{ message?: string }> };
    let message = typeof body?.message === 'string' ? body.message : error.message;
    // "This version cannot go live yet." says nothing the customer can act on; the first
    // blocking finding does (W7 shows only this sentence).
    const finding = error.code === 'LINT_FAILED' ? body?.fields?.[0]?.message : undefined;
    if (finding) message = `${message} ${finding}`;
    if (error.code === 'PUBLISH_IN_PROGRESS' || error.code === 'UPSTREAM_UNAVAILABLE') {
      return new ProvisioningError('unavailable', message, `${error.code}: ${message}`, { retryable: true, cause: error });
    }
    if (PERMANENT_APP_CODES.has(error.code)) {
      const kind: ProvisioningErrorKind =
        error.code === 'LINT_FAILED' ? 'lint_failed' : error.code === 'WORKSPACE_PAUSED' ? 'workspace_paused' : error.code === 'NOT_CONFIGURED' ? 'not_configured' : 'rejected';
      return new ProvisioningError(kind, message, `${error.code}: ${message}`, { retryable: false, cause: error });
    }
    return new ProvisioningError('internal', GENERIC_REASON, `${error.code}: ${message}`, { retryable: true, cause: error });
  }

  const status = retellErrorStatus(error);
  if (status !== undefined) {
    const permanent = status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429;
    return new ProvisioningError(
      permanent ? 'rejected' : 'unavailable',
      permanent ? PLATFORM_REJECTED_REASON : GENERIC_REASON,
      `voice platform answered ${status}: ${describe(error)}`,
      { retryable: !permanent, status, cause: error },
    );
  }

  return new ProvisioningError('internal', GENERIC_REASON, describe(error), { retryable: true, cause: error });
}

/**
 * The platform answers a bought number it has no stock for with a 404 — `404 No phone
 * numbers of this area code.` (30 Sep). `NumberProvisioningService.buy` moves on to the
 * next of `purchaseAttempts()` on exactly this answer and on nothing else.
 */
export function isNoNumberStock(error: unknown): boolean {
  return retellErrorStatus(error) === 404 && /no phone numbers/i.test(describe(error));
}

/**
 * Every carrier, every code of the region and any local number all answered "no stock".
 * Permanent for this attempt; the sentence tells the customer what they can change.
 */
export function noNumbersAvailable(row: { country: string; areaCode: string | null; tollFree: boolean }, last: unknown): ProvisioningError {
  const where = row.country === 'CA' ? 'Canada' : 'the US';
  const customerReason = row.tollFree
    ? `No toll-free numbers are available in ${where} right now. Turn off toll-free for a local number, or try again later.`
    : `No phone numbers are available in ${where} right now. Try again later, or contact support and we will find you one.`;
  return new ProvisioningError('area_code_unavailable', customerReason, `voice platform had no stock on any carrier: ${describe(last)}`, {
    retryable: false,
    status: 404,
    cause: last,
  });
}

export const GENERIC_REASON = 'Something went wrong while setting up your number. We will try again shortly.';
export const PLATFORM_REJECTED_REASON = 'Your phone number settings were not accepted. Check the number options and try again.';

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
