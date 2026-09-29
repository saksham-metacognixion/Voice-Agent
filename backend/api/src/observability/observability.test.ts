import type { ErrorEvent } from '@sentry/nestjs';
import { describe, expect, it } from 'vitest';
import { inSpan, scrubEvent } from './observability';

describe('scrubEvent', () => {
  it('drops bodies, cookies and query strings and blanks credential headers', () => {
    const event = scrubEvent({
      type: undefined,
      request: {
        url: 'https://api-staging.oraly.ai/calls/c1/recording/stream?token=secret',
        query_string: 'token=secret',
        data: { brief: { business_name: 'Maple Dental' }, sip_password: 'hunter2' },
        cookies: { session: 'x' },
        headers: {
          Authorization: 'Bearer eyJ…',
          'x-action-secret': 's',
          'stripe-signature': 't=1,v1=…',
          'x-retell-signature': 'v=…',
          'user-agent': 'Chrome',
        },
      },
    } as ErrorEvent);

    expect(event.request?.data).toBeUndefined();
    expect(event.request?.cookies).toBeUndefined();
    expect(event.request?.query_string).toBe('[redacted]');
    expect(event.request?.url).toBe('https://api-staging.oraly.ai/calls/c1/recording/stream');
    expect(event.request?.headers).toEqual({
      Authorization: '[redacted]',
      'x-action-secret': '[redacted]',
      'stripe-signature': '[redacted]',
      'x-retell-signature': '[redacted]',
      'user-agent': 'Chrome',
    });
  });

  it('leaves an event with no request alone', () => {
    const event = scrubEvent({ type: undefined, message: 'boom' } as ErrorEvent);
    expect(event.message).toBe('boom');
  });
});

describe('inSpan', () => {
  it('returns the work result and rethrows its error (no tracer provider = no-op spans)', async () => {
    await expect(inSpan('job x', {}, async () => 42)).resolves.toBe(42);
    await expect(
      inSpan('job y', {}, async () => {
        throw new Error('handler failed');
      }),
    ).rejects.toThrow('handler failed');
  });
});
