import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('returns ok', async () => {
    const mod = await Test.createTestingModule({ controllers: [HealthController] }).compile();
    const res = mod.get(HealthController).get();
    expect(res.status).toBe('ok');
    expect(res.service).toBe('api');
  });
});
