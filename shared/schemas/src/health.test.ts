import { describe, expect, it } from 'vitest';
import { healthResponse } from './health.js';

describe('healthResponse', () => {
  it('accepts a valid payload', () => {
    const r = healthResponse.safeParse({
      status: 'ok',
      service: 'api',
      env: 'dev',
      version: '0.0.1',
      time: new Date().toISOString(),
    });
    expect(r.success).toBe(true);
  });
  it('rejects an unknown service', () => {
    expect(healthResponse.safeParse({ status: 'ok', service: 'db' }).success).toBe(false);
  });
});
