import { Logger } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { InMemoryRedis, redisKeys } from '../redis';
import { MintSlot, headroom, webCallTransport } from './call-headroom';

describe('headroom (ADR 0011 §1)', () => {
  const base = { balance: 20, live: { count: 0, credits: 0 }, cap: 2, rate: 1, maxDurationS: 600 };

  it('sizes the ceiling to what the wallet covers after the other live calls', () => {
    expect(headroom({ ...base, live: { count: 1, credits: 15 } })).toEqual({ ok: true, remaining: 5, maxMs: 300_000, cap: 2 });
    expect(headroom(base)).toMatchObject({ ok: true, maxMs: 600_000 });
  });

  it('refuses a full plan before the wallet, and a wallet the other calls hold', () => {
    expect(headroom({ ...base, live: { count: 2, credits: 0 } })).toEqual({ ok: false, reason: 'cap', cap: 2 });
    expect(headroom({ ...base, live: { count: 1, credits: 20 } })).toEqual({ ok: false, reason: 'credits' });
    expect(headroom({ ...base, balance: -1 })).toEqual({ ok: false, reason: 'credits' });
  });

  it('reads a cap of 0 or none as no limit, and keeps the platform floor', () => {
    expect(headroom({ ...base, cap: 0, live: { count: 9, credits: 0 } })).toMatchObject({ ok: true, cap: null });
    expect(headroom({ ...base, cap: undefined })).toMatchObject({ ok: true, cap: null });
    expect(headroom({ ...base, live: { count: 0, credits: 19.99 } })).toMatchObject({ ok: true, maxMs: 60_000 });
  });
});

describe('webCallTransport', () => {
  it('passes through only the fields the platform sent', () => {
    expect(webCallTransport({ call_id: 'c', access_token: 't' })).toEqual({});
    expect(webCallTransport({ transport: 'livekit', url: 'wss://x', expires_at: 5 })).toEqual({ transport: 'livekit', url: 'wss://x', expires_at: 5 });
  });
});

describe('MintSlot', () => {
  const input = { workspaceId: 'ws1', maxMs: 120_000, rate: 1, cap: 2, balance: 10 };
  const log = new Logger('test');

  it('holds a line under a placeholder until the platform answers, then under the call id', async () => {
    const redis = new InMemoryRedis();
    const slot = await MintSlot.take(redis, log, input);
    expect(slot.result).toBe('ok');
    const held = await redis.hgetall(redisKeys.activeCalls('ws1'));
    expect(Object.keys(held)).toHaveLength(1);
    expect(Object.keys(held)[0]).toMatch(/^mint:/);
    expect(held[Object.keys(held)[0]!]).toMatch(/^2\.00\|/);

    await slot.bind('call_1');
    expect(Object.keys(await redis.hgetall(redisKeys.activeCalls('ws1')))).toEqual(['call_1']);
  });

  it('frees the line when the platform refuses, and never overwrites a reservation call_started already wrote', async () => {
    const redis = new InMemoryRedis();
    const refused = await MintSlot.take(redis, log, input);
    await refused.release();
    expect(await redis.hgetall(redisKeys.activeCalls('ws1'))).toEqual({});

    const slot = await MintSlot.take(redis, log, input);
    await redis.hset(redisKeys.activeCalls('ws1'), 'call_2', '0.50|1');
    await slot.bind('call_2');
    expect(await redis.hgetall(redisKeys.activeCalls('ws1'))).toEqual({ call_2: '0.50|1' });
  });
});

describe('MintSlot.bind with Lua (CI, 6 Nov: the two-line race)', () => {
  const input = { workspaceId: 'ws1', maxMs: 120_000, rate: 1, cap: 2, balance: 10 };
  const log = new Logger('test');

  it('moves the placeholder to the call id in one script, so no reader ever counts both', async () => {
    const inner = new InMemoryRedis();
    const scripts: { script: string; args: (string | number)[] }[] = [];
    // A Redis with Lua: the script is recorded, its two commands applied together.
    const redis = Object.assign(inner, {
      eval: async (script: string, _numKeys: number, ...args: (string | number)[]) => {
        scripts.push({ script, args });
        const [key, a, b, c] = args.map(String) as [string, string, string, string];
        if (script.includes('HSETNX')) {
          await inner.hsetnx(key, a, b);
          await inner.hdel(key, c);
          return 'ok';
        }
        await inner.hset(key, a, `${b}|${c}`);
        return 'ok';
      },
    });
    const slot = await MintSlot.take(redis, log, input);
    const [placeholder] = Object.keys(await inner.hgetall(redisKeys.activeCalls('ws1')));
    expect(placeholder).toMatch(/^mint:/);

    await slot.bind('call_9');
    const bind = scripts.at(-1)!;
    expect(bind.script).toContain('HSETNX');
    expect(bind.script).toContain('HDEL');
    expect(bind.args).toEqual([redisKeys.activeCalls('ws1'), 'call_9', expect.stringMatching(/^2\.00\|\d+$/), placeholder]);
    expect(Object.keys(await inner.hgetall(redisKeys.activeCalls('ws1')))).toEqual(['call_9']);
  });
});
