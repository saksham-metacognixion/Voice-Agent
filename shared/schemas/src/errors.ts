import { z } from 'zod';

/** Error envelope per spec §16: {code, message, fields?[]} */
export const fieldError = z.object({ field: z.string(), message: z.string() });

export const errorResponse = z.object({
  code: z.string(),
  message: z.string(),
  fields: z.array(fieldError).optional(),
});
export type ErrorResponse = z.infer<typeof errorResponse>;

/** Stable error codes referenced in the spec. Extend here, never inline strings in handlers. */
export const ErrorCode = {
  NO_CREDITS: 'NO_CREDITS', // 402
  EMAIL_UNVERIFIED: 'EMAIL_UNVERIFIED', // 403
  TEST_RATE_LIMIT: 'TEST_RATE_LIMIT', // 429
  WORKSPACE_REQUIRED: 'WORKSPACE_REQUIRED', // 400
  FORBIDDEN_ROLE: 'FORBIDDEN_ROLE', // 403
  NOT_FOUND: 'NOT_FOUND', // 404
  VALIDATION_FAILED: 'VALIDATION_FAILED', // 422
  INTERNAL: 'INTERNAL', // 500
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
