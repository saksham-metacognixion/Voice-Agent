import { randomUUID } from 'node:crypto';
import { adminDb } from '@portal/db';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebhookProcessingService } from '../src/modules/webhooks';
import { startD5Harness, waitFor } from './d5-fixtures';

/*
 * §13.2 step 1 — "Auth provider creates user → webhook user.registered → users upsert".
 *
 * The payload and the `x-action-secret` header are the ones the Action installed in the
 * tenant actually sends (`infra/auth0/actions/customer-post-registration.js`); these
 * tests are written against that file, not against a shape invented here.
 *
 * The receiver follows the same four steps as Retell and Stripe (§13.10): verify, store,
 * 204 on a duplicate, enqueue, 200. The upsert itself runs in the worker, so these tests
 * run one and wait for the row.
 */

let app: NestFastifyApplication;
let stop: () => Promise<void>;
let processing: WebhookProcessingService;

const SECRET = process.env.AUTH0_CUSTOMER_ACTION_SECRET ?? 'e2e-auth0-shared-secret-long-enough';

beforeAll(async () => {
  const harness = await startD5Harness({ workers: true });
  app = harness.app;
  stop = harness.stop;
  processing = app.get(WebhookProcessingService);
});

afterAll(async () => {
  await stop?.();
  await adminDb.$disconnect();
});

function event(over: Record<string, unknown> = {}) {
  const run = randomUUID().slice(0, 12);
  return {
    event_type: 'user.registered',
    external_id: `auth0|${run}`,
    email: `${run}@example.test`,
    email_verified: true,
    name: 'New Customer',
    created_at: new Date().toISOString(),
    ...over,
  };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: '/webhooks/auth',
    headers: { 'content-type': 'application/json', 'x-action-secret': SECRET, ...headers },
    payload: JSON.stringify(body),
  });
}

async function userFor(sub: string) {
  return waitFor(`users row for ${sub}`, () => adminDb.user.findUnique({ where: { authProviderId: sub } }));
}

