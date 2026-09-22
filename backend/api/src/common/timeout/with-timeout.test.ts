import { describe, expect, it } from 'vitest';
import { TimeoutError, withTimeout } from './with-timeout';

describe('withTimeout', () => {
  it('returns the result when the work finishes inside the budget', async () => {
    await expect(withTimeout(200, async () => 'ok')).resolves.toBe('ok');
  });

  it('rejects with a TimeoutError and aborts the signal when the budget is spent', async () => {
    let aborted = false;
    const slow = withTimeout(20, (signal) => {
      signal.addEventListener('abort', () => {
        aborted = true;
      });
      return new Promise<never>(() => undefined);
    });
    await expect(slow).rejects.toBeInstanceOf(TimeoutError);
    await expect(slow).rejects.toThrow('timed out after 20 ms');
    expect(aborted).toBe(true);
  });

  it('passes a failure through unchanged', async () => {
    await expect(withTimeout(200, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
  });
});
