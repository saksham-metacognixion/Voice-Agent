import { describe, expect, it } from 'vitest';
import { InMemoryRedis } from '../redis';
import { EventsService } from './events.service';

/*
 * SSE fan-out without a real Redis: `InMemoryRedis` cannot duplicate a connection, so the
 * service falls back to local delivery — which is exactly what one process does, and what
 * every test and the dev box run on.
 */

const WS = 'ws-1';
const OTHER = 'ws-2';

function service(): { events: EventsService; redis: InMemoryRedis } {
  const redis = new InMemoryRedis();
  return { events: new EventsService(redis), redis };
}

describe('EventsService', () => {
  it('delivers one frame to every subscriber of the workspace, and to no one else', async () => {
    const { events } = service();
    const mine: string[] = [];
    const also: string[] = [];
    const theirs: string[] = [];
    events.subscribe(WS, (e) => mine.push(e.type));
    events.subscribe(WS, (e) => also.push(e.type));
    events.subscribe(OTHER, (e) => theirs.push(e.type));

    await events.publish(WS, 'wallet', 'ledger', { delta: -1.26 });

    expect(mine).toEqual(['ledger']);
    expect(also).toEqual(['ledger']);
    expect(theirs).toEqual([]);
  });

  it('stamps every frame with an id, the topic and a timestamp', async () => {
    const { events } = service();
    const seen: unknown[] = [];
    events.subscribe(WS, (e) => seen.push(e));
    const published = await events.publish(WS, 'call:call_abc', 'ended', { credits_charged: 1.26 });

    expect(published).toMatchObject({ topic: 'call:call_abc', type: 'ended', data: { credits_charged: 1.26 } });
    expect(published!.id).toMatch(/[0-9a-f-]{36}/);
    expect(Date.parse(published!.ts)).toBeGreaterThan(0);
    expect(seen).toEqual([published]);
  });

  it('also publishes to Redis so another API process can serve the same workspace', async () => {
    const { events, redis } = service();
    await events.publish(WS, 'wallet', 'ledger', { delta: 5 });
    expect(redis.published).toHaveLength(1);
    expect(redis.published[0]!.channel).toBe(`events:{${WS}}`);
    expect(JSON.parse(redis.published[0]!.message)).toMatchObject({ topic: 'wallet', type: 'ledger' });
  });

  it('stops delivering after unsubscribe, and unsubscribing twice is harmless', async () => {
    const { events } = service();
    const seen: string[] = [];
    const stop = events.subscribe(WS, (e) => seen.push(e.type));
    await events.publish(WS, 'wallet', 'first', {});
    stop();
    stop();
    await events.publish(WS, 'wallet', 'second', {});
    expect(seen).toEqual(['first']);
    expect(events.listeners(WS)).toBe(0);
  });

  it('keeps serving the other clients when one handler throws — a broken socket is not a billing failure', async () => {
    const { events } = service();
    const survivor: string[] = [];
    events.subscribe(WS, () => {
      throw new Error('client went away mid-write');
    });
    events.subscribe(WS, (e) => survivor.push(e.type));
    await expect(events.publish(WS, 'wallet', 'ledger', {})).resolves.toBeTruthy();
    expect(survivor).toEqual(['ledger']);
  });

  it('still delivers locally when Redis is down, and never throws at the caller', async () => {
    const { events, redis } = service();
    const seen: string[] = [];
    events.subscribe(WS, (e) => seen.push(e.type));
    redis.down = true;
    await expect(events.publish(WS, 'call:call_x', 'in_progress', {})).resolves.toMatchObject({ type: 'in_progress' });
    expect(seen).toEqual(['in_progress']);
  });

  it('refuses a topic that is not one of the four in §16 rather than inventing a channel', async () => {
    const { events, redis } = service();
    const seen: string[] = [];
    events.subscribe(WS, (e) => seen.push(e.type));
    expect(await events.publish(WS, 'not-a-topic', 'x', {})).toBeNull();
    expect(seen).toEqual([]);
    expect(redis.published).toHaveLength(0);
  });

  it('accepts each of the four §16 topic shapes', async () => {
    const { events } = service();
    for (const topic of ['wallet', 'agent:11111111-1111-4111-8111-111111111111', 'call:abcdef', 'activation:22222222-2222-4222-8222-222222222222']) {
      expect(await events.publish(WS, topic, 'ping', {}), topic).not.toBeNull();
    }
  });

  it('counts listeners so a shutdown can see who is still connected', async () => {
    const { events } = service();
    const a = events.subscribe(WS, () => undefined);
    events.subscribe(WS, () => undefined);
    expect(events.listeners(WS)).toBe(2);
    a();
    expect(events.listeners(WS)).toBe(1);
    await events.onApplicationShutdown();
    expect(events.listeners(WS)).toBe(0);
  });
});
