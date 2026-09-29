import { randomUUID } from 'node:crypto';
import { adminDb } from '@portal/db';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UsersService } from '../src/modules/auth';
import type { FakeAuth0Tenant } from './auth0-double';
import { startD5Harness, waitFor } from './d5-fixtures';

/*
 * D5 review finding 4: a person whose registration webhook never arrived must not be
 * locked out (§13.2).
 *
 * Three paths make a `users` row, and every one of them is the same idempotent upsert:
 *   1. POST /webhooks/auth `user.registered`   the Post-User-Registration Action
 *   2. POST /webhooks/auth `user.login`        the Post-Login Action, every login
 *   3. AuthGuard                                a verified token with our namespaced
 *                                               email claim and no row yet
 * This file drives each, then all of them at once for the same person, and counts rows.
 */

let app: NestFastifyApplication;
let stop: () => Promise<void>;
let customerTenant: FakeAuth0Tenant;

const SECRET = process.env.AUTH0_CUSTOMER_ACTION_SECRET ?? 'e2e-auth0-shared-secret-long-enough';

beforeAll(async () => {
  const harness = await startD5Harness({ workers: true });
  app = harness.app;
  stop = harness.stop;
  customerTenant = harness.customerTenant;
});

afterAll(async () => {
  await stop?.();
  await adminDb.$disconnect();
});

function person(label: string) {
  const run = randomUUID().slice(0, 10);
  return {
    sub: `auth0|${label}-${run}`,
    email: `${label}-${run}@example.test`,
    name: `${label} ${run}`,
  };
}

function webhook(body: unknown) {
  return app.inject({
    method: 'POST',
    url: '/webhooks/auth',
    headers: { 'content-type': 'application/json', 'x-action-secret': SECRET },
    payload: JSON.stringify(body),
  });
}

async function listWorkspaces(token: string) {
  return app.inject({
    method: 'GET',
    url: '/workspaces',
    headers: { authorization: `Bearer ${token}` },
  });
}

async function rowsFor(sub: string) {
  return adminDb.user.findMany({ where: { authProviderId: sub } });
}

