import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FixtureWriter } from './fixture-writer.service';

const ENV_KEYS = ['APP_ENV', 'FIXTURE_DIR', 'CAPTURE_FIXTURES'] as const;

describe('FixtureWriter', () => {
  let dir: string;
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'fixtures-'));
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.APP_ENV = 'dev';
    process.env.FIXTURE_DIR = dir;
    delete process.env.CAPTURE_FIXTURES;
  });

  afterEach(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(dir, { recursive: true, force: true });
  });

  it('writes provider/event-timestamp.json with raw bytes and redacted secrets', async () => {
    const writer = new FixtureWriter();
    const raw = Buffer.from('{"event":"call_ended","call":{"call_id":"c1"}}');
    const file = await writer.capture({
      provider: 'retell',
      eventType: 'call_ended',
      path: '/webhooks/retell',
      headers: { 'x-retell-signature': 'sig', authorization: 'Bearer nope' },
      raw,
      body: JSON.parse(raw.toString()),
    });

    expect(file).toBeDefined();
    expect(path.dirname(file!)).toBe(path.join(dir, 'retell'));
    expect(path.basename(file!)).toMatch(/^call_ended-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.json$/);

    const record = JSON.parse(await readFile(file!, 'utf8'));
    expect(record.raw).toBe(raw.toString('utf8'));
    expect(record.body.call.call_id).toBe('c1');
    expect(record.headers['x-retell-signature']).toBe('sig');
    expect(record.headers.authorization).toBe('[redacted]');
  });

  it('sanitises event names so a hostile payload cannot pick the path', async () => {
    const writer = new FixtureWriter();
    const file = await writer.capture({
      provider: 'stripe',
      eventType: '../../etc/passwd',
      path: '/webhooks/stripe',
      headers: {},
      raw: undefined,
      body: {},
    });
    expect(path.dirname(file!)).toBe(path.join(dir, 'stripe'));
    expect(path.basename(file!)).toMatch(/^\.\._\.\._etc_passwd-/);
  });

  it('is hard-off in prod regardless of other settings', async () => {
    process.env.APP_ENV = 'prod';
    process.env.CAPTURE_FIXTURES = 'true';
    const writer = new FixtureWriter();
    expect(writer.enabled).toBe(false);
    const file = await writer.capture({
      provider: 'retell', eventType: 'call_ended', path: '/', headers: {}, raw: undefined, body: {},
    });
    expect(file).toBeUndefined();
    await expect(readdir(dir)).resolves.toEqual([]);
  });

  it('can be silenced in dev with CAPTURE_FIXTURES=false', () => {
    process.env.CAPTURE_FIXTURES = 'false';
    expect(new FixtureWriter().enabled).toBe(false);
  });
});