// ---------------------------------------------------------------------------
describe('POST /webhooks/auth', () => {
  it('mirrors a new user and answers immediately', async () => {
    const payload = event();
    const res = await post(payload);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });

    const user = await userFor(payload.external_id);
    // The Action sends no picture today, so the column stays null rather than being
    // filled with something invented. `picture` is accepted when a later Action adds it.
    expect(user).toMatchObject({ email: payload.email, name: 'New Customer', avatarUrl: null });

    // The event is stored and marked processed — the §13.10 exactly-once record.
    const stored = await adminDb.webhookEvent.findFirstOrThrow({
      where: { provider: 'auth', externalId: payload.external_id },
    });
    expect(stored.eventType).toBe('user.registered');
    await waitFor('the event to be marked processed', async () => {
      const row = await adminDb.webhookEvent.findUniqueOrThrow({ where: { id: stored.id } });
      return row.processedAt ? row : null;
    });
  });

  it('creates no workspace — that is a separate step the customer takes (A4)', async () => {
    const payload = event();
    await post(payload);
    const user = await userFor(payload.external_id);
    expect(await adminDb.membership.count({ where: { userId: user!.id } })).toBe(0);
  });

  it('is idempotent: a redelivered event answers 204 and creates no second user', async () => {
    const payload = event();
    const first = await post(payload);
    expect(first.statusCode).toBe(200);
    await userFor(payload.external_id);
    await waitFor('the first delivery to be processed', async () => {
      const row = await adminDb.webhookEvent.findFirstOrThrow({
        where: { provider: 'auth', externalId: payload.external_id },
      });
      return row.processedAt ? row : null;
    });

    const second = await post(payload);
    expect(second.statusCode).toBe(204);

    expect(await adminDb.user.count({ where: { authProviderId: payload.external_id } })).toBe(1);
    expect(
      await adminDb.webhookEvent.count({ where: { provider: 'auth', externalId: payload.external_id } }),
    ).toBe(1);
  });

  it('is idempotent at the handler too — replaying the stored event changes nothing', async () => {
    const payload = event();
    await post(payload);
    const user = await userFor(payload.external_id);
    const stored = await adminDb.webhookEvent.findFirstOrThrow({
      where: { provider: 'auth', externalId: payload.external_id },
    });

    // SA12 "Replay" runs the same path a second time.
    await adminDb.webhookEvent.update({ where: { id: stored.id }, data: { processedAt: null } });
    const result = await processing.process(stored.id);
    expect(result).toMatchObject({ outcome: 'unchanged' });
    expect(await adminDb.user.count({ where: { authProviderId: payload.external_id } })).toBe(1);
    expect((await adminDb.user.findUniqueOrThrow({ where: { id: user!.id } })).email).toBe(payload.email);
  });

  it('accepts a picture when the Action starts sending one', async () => {
    const payload = event({ picture: 'https://example.test/avatar.png' });
    await post(payload);
    const user = await userFor(payload.external_id);
    expect(user!.avatarUrl).toBe('https://example.test/avatar.png');
  });

  it('refreshes a name or picture that changed between deliveries', async () => {
    const payload = event();
    await post(payload);
    await userFor(payload.external_id);

    const renamed = { ...payload, name: 'Renamed Customer' };
    const stored = await adminDb.webhookEvent.findFirstOrThrow({
      where: { provider: 'auth', externalId: payload.external_id },
    });
    await adminDb.webhookEvent.update({
      where: { id: stored.id },
      data: { processedAt: null, payloadJson: renamed },
    });
    expect(await processing.process(stored.id)).toMatchObject({ outcome: 'updated' });
    expect((await adminDb.user.findUniqueOrThrow({ where: { authProviderId: payload.external_id } })).name).toBe(
      'Renamed Customer',
    );
  });

  it('refuses a malformed payload and stores nothing for the sweeper to retry', async () => {
    const before = await adminDb.webhookEvent.count({ where: { provider: 'auth' } });

    for (const body of [
      {},
      { event_type: 'user.registered' },
      { event_type: 'user.registered', external_id: 'auth0|x', email: 'not-an-email' },
      { event_type: 'user.deleted', external_id: 'auth0|x', email: 'a@b.test' },
      { event_type: 'user.registered', external_id: '', email: 'a@b.test' },
    ]) {
      const res = await post(body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().code).toBe('BAD_REQUEST');
    }

    expect(await adminDb.webhookEvent.count({ where: { provider: 'auth' } })).toBe(before);
  });

  it('refuses a request without the shared secret', async () => {
    const payload = event();
    const res = await post(payload, { 'x-action-secret': 'wrong' });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('INVALID_SIGNATURE');
    expect(await adminDb.user.findUnique({ where: { authProviderId: payload.external_id } })).toBeNull();
  });

  it('refuses a request with no secret header at all', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/auth',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(event()),
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses to move an email onto a second identity', async () => {
    const first = event();
    await post(first);
    await userFor(first.external_id);

    // A different Auth0 connection reporting the same address: two identities, not a
    // duplicate to merge. The first keeps the address and the second is refused loudly.
    const collision = event({ email: first.email });
    const res = await post(collision);
    expect(res.statusCode).toBe(200); // stored and queued — the failure is the job's

    // The refusal is the point, not which field records it: the second identity never
    // gets a row, and the first keeps the address.
    await waitFor('the colliding event to be attempted', async () => {
      const row = await adminDb.webhookEvent.findFirstOrThrow({
        where: { provider: 'auth', externalId: collision.external_id },
      });
      return row.error ? row : null;
    });

    expect(await adminDb.user.findUnique({ where: { authProviderId: collision.external_id } })).toBeNull();
    expect((await adminDb.user.findUniqueOrThrow({ where: { email: first.email } })).authProviderId).toBe(
      first.external_id,
    );
  });

  it('is picked up by the sweeper when the enqueue never happened', async () => {
    const payload = event();
    // A row stored but never queued — the narrow window the §13.11 sweeper closes.
    const stored = await adminDb.webhookEvent.create({
      data: {
        provider: 'auth',
        externalId: payload.external_id,
        eventType: 'user.registered',
        payloadJson: payload,
        receivedAt: new Date(Date.now() - 120_000),
      },
    });

    const swept = await processing.sweep(60_000, 200);
    expect(swept.found).toBeGreaterThanOrEqual(1);

    await waitFor('the swept event to create the user', () =>
      adminDb.user.findUnique({ where: { authProviderId: payload.external_id } }),
    );
    // The user row is written *inside* the handler and `processed_at` a moment after it
    // returns, so wait for the mark rather than reading it the instant the row appears.
    const row = await waitFor('the swept event to be marked processed', async () => {
      const event = await adminDb.webhookEvent.findUniqueOrThrow({ where: { id: stored.id } });
      return event.processedAt ? event : null;
    });
    expect(row.processedAt).not.toBeNull();
  });
});
