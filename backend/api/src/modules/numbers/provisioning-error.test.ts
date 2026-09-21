import { describe, expect, it } from 'vitest';
import Retell from 'retell-sdk';
import { AppError } from '../../common/errors/app-error';
import { ProvisioningError, classifyError } from './provisioning-error';

/* The retry policy of §13.8 in one place: what is worth a second attempt, and what is not. */

function retell(status: number): Error {
  return Retell.APIError.generate(status, { message: `status ${status}` }, `status ${status}`, new Headers());
}

describe('classifyError', () => {
  it('keeps a ProvisioningError as it is', () => {
    const error = new ProvisioningError('no_plan', 'Choose a number option.', 'no plan');
    expect(classifyError(error)).toBe(error);
    expect(error.retryable).toBe(false);
  });

  it('a lint failure, a missing brief, a paused workspace and a plan limit are permanent', () => {
    for (const code of ['LINT_FAILED', 'BRIEF_INCOMPLETE', 'WORKSPACE_PAUSED', 'PLAN_LIMIT', 'NO_CREDITS', 'NOT_FOUND'] as const) {
      const classified = classifyError(new AppError(code, `because ${code}`));
      expect(classified.retryable, code).toBe(false);
      expect(classified.customerReason).toBe(`because ${code}`);
    }
    expect(classifyError(new AppError('LINT_FAILED', 'x')).kind).toBe('lint_failed');
    expect(classifyError(new AppError('WORKSPACE_PAUSED', 'x')).kind).toBe('workspace_paused');
  });

  it('a publish already in progress and an upstream outage are retryable', () => {
    expect(classifyError(new AppError('PUBLISH_IN_PROGRESS', 'busy')).retryable).toBe(true);
    expect(classifyError(new AppError('UPSTREAM_UNAVAILABLE', 'down')).retryable).toBe(true);
  });

  it('platform 4xx is permanent, platform 5xx / 429 / 408 / 409 is retryable, and neither leaks the status text to the customer', () => {
    const bad = classifyError(retell(400));
    expect(bad.retryable).toBe(false);
    expect(bad.kind).toBe('rejected');
    expect(bad.options.status).toBe(400);
    expect(bad.customerReason).not.toContain('400');
    for (const status of [500, 502, 503, 429, 408, 409]) {
      const err = classifyError(retell(status));
      expect(err.retryable, String(status)).toBe(true);
      expect(err.kind).toBe('unavailable');
    }
  });

  it('anything else — a network error, a Postgres timeout — is retryable', () => {
    const err = classifyError(new Error('ECONNRESET'));
    expect(err.retryable).toBe(true);
    expect(err.kind).toBe('internal');
    expect(err.message).toBe('ECONNRESET');
    expect(err.customerReason).not.toContain('ECONNRESET');
  });
});

describe('the retry budget', () => {
  it('three attempts: a retryable failure retries on 1 and 2 and gives up on 3', () => {
    const maxAttempts = 3;
    const outcomes = [1, 2, 3].map((attempt) => {
      const error = classifyError(retell(503));
      return error.retryable && attempt < maxAttempts ? 'retry' : 'failed';
    });
    expect(outcomes).toEqual(['retry', 'retry', 'failed']);
  });

  it('a permanent failure gives up on the first attempt', () => {
    const error = classifyError(new AppError('LINT_FAILED', 'fix the prompt'));
    expect(error.retryable && 1 < 3 ? 'retry' : 'failed').toBe('failed');
  });
});
