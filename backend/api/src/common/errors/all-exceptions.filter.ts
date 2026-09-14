import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { ERROR_STATUS, ErrorCode, type ErrorResponse, type FieldError } from '@portal/schemas';
import { isAppendOnlyViolation, isRlsViolation, isUniqueViolation } from '@portal/db';
import { AppError } from './app-error';

/**
 * Turns everything thrown anywhere into the §16 envelope: {code, message, fields?[]}.
 *
 * Two rules it exists to keep:
 *  - a client never sees a stack trace, a Prisma message or a raw SQL error;
 *  - an RLS or append-only rejection is logged as the bug it is, not passed off as a
 *    403, because the guard should have stopped it long before Postgres had to.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Http');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const { status, body, logAs } = this.translate(exception);

    if (logAs === 'error') {
      this.logger.error(
        `${body.code}: ${body.message}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    void reply.status(status).send(body);
  }

  private translate(exception: unknown): {
    status: number;
    body: ErrorResponse;
    logAs: 'error' | 'none';
  } {
    if (exception instanceof AppError) {
      return {
        status: ERROR_STATUS[exception.code],
        body: exception.getResponse() as ErrorResponse,
        logAs: 'none',
      };
    }

    if (exception instanceof ZodError) {
      return {
        status: ERROR_STATUS.VALIDATION_FAILED,
        body: {
          code: ErrorCode.VALIDATION_FAILED,
          message: 'Some fields need attention.',
          fields: toFieldErrors(exception),
        },
        logAs: 'none',
      };
    }

    // A write that RLS or an append-only trigger refused is always our mistake: a
    // service reached outside the workspace in context, or tried to edit history.
    if (isRlsViolation(exception) || isAppendOnlyViolation(exception)) {
      return {
        status: ERROR_STATUS.INTERNAL,
        body: { code: ErrorCode.INTERNAL, message: 'Something went wrong on our side.' },
        logAs: 'error',
      };
    }

    if (isUniqueViolation(exception)) {
      return {
        status: ERROR_STATUS.CONFLICT,
        body: { code: ErrorCode.CONFLICT, message: 'That already exists.' },
        logAs: 'none',
      };
    }

    if (exception instanceof HttpException) {
      return {
        status: exception.getStatus(),
        body: fromHttpException(exception),
        logAs: exception.getStatus() >= 500 ? 'error' : 'none',
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { code: ErrorCode.INTERNAL, message: 'Something went wrong on our side.' },
      logAs: 'error',
    };
  }
}

function toFieldErrors(error: ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || '(body)',
    message: issue.message,
  }));
}

/** Nest's own exceptions (and nestjs-zod's) arrive in a handful of shapes. */
function fromHttpException(exception: HttpException): ErrorResponse {
  const response = exception.getResponse();
  const status = exception.getStatus();

  if (typeof response === 'object' && response !== null) {
    const body = response as Record<string, unknown>;
    if (typeof body.code === 'string' && typeof body.message === 'string') {
      return body as unknown as ErrorResponse;
    }
    if (Array.isArray(body.errors)) {
      return {
        code: ErrorCode.VALIDATION_FAILED,
        message: 'Some fields need attention.',
        fields: (body.errors as { path?: (string | number)[]; message?: string }[]).map((e) => ({
          field: (e.path ?? []).join('.') || '(body)',
          message: e.message ?? 'Invalid value',
        })),
      };
    }
    if (typeof body.message === 'string') {
      return { code: statusToCode(status), message: body.message };
    }
  }

  return { code: statusToCode(status), message: exception.message };
}

const STATUS_FALLBACK: Record<number, ErrorCode> = {
  400: ErrorCode.BAD_REQUEST,
  401: ErrorCode.UNAUTHENTICATED,
  403: ErrorCode.FORBIDDEN_ROLE,
  404: ErrorCode.NOT_FOUND,
  409: ErrorCode.CONFLICT,
  422: ErrorCode.VALIDATION_FAILED,
  429: ErrorCode.RATE_LIMITED,
  503: ErrorCode.UPSTREAM_UNAVAILABLE,
};

function statusToCode(status: number): ErrorCode {
  return STATUS_FALLBACK[status] ?? (status >= 500 ? ErrorCode.INTERNAL : ErrorCode.BAD_REQUEST);
}
