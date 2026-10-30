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
  /** A8: the link was real but is past `expires_at` — the inviter can resend it (D11). */
  INVITE_EXPIRED: 'INVITE_EXPIRED',
  /** A8: the link was already used by someone else. */
  INVITE_USED: 'INVITE_USED',
  /** A8: signed in as another address than the one the invite was sent to. */
  INVITE_WRONG_EMAIL: 'INVITE_WRONG_EMAIL',
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
  /** D17: a forwarding test is for an Option B number — one with the customer's own line forwarded to it. */
  NOT_FORWARDING_NUMBER: 'NOT_FORWARDING_NUMBER',
  // 402
  NO_CREDITS: 'NO_CREDITS',
  /** D17: what needs a paid pack first — trial credits are browser test calls only (§5.4). */
  PURCHASE_REQUIRED: 'PURCHASE_REQUIRED',
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
  /**
   * D18 outbound (ADR 0031). The `outbound_calls` flag is off for this workspace, or its
   * business verification is missing, waiting on review, or was not approved.
   */
  OUTBOUND_DISABLED: 'OUTBOUND_DISABLED',
  KYC_REQUIRED: 'KYC_REQUIRED',
  KYC_PENDING: 'KYC_PENDING',
  KYC_REJECTED: 'KYC_REJECTED',
  // 404
  NOT_FOUND: 'NOT_FOUND',
  /** D16: re-verify is for a number imported from the customer's own SIP trunk. */
  NOT_SIP_NUMBER: 'NOT_SIP_NUMBER',
  // 409
  CONFLICT: 'CONFLICT',
  /** D16: a SIP re-verify is already running for this number. */
  SIP_VERIFY_IN_PROGRESS: 'SIP_VERIFY_IN_PROGRESS',
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
  /** The version exists but its voice-platform copy is not ready yet (a test call right after Improve). Transient (QA-021). */
  VERSION_SYNCING: 'VERSION_SYNCING',
  /**
   * A test call asked for an older draft: the voice platform keeps one editable draft, so
   * that version's copy now carries a newer script. Only the current draft and versions
   * that were published can be rung (QA-082).
   */
  VERSION_NOT_TESTABLE: 'VERSION_NOT_TESTABLE',
  /**
   * The agent has no generated script yet — nothing to test, publish, activate or improve.
   * Not BRIEF_INCOMPLETE: that one means the brief itself is missing what generation needs (QA-021).
   */
  AGENT_NOT_GENERATED: 'AGENT_NOT_GENERATED',
  /** The operation needs a published agent (resume, point a number at it) and this one never was (QA-021). */
  AGENT_NOT_PUBLISHED: 'AGENT_NOT_PUBLISHED',
  /** D3 "Discard draft": the draft already is the published version — there is nothing to throw away (QA-078). */
  NO_DRAFT_CHANGES: 'NO_DRAFT_CHANGES',
  /** D17 "Call my phone": the workspace has no live number to place the call from. */
  NO_NUMBER: 'NO_NUMBER',
  /**
   * D18 outbound: no verified number to show as the caller ID / the one asked for is not a
   * verified number of this workspace (another workspace's reads the same); the stored
   * outbound settings are unusable; the destination is on a do-not-call list, has not
   * called the workspace in the prior-contact window, or it is outside its calling hours;
   * an attempt with this idempotency key is still being placed.
   */
  CALLER_ID_REQUIRED: 'CALLER_ID_REQUIRED',
  CALLER_ID_UNVERIFIED: 'CALLER_ID_UNVERIFIED',
  /** D18 (QA-085): the caller ID asked for — or the only verified one — is paused; resume it in Numbers. */
  NUMBER_PAUSED: 'NUMBER_PAUSED',
  OUTBOUND_NOT_CONFIGURED: 'OUTBOUND_NOT_CONFIGURED',
  /** D18 (QA-087): `tenants.timezone` is not a zone this runtime knows, so no local day or calling window can be judged. */
  WORKSPACE_TIMEZONE_INVALID: 'WORKSPACE_TIMEZONE_INVALID',
  DNC_LISTED: 'DNC_LISTED',
  NO_PRIOR_CONTACT: 'NO_PRIOR_CONTACT',
  OUTSIDE_CALLING_WINDOW: 'OUTSIDE_CALLING_WINDOW',
  OUTBOUND_IN_PROGRESS: 'OUTBOUND_IN_PROGRESS',
  /** D17: a forwarding test is already ringing for this number. */
  FORWARDING_TEST_IN_PROGRESS: 'FORWARDING_TEST_IN_PROGRESS',
  /**
   * D17 §11.5: the website widget cannot take a call right now. One code for a paused
   * workspace or agent, no credits, every line busy or the inbound kill switch — the
   * answer goes to a stranger's browser, and the workspace's state is not theirs to read.
   */
  WIDGET_UNAVAILABLE: 'WIDGET_UNAVAILABLE',
  // 422
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  LINT_FAILED: 'LINT_FAILED',
  GENERATION_FAILED: 'GENERATION_FAILED',
  /** A pricing publish below the margin floor without an override (admin §5.4). */
  MARGIN_FLOOR: 'MARGIN_FLOOR',
  /**
   * D17 "Call my phone": a well-formed number the test may not ring, one code per reason so
   * the portal can say which (`VALIDATION_FAILED` is a number that is not real). Each also
   * carries `fields: [{field: 'to'}]`.
   */
  DESTINATION_COUNTRY: 'DESTINATION_COUNTRY',
  DESTINATION_TYPE: 'DESTINATION_TYPE',
  DESTINATION_IS_AGENT: 'DESTINATION_IS_AGENT',
  /** D18: the other party of the call has no number we can dial (withheld, a browser call, not a real number). */
  DESTINATION_INVALID: 'DESTINATION_INVALID',
  // 429
  TEST_RATE_LIMIT: 'TEST_RATE_LIMIT',
  /** D18: the workspace placed as many outbound calls today (its local day) as its plan allows. */
  OUTBOUND_DAILY_CAP: 'OUTBOUND_DAILY_CAP',
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
  INVITE_EXPIRED: 400,
  INVITE_USED: 400,
  INVITE_WRONG_EMAIL: 400,
  NO_PAYMENT_METHOD: 400,
  PLAN_LIMIT: 400,
  DOCUMENT_UNREADABLE: 400,
  NOT_SIP_NUMBER: 400,
  NOT_FORWARDING_NUMBER: 400,
  UNAUTHENTICATED: 401,
  INVALID_TOKEN: 401,
  INVALID_SIGNATURE: 401,
  NO_CREDITS: 402,
  PURCHASE_REQUIRED: 402,
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
  OUTBOUND_DISABLED: 403,
  KYC_REQUIRED: 403,
  KYC_PENDING: 403,
  KYC_REJECTED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  SIP_VERIFY_IN_PROGRESS: 409,
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
  VERSION_SYNCING: 409,
  VERSION_NOT_TESTABLE: 409,
  AGENT_NOT_GENERATED: 409,
  AGENT_NOT_PUBLISHED: 409,
  NO_DRAFT_CHANGES: 409,
  NO_NUMBER: 409,
  CALLER_ID_REQUIRED: 409,
  CALLER_ID_UNVERIFIED: 409,
  NUMBER_PAUSED: 409,
  OUTBOUND_NOT_CONFIGURED: 409,
  WORKSPACE_TIMEZONE_INVALID: 409,
  DNC_LISTED: 409,
  NO_PRIOR_CONTACT: 409,
  OUTSIDE_CALLING_WINDOW: 409,
  OUTBOUND_IN_PROGRESS: 409,
  FORWARDING_TEST_IN_PROGRESS: 409,
  WIDGET_UNAVAILABLE: 409,
  VALIDATION_FAILED: 422,
  LINT_FAILED: 422,
  GENERATION_FAILED: 422,
  MARGIN_FLOOR: 422,
  DESTINATION_COUNTRY: 422,
  DESTINATION_TYPE: 422,
  DESTINATION_IS_AGENT: 422,
  DESTINATION_INVALID: 422,
  TEST_RATE_LIMIT: 429,
  OUTBOUND_DAILY_CAP: 429,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  UPSTREAM_UNAVAILABLE: 503,
  NOT_CONFIGURED: 503,
  STRIPE_SYNC_FAILED: 503,
};
