import { z } from 'zod';

/** Error envelope per spec §16: {code, message, fields?[]} — every non-2xx response. */
export const fieldError = z.object({ field: z.string(), message: z.string() });
export type FieldError = z.infer<typeof fieldError>;

export const errorResponse = z.object({
  code: z.string(),
  message: z.string(),
  fields: z.array(fieldError).optional(),
});
export type ErrorResponse = z.infer<typeof errorResponse>;

/**
 * Stable error codes. The portal branches on `code`, never on the message or the status,
 * so a code is part of the API contract: add freely, rename never.
 *
 * Codes named in the spec: 402 NO_CREDITS, 403 EMAIL_UNVERIFIED, 429 TEST_RATE_LIMIT (§16).
 */
export const ErrorCode = {
  // 400
  BAD_REQUEST: 'BAD_REQUEST',
  WORKSPACE_REQUIRED: 'WORKSPACE_REQUIRED',
  INVALID_CURSOR: 'INVALID_CURSOR',
  REASON_CODE_REQUIRED: 'REASON_CODE_REQUIRED',
  PACK_UNAVAILABLE: 'PACK_UNAVAILABLE',
  PROMO_INVALID: 'PROMO_INVALID',
  BRIEF_INCOMPLETE: 'BRIEF_INCOMPLETE',
  INVITE_INVALID: 'INVITE_INVALID',
  /** Auto top-up asked for with no saved card, or a portal session with no Stripe customer. */
  NO_PAYMENT_METHOD: 'NO_PAYMENT_METHOD',
  /** A phone plan or number request that the plan tier does not allow (max_numbers, sip_import, knowledge_base). */
  PLAN_LIMIT: 'PLAN_LIMIT',
  /** A W2 document we could not read any text from (a scan, a corrupt file — ADR 0023). */
  DOCUMENT_UNREADABLE: 'DOCUMENT_UNREADABLE',
  // 401
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_TOKEN: 'INVALID_TOKEN',
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
  // 402
  NO_CREDITS: 'NO_CREDITS',
  // 403
  EMAIL_UNVERIFIED: 'EMAIL_UNVERIFIED',
  FORBIDDEN_ROLE: 'FORBIDDEN_ROLE',
  NOT_A_MEMBER: 'NOT_A_MEMBER',
  MFA_REQUIRED: 'MFA_REQUIRED',
  OWNER_ONLY: 'OWNER_ONLY',
  STAFF_ONLY: 'STAFF_ONLY',
  STAFF_LIMIT_EXCEEDED: 'STAFF_LIMIT_EXCEEDED',
  WORKSPACE_PAUSED: 'WORKSPACE_PAUSED',
  /** A staff view-as session (admin §7.4) tried a write. Every mutation is refused under it. */
  IMPERSONATION_READ_ONLY: 'IMPERSONATION_READ_ONLY',
  /** Staff locked this sign-in (SA3). */
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  /** §6.2: a throwaway address (the open-source disposable list). Free mail is allowed. */
  EMAIL_DISPOSABLE: 'EMAIL_DISPOSABLE',
  /** §6.2 CSRF: a state-changing request whose `Origin` is not the portal or the console. */
  ORIGIN_NOT_ALLOWED: 'ORIGIN_NOT_ALLOWED',
  // 404
  NOT_FOUND: 'NOT_FOUND',
  // 409
  CONFLICT: 'CONFLICT',
  PURCHASES_PAUSED: 'PURCHASES_PAUSED',
  GENERATION_PAUSED: 'GENERATION_PAUSED',
  /** The SA12 `pause_web_tests` kill switch is on (§13.4). */
  TESTS_PAUSED: 'TESTS_PAUSED',
  /** Every concurrent-call slot of the plan is taken by a live call (§13.4 test call, §5.2 caps). */
  CONCURRENCY_LIMIT: 'CONCURRENCY_LIMIT',
  ALREADY_MEMBER: 'ALREADY_MEMBER',
  AGENT_IN_USE: 'AGENT_IN_USE',
  PUBLISH_IN_PROGRESS: 'PUBLISH_IN_PROGRESS',
  VERSION_IMMUTABLE: 'VERSION_IMMUTABLE',
  ACTIVATION_IN_PROGRESS: 'ACTIVATION_IN_PROGRESS',
  NUMBER_IN_USE: 'NUMBER_IN_USE',
  // 422
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  LINT_FAILED: 'LINT_FAILED',
  GENERATION_FAILED: 'GENERATION_FAILED',
  /** A pricing publish below the margin floor without an override (admin §5.4). */
  MARGIN_FLOOR: 'MARGIN_FLOOR',
  // 429
  TEST_RATE_LIMIT: 'TEST_RATE_LIMIT',
  RATE_LIMITED: 'RATE_LIMITED',
  // 5xx
  INTERNAL: 'INTERNAL',
  UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE',
  /** A platform configuration row (the agent stack, admin SA6) is missing or invalid. */
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  /** Stripe refused the price sync; the version stays unpublished (admin §5.2 step 3). */
  STRIPE_SYNC_FAILED: 'STRIPE_SYNC_FAILED',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** The HTTP status each code is served with. One place, so handlers never pick a number. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  WORKSPACE_REQUIRED: 400,
  INVALID_CURSOR: 400,
  REASON_CODE_REQUIRED: 400,
  PACK_UNAVAILABLE: 400,
  PROMO_INVALID: 400,
  BRIEF_INCOMPLETE: 400,
  INVITE_INVALID: 400,
  NO_PAYMENT_METHOD: 400,
  PLAN_LIMIT: 400,
  DOCUMENT_UNREADABLE: 400,
  UNAUTHENTICATED: 401,
  INVALID_TOKEN: 401,
  INVALID_SIGNATURE: 401,
  NO_CREDITS: 402,
  EMAIL_UNVERIFIED: 403,
  FORBIDDEN_ROLE: 403,
  NOT_A_MEMBER: 403,
  MFA_REQUIRED: 403,
  OWNER_ONLY: 403,
  STAFF_ONLY: 403,
  STAFF_LIMIT_EXCEEDED: 403,
  WORKSPACE_PAUSED: 403,
  IMPERSONATION_READ_ONLY: 403,
  ACCOUNT_LOCKED: 403,
  EMAIL_DISPOSABLE: 403,
  ORIGIN_NOT_ALLOWED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PURCHASES_PAUSED: 409,
  GENERATION_PAUSED: 409,
  TESTS_PAUSED: 409,
  CONCURRENCY_LIMIT: 409,
  ALREADY_MEMBER: 409,
  AGENT_IN_USE: 409,
  PUBLISH_IN_PROGRESS: 409,
  VERSION_IMMUTABLE: 409,
  ACTIVATION_IN_PROGRESS: 409,
  NUMBER_IN_USE: 409,
  VALIDATION_FAILED: 422,
  LINT_FAILED: 422,
  GENERATION_FAILED: 422,
  MARGIN_FLOOR: 422,
  TEST_RATE_LIMIT: 429,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  UPSTREAM_UNAVAILABLE: 503,
  NOT_CONFIGURED: 503,
  STRIPE_SYNC_FAILED: 503,
};
