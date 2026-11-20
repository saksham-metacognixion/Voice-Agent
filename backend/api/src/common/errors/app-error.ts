import { HttpException } from '@nestjs/common';
import { ERROR_STATUS, type ErrorCode, type FieldError } from '@portal/schemas';

/**
 * The only exception handlers should throw. Carrying the code means the status is
 * derived, never chosen by hand, so `402 NO_CREDITS` means the same thing everywhere.
 *
 *     throw new AppError('NO_CREDITS', 'Your balance is too low for a test call.');
 */
export class AppError extends HttpException {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly fields?: FieldError[],
  ) {
    super({ code, message, ...(fields?.length ? { fields } : {}) }, ERROR_STATUS[code]);
  }

  static notFound(what: string): AppError {
    return new AppError('NOT_FOUND', `${what} not found.`);
  }

  static forbiddenRole(required: string): AppError {
    return new AppError('FORBIDDEN_ROLE', `This action needs the ${required} role.`);
  }
}
