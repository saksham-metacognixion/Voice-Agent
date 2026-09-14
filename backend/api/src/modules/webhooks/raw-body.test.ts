import fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { keepsRawBody, registerWebhookRawBody } from './raw-body';

describe('registerWebhookRawBody', () => {
  const app = fastify();
  registerWebhookRawBody(app);

  let seenRaw: Buffer | undefined = undefined;
  app.post('/webhooks/retell', (req) => {
    seenRaw = req.rawBody;
    return { body: req.body };
  });
  app.post('/agents', (req) => {
    seenRaw = req.rawBody;
    return { body: req.body };
  });

  afterEach(() => {
    seenRaw = undefined;
  });

  it('keeps the exact bytes under /webhooks/* and still parses the body', async () => {
    // Odd spacing and key order on purpose: JSON.stringify(parsed) would not reproduce it.
    const wire = '{ "event":"call_ended" ,  "call": {"z":1,"a":2} }';
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/retell',
      headers: { 'content-type': 'application/json' },
      payload: wire,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ body: { event: 'call_ended', call: { z: 1, a: 2 } } });
    expect(seenRaw?.toString('utf8')).toBe(wire);
  });

  it('matches application/json with a charset parameter (how Stripe sends it)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/retell',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      payload: '{"type":"checkout.session.completed"}',
    });
    expect(res.statusCode).toBe(200);
    expect(seenRaw).toBeInstanceOf(Buffer);
  });

  it('does not retain a raw copy for any other route', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      headers: { 'content-type': 'application/json' },
      payload: '{"name":"x"}',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ body: { name: 'x' } });
    expect(seenRaw).toBeUndefined();
  });

  it('rejects malformed and empty JSON with 400, like the default parser', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/webhooks/retell',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(bad.statusCode).toBe(400);

    const empty = await app.inject({
      method: 'POST',
      url: '/webhooks/retell',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });
    expect(empty.statusCode).toBe(400);
  });

  it('scopes by path prefix, query string included', () => {
    expect(keepsRawBody({ url: '/webhooks/retell/inbound/abc?mode=decline_404' })).toBe(true);
    expect(keepsRawBody({ url: '/webhooks' })).toBe(false);
    expect(keepsRawBody({ url: '/agents/webhooks/x' })).toBe(false);
  });
});
