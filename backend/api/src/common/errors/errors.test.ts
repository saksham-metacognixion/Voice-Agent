import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ArgumentsHost } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { AppError } from './app-error';

function capture(exception: unknown): { status: number; body: Record<string, unknown> } {
  const captured = { status: 0, body: {} as Record<string, unknown> };
  const reply = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    send(body: Record<string, unknown>) {
      captured.body = body;
      return this;
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => reply }),
  } as unknown as ArgumentsHost;

  new AllExceptionsFilter().catch(exception, host);
  return captured;
}

describe('AppError', () => {
  it('derives the status from the code, so no handler picks a number', () => {
    expect(new AppError('NO_CREDITS', 'x').getStatus()).toBe(402);
    expect(new AppError('EMAIL_UNVERIFIED', 'x').getStatus()).toBe(403);
    expect(new AppError('TEST_RATE_LIMIT', 'x').getStatus()).toBe(429);
  });

  it('omits `fields` when there are none', () => {
    expect(new AppError('NOT_FOUND', 'x').getResponse()).toEqual({
      code: 'NOT_FOUND',
      message: 'x',
    });
  });

  it('carries field errors when given them', () => {
    const error = new AppError('VALIDATION_FAILED', 'x', [{ field: 'name', message: 'Required' }]);
    expect(error.getResponse()).toMatchObject({ fields: [{ field: 'name', message: 'Required' }] });
  });
});

describe('AllExceptionsFilter', () => {
  it('passes an AppError through as the §16 envelope', () => {
    const { status, body } = capture(new AppError('NO_CREDITS', 'Your balance is too low.'));
    expect(status).toBe(402);
    expect(body).toEqual({ code: 'NO_CREDITS', message: 'Your balance is too low.' });
  });

  it('turns a ZodError into 422 with one entry per bad field', () => {
    const schema = z.object({ name: z.string(), hours: z.number() });
    const parsed = schema.safeParse({ hours: 'lots' });
    const { status, body } = capture(parsed.success ? new Error('unreachable') : parsed.error);

    expect(status).toBe(422);
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'name' }),
        expect.objectContaining({ field: 'hours' }),
      ]),
    );
  });

  it('turns a ZodError from another copy of zod (the ESM schemas package) into 422, not 500', () => {
    // What the compiled API sees: same name and shape, a different class than this file's `zod`.
    class ForeignZodError extends Error {
      issues = [{ code: 'invalid_string', path: ['session_id'], message: 'Invalid' }];
      constructor() {
        super('[]');
        this.name = 'ZodError';
      }
    }
    const { status, body } = capture(new ForeignZodError());
    expect(status).toBe(422);
    expect(body).toEqual({ code: 'VALIDATION_FAILED', message: 'Some fields need attention.', fields: [{ field: 'session_id', message: 'Invalid' }] });
  });

  it('does not mistake an ordinary error named ZodError without issues for one', () => {
    const odd = new Error('boom');
    odd.name = 'ZodError';
    expect(capture(odd).status).toBe(500);
  });

  it.each([
    [new NotFoundException('nope'), 404, 'NOT_FOUND'],
    [new ForbiddenException('nope'), 403, 'FORBIDDEN_ROLE'],
    [new BadRequestException('nope'), 400, 'BAD_REQUEST'],
  ])('gives Nest’s own %#  exception a code', (exception, status, code) => {
    const captured = capture(exception);
    expect(captured.status).toBe(status);
    expect(captured.body.code).toBe(code);
  });

  it('answers an unexpected error with 500 and says nothing about it', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { status, body } = capture(new TypeError('cannot read property retell_api_key of null'));

    expect(status).toBe(500);
    expect(body).toEqual({ code: 'INTERNAL', message: 'Something went wrong on our side.' });
    expect(JSON.stringify(body)).not.toMatch(/retell_api_key/);
    spy.mockRestore();
  });

  it('answers a non-Error throw without falling over', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(capture('something odd').status).toBe(500);
    spy.mockRestore();
  });

  it('answers a NUL byte Postgres refused (22021, via Prisma) with 422', () => {
    const err = new Error(
      'Error occurred during query execution:\nConnectorError(... PostgresError { code: "22021", message: "invalid byte sequence for encoding \\"UTF8\\": 0x00" ... })',
    );
    err.name = 'PrismaClientUnknownRequestError';
    expect(capture(err).status).toBe(422);
  });

  it('does not read an id that happens to contain 22021 as a NUL byte (review, 28 Sep)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(capture(new Error('job 5a22021b-0c1d-4e2f-8a9b-1234567890ab vanished')).status).toBe(500);
    const prisma = new Error('Record 5a22021b-0c1d-4e2f-8a9b-1234567890ab not found');
    prisma.name = 'PrismaClientKnownRequestError';
    expect(capture(prisma).status).toBe(500);
    spy.mockRestore();
  });
});
