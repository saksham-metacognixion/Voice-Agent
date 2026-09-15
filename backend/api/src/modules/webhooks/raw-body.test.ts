import { Controller, Post, Req } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWebhookJsonParser, keepsRawBody, registerWebhookRawBody } from './raw-body';

type Echo = { raw: string | null; body: unknown };
const echo = (req: { rawBody?: Buffer; body: unknown }): Echo => ({
  raw: req.rawBody?.toString('utf8') ?? null,
  body: req.body,
});

@Controller()
class ProbeController {
  @Post('webhooks/retell')
  hook(@Req() req: { rawBody?: Buffer; body: unknown }): Echo {
    return echo(req);
  }

  @Post('agents')
  plain(@Req() req: { rawBody?: Buffer; body: unknown }): Echo {
    return echo(req);
  }
}

// Odd spacing and key order on purpose: JSON.stringify(parsed) would not reproduce it.
const WIRE = '{ "event":"call_ended" ,  "call": {"z":1,"a":2} }';
const JSON_HEADERS = { 'content-type': 'application/json' };

/**
 * Boots a real Nest application on the Fastify adapter. The bare-Fastify variant below
 * cannot see the bug this guards against: Nest registers its own JSON parser during
 * init(), and a parser installed the wrong way collides with it at boot.
 */
describe('registerWebhookRawBody on a Nest app', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ controllers: [ProbeController] }).compile();
    app = mod.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    registerWebhookRawBody(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('boots without colliding with the parser Nest installs on init()', () => {
    expect(app).toBeDefined();
  });

  it('keeps the exact bytes under /webhooks/* and still parses the body', async () => {
    const res = await app.inject({ method: 'POST', url: '/webhooks/retell', headers: JSON_HEADERS, payload: WIRE });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ raw: WIRE, body: { event: 'call_ended', call: { z: 1, a: 2 } } });
  });

  it('matches application/json with a charset parameter (how Stripe sends it)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/retell',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      payload: '{"type":"checkout.session.completed"}',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().raw).toBe('{"type":"checkout.session.completed"}');
  });

  it('does not retain a raw copy for any other route', async () => {
    const res = await app.inject({ method: 'POST', url: '/agents', headers: JSON_HEADERS, payload: '{"name":"x"}' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ raw: null, body: { name: 'x' } });
  });

  it('rejects malformed and empty JSON with 400, like the default parser', async () => {
    const bad = await app.inject({ method: 'POST', url: '/webhooks/retell', headers: JSON_HEADERS, payload: '{not json' });
    expect(bad.statusCode).toBe(400);
    const empty = await app.inject({ method: 'POST', url: '/webhooks/retell', headers: JSON_HEADERS, payload: '' });
    expect(empty.statusCode).toBe(400);
  });

  it('refuses prototype poisoning exactly as Fastify does', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/retell',
      headers: JSON_HEADERS,
      payload: '{"__proto__":{"admin":true}}',
    });
    expect(res.statusCode).toBe(400);
  });

  it('still parses urlencoded bodies, which Nest would otherwise have registered', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'a=1&b=two',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ raw: null, body: { a: '1', b: 'two' } });
  });
});

describe('createWebhookJsonParser on bare Fastify', () => {
  it('is Fastify\'s own parser plus the raw buffer under the prefix', async () => {
    const instance = fastify();
    instance.removeContentTypeParser('application/json');
    instance.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      createWebhookJsonParser(instance) as unknown as Parameters<typeof instance.addContentTypeParser>[2],
    );
    instance.post('/webhooks/x', (req) => echo(req));
    instance.post('/y', (req) => echo(req));

    const hook = await instance.inject({ method: 'POST', url: '/webhooks/x', headers: JSON_HEADERS, payload: WIRE });
    expect(hook.json()).toEqual({ raw: WIRE, body: { event: 'call_ended', call: { z: 1, a: 2 } } });

    const other = await instance.inject({ method: 'POST', url: '/y', headers: JSON_HEADERS, payload: WIRE });
    expect(other.json().raw).toBeNull();
    await instance.close();
  });
});

describe('keepsRawBody', () => {
  it('scopes by path prefix, query string included', () => {
    expect(keepsRawBody({ url: '/webhooks/retell/inbound/abc?mode=decline_404' })).toBe(true);
    expect(keepsRawBody({ url: '/webhooks' })).toBe(false);
    expect(keepsRawBody({ url: '/agents/webhooks/x' })).toBe(false);
  });
});