// ---------------------------------------------------------------------------
describe('the registration webhook arrived (the normal path)', () => {
  it('creates the user, and a later sign-in finds the row without provisioning', async () => {
    const p = person('registered');
    expect(
      (
        await webhook({
          event_type: 'user.registered',
          external_id: p.sub,
          email: p.email,
          email_verified: true,
          name: p.name,
        })
      ).statusCode,
    ).toBe(200);
    const user = await waitFor('the user row', () =>
      adminDb.user.findUnique({ where: { authProviderId: p.sub } }),
    );
    expect(user.email).toBe(p.email);

    const res = await listWorkspaces(
      await customerTenant.mint(p.sub, { email: p.email, name: p.name }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    expect(await rowsFor(p.sub)).toHaveLength(1);
  });
});

describe('the registration webhook was missed', () => {
  it('the first authenticated request provisions the row from the token’s namespaced claims', async () => {
    const p = person('missed');
    const res = await listWorkspaces(
      await customerTenant.mint(p.sub, { email: p.email, name: p.name }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);

    const rows = await rowsFor(p.sub);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: p.email, name: p.name });
  });

  it('a provisioned person can go straight on to create a workspace (A4)', async () => {
    const p = person('missed-a4');
    const token = await customerTenant.mint(p.sub, { email: p.email });
    const res = await app.inject({
      method: 'POST',
      url: '/workspaces',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: `Provisioned ${p.sub.slice(-6)}`,
        country: 'CA',
        timezone: 'America/Toronto',
      }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().role).toBe('owner');
  });

  it('is still refused when the token carries no namespaced email — a bare `email` claim is not trusted', async () => {
    const p = person('untrusted');
    // FakeAuth0Tenant always sets a bare `email` claim; only our namespace counts.
    const res = await listWorkspaces(await customerTenant.mint(p.sub));
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHENTICATED');
    expect(await rowsFor(p.sub)).toHaveLength(0);
  });

  it('the Post-Login Action’s `user.login` webhook creates the row too', async () => {
    const p = person('login-hook');
    expect(
      (
        await webhook({
          event_type: 'user.login',
          external_id: p.sub,
          email: p.email,
          email_verified: true,
          name: p.name,
        })
      ).statusCode,
    ).toBe(200);
    const user = await waitFor('the user row', () =>
      adminDb.user.findUnique({ where: { authProviderId: p.sub } }),
    );
    expect(user.name).toBe(p.name);
    // Every later login is a 204 duplicate, not a second row.
    expect(
      (
        await webhook({
          event_type: 'user.login',
          external_id: p.sub,
          email: p.email,
          email_verified: true,
          name: p.name,
        })
      ).statusCode,
    ).toBe(204);
    expect(await rowsFor(p.sub)).toHaveLength(1);
  });
});

describe('every path at once still makes exactly one row', () => {
  it('registration webhook, login webhook and a burst of first requests for the same person', async () => {
    const p = person('all-paths');
    const token = await customerTenant.mint(p.sub, { email: p.email, name: p.name });

    const results = await Promise.all([
      webhook({
        event_type: 'user.registered',
        external_id: p.sub,
        email: p.email,
        email_verified: true,
        name: p.name,
      }),
      webhook({
        event_type: 'user.login',
        external_id: p.sub,
        email: p.email,
        email_verified: true,
        name: p.name,
      }),
      ...Array.from({ length: 6 }, () => listWorkspaces(token)),
    ]);
    for (const res of results.slice(2)) expect(res.statusCode).toBe(200);
    for (const res of results.slice(0, 2)) expect([200, 204]).toContain(res.statusCode);

    // Let the queued webhook upserts land, then count.
    await waitFor('both webhook events to be processed', async () => {
      const pending = await adminDb.webhookEvent.count({
        where: { provider: 'auth', externalId: p.sub, processedAt: null },
      });
      return pending === 0 ? true : null;
    });
    expect(await rowsFor(p.sub)).toHaveLength(1);
    expect(await adminDb.user.count({ where: { email: p.email } })).toBe(1);
  });

  it('the upsert itself survives a concurrent burst for a brand-new subject', async () => {
    const users = app.get(UsersService);
    const p = person('upsert-burst');
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () =>
        users.upsert({
          event_type: 'user.login',
          external_id: p.sub,
          email: p.email,
          email_verified: true,
          name: p.name,
        }),
      ),
    );
    expect(outcomes.filter((o) => o.outcome === 'created')).toHaveLength(1);
    expect(new Set(outcomes.map((o) => o.userId)).size).toBe(1);
    expect(await rowsFor(p.sub)).toHaveLength(1);
  });

  it('an existing row is left exactly as it is by a sign-in — provisioning only fills a gap', async () => {
    const p = person('existing');
    await adminDb.user.create({
      data: { authProviderId: p.sub, email: p.email, name: 'Kept Name' },
    });
    const res = await listWorkspaces(
      await customerTenant.mint(p.sub, { email: `changed-${p.email}`, name: 'Token Name' }),
    );
    expect(res.statusCode).toBe(200);
    const rows = await rowsFor(p.sub);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: p.email, name: 'Kept Name' });
  });

  it('refuses to provision a second identity onto an email that already belongs to someone', async () => {
    const first = person('email-owner');
    await adminDb.user.create({ data: { authProviderId: first.sub, email: first.email } });
    const second = person('email-thief');
    const res = await listWorkspaces(await customerTenant.mint(second.sub, { email: first.email }));
    expect(res.statusCode).toBe(409);
    expect(await rowsFor(second.sub)).toHaveLength(0);
    expect(
      (await adminDb.user.findUniqueOrThrow({ where: { email: first.email } })).authProviderId,
    ).toBe(first.sub);
  });
});

// ---------------------------------------------------------------------------
describe('§6.2 disposable email domains (D14)', () => {
  function throwaway(label: string) {
    const p = person(label);
    return { ...p, email: `${label}-${p.sub.slice(-10)}@Inbox.Mailinator.com` };
  }

  it('the registration and login webhooks settle the event and create no row', async () => {
    const p = throwaway('disposable-hook');
    for (const event_type of ['user.registered', 'user.login'] as const) {
      const res = await webhook({ event_type, external_id: p.sub, email: p.email, email_verified: true, name: p.name });
      expect(res.statusCode).toBe(200);
      const settled = await waitFor(`${event_type} to settle`, async () => {
        const row = await adminDb.webhookEvent.findFirst({ where: { provider: 'auth', externalId: p.sub, eventType: event_type } });
        return row?.processedAt ? row : null;
      });
      expect(settled.error).toMatch(/Temporary email addresses cannot be used/);
    }
    expect(await rowsFor(p.sub)).toHaveLength(0);
  });

  it('JIT provisioning answers 403 EMAIL_DISPOSABLE and creates no row', async () => {
    const p = throwaway('disposable-jit');
    const res = await listWorkspaces(await customerTenant.mint(p.sub, { email: p.email, name: p.name }));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'EMAIL_DISPOSABLE' });
    expect(await rowsFor(p.sub)).toHaveLength(0);
  });

  it('free mail is not refused', async () => {
    const p = person('freemail');
    const res = await listWorkspaces(await customerTenant.mint(p.sub, { email: `${p.sub.slice(-10)}@gmail.com`, name: p.name }));
    expect(res.statusCode).toBe(200);
    expect(await rowsFor(p.sub)).toHaveLength(1);
  });
});
