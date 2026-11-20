/**
 * A bounded await, written once. The Redis cache (`RedisCache.attempt`), the readiness
 * probes (`GET /health/ready`) and the email sender all need the same thing — run this,
 * but never wait past a budget — and three private copies of the race drifted apart.
 *
 * `run` receives an AbortSignal that fires when the budget is spent. A caller doing
 * network I/O (`fetch`) passes it on so the request is actually cancelled rather than
 * abandoned; a caller that cannot cancel ignores it. The timer is always cleared, so a
 * fast answer leaves nothing behind to keep the event loop alive.
 */
export class TimeoutError extends Error {
  constructor(readonly ms: number) {
    super(`timed out after ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

export async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new TimeoutError(ms));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
