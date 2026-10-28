import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { adminDb } from '@portal/db';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AllExceptionsFilter } from '../src/common/errors/all-exceptions.filter';
import { AuthModule } from '../src/modules/auth';
import { FakeAuth0Tenant } from './auth0-double';
import { ProbeController } from './probe.controller';

/**
 * The tenancy and staff boundaries, end to end: a real Nest app, real RS256 tokens,
 * real JWKS fetches, real membership lookups. Two things this proves that a unit test
 * cannot — that the customer and staff tenants are genuinely separate key sets, and
 * that a customer token presented to /admin/* gets nowhere.
 */

const customerTenant = new FakeAuth0Tenant('customers', 'https://api.test');
const staffTenant = new FakeAuth0Tenant('staff', 'https://admin-api.test');

let app: NestFastifyApplication;

/** Owner of workspace A, and the only member of it. */
let owner = { sub: '', userId: '' };
/** Belongs to workspace B only — the outsider every isolation assertion uses. */
let outsider = { sub: '', userId: '' };
/** Viewer on workspace A, for the role checks. */
let viewer = { sub: '', userId: '' };

let workspaceA = '';
let workspaceB = '';

let opsStaff = { sub: '', staffId: '' };
let disabledStaff = { sub: '' };

beforeAll(async () => {
  await customerTenant.start();
  await staffTenant.start();

  process.env.AUTH0_CUSTOMER_DOMAIN = customerTenant.domain;
  process.env.AUTH0_CUSTOMER_AUDIENCE = customerTenant.audience;
  process.env.AUTH0_STAFF_DOMAIN = staffTenant.domain;
  process.env.AUTH0_STAFF_AUDIENCE = staffTenant.audience;

  await seed();

  @Module({
    imports: [AuthModule],
    controllers: [ProbeController],
    providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
  })
  class TestModule {}

  const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app?.close();
  await customerTenant.stop();
  await staffTenant.stop();
  await adminDb.$disconnect();
});

async function seed() {
  const run = randomUUID().slice(0, 8);

  const makeUser = async (label: string) => {
    const sub = `auth0|${label}-${run}`;
    const user = await adminDb.user.create({
      data: { authProviderId: sub, email: `${label}-${run}@example.test`, name: label },
    });
    return { sub, userId: user.id };
  };

  owner = await makeUser('owner');
  outsider = await makeUser('outsider');
  viewer = await makeUser('viewer');

  const a = await adminDb.tenant.create({ data: { name: `A ${run}`, country: 'CA' } });
  const b = await adminDb.tenant.create({ data: { name: `B ${run}`, country: 'US' } });
  workspaceA = a.id;
  workspaceB = b.id;

  await adminDb.membership.createMany({
    data: [
      { tenantId: workspaceA, userId: owner.userId, role: 'owner' },
      { tenantId: workspaceA, userId: viewer.userId, role: 'viewer' },
      { tenantId: workspaceB, userId: outsider.userId, role: 'owner' },
    ],
  });

  const ops = await adminDb.staffUser.create({
    data: {
      authProviderId: `google-oauth2|ops-${run}`,
      email: `ops-${run}@metacognixion.test`,
      role: 'ops',
    },
  });
  opsStaff = { sub: ops.authProviderId, staffId: ops.id };

  const disabled = await adminDb.staffUser.create({
    data: {
      authProviderId: `google-oauth2|disabled-${run}`,
      email: `disabled-${run}@metacognixion.test`,
      role: 'support',
      active: false,
    },
  });
  disabledStaff = { sub: disabled.authProviderId };
}

async function call(
  url: string,
  options: { token?: string; workspace?: string } = {},
): Promise<{ status: number; body: { code?: string; message?: string; [k: string]: unknown } }> {
  const response = await app.inject({
    method: 'GET',
    url,
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.workspace ? { 'x-workspace-id': options.workspace } : {}),
    },
  });
  return { status: response.statusCode, body: response.json() };
}

// ---------------------------------------------------------------------------

describe('the default is deny', () => {
  it('serves a @Public() route with no token at all', async () => {
    await expect(call('probe/public')).resolves.toMatchObject({ status: 200 });
  });

  it('refuses a protected route with no Authorization header', async () => {
    const { status, body } = await call('probe/me');
    expect(status).toBe(401);
    expect(body.code).toBe('UNAUTHENTICATED');
  });

  it.each([
    ['a bare token with no scheme', 'abc.def.ghi'],
    ['the wrong scheme', 'Basic abc'],
    ['an empty bearer', 'Bearer '],
  ])('refuses %s', async (_label, authorization) => {
    const response = await app.inject({
      method: 'GET',
      url: 'probe/me',
      headers: { authorization },
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a token this issuer never signed', async () => {
    const { status, body } = await call('probe/me', { token: 'not.a.jwt' });
    expect(status).toBe(401);
    expect(body.code).toBe('INVALID_TOKEN');
  });

  it('refuses an expired token', async () => {
    const token = await customerTenant.mint(owner.sub, { expired: true });
    expect((await call('probe/me', { token })).body.code).toBe('INVALID_TOKEN');
  });

  it('refuses a token minted for a different audience', async () => {
    const token = await customerTenant.mint(owner.sub, { audience: 'https://someone-else' });
    expect((await call('probe/me', { token })).body.code).toBe('INVALID_TOKEN');
  });

  it('refuses a well-formed token for a subject with no account yet', async () => {
    const token = await customerTenant.mint('auth0|never-registered');
    const { status, body } = await call('probe/me', { token });
    expect(status).toBe(401);
    expect(body.code).toBe('UNAUTHENTICATED');
  });
});

describe('the staff boundary', () => {
  it('rejects a customer JWT on /admin/* — the D1 exit check', async () => {
    const token = await customerTenant.mint(owner.sub);
    const { status, body } = await call('admin/probe', { token });
    expect(status).toBe(401);
    expect(body.code).toBe('INVALID_TOKEN');
  });

  it('rejects a customer JWT on /admin/* even with a workspace header attached', async () => {
    const token = await customerTenant.mint(owner.sub);
    const { status } = await call('admin/probe', { token, workspace: workspaceA });
    expect(status).toBe(401);
  });

  it('rejects a staff JWT on a customer route', async () => {
    const token = await staffTenant.mint(opsStaff.sub, { mfa: true });
    const { status, body } = await call('probe/me', { token });
    expect(status).toBe(401);
    expect(body.code).toBe('INVALID_TOKEN');
  });

  it('admits a staff JWT with MFA on /admin/*', async () => {
    const token = await staffTenant.mint(opsStaff.sub, { mfa: true });
    const { status, body } = await call('admin/probe', { token });
    expect(status).toBe(200);
    expect(body).toMatchObject({ staffId: opsStaff.staffId, role: 'ops' });
  });

  it('rejects a staff JWT without the MFA claim', async () => {
    const token = await staffTenant.mint(opsStaff.sub, { mfa: false });
    const { status, body } = await call('admin/probe', { token });
    expect(status).toBe(403);
    expect(body.code).toBe('MFA_REQUIRED');
  });

  it('rejects a deactivated staff account', async () => {
    const token = await staffTenant.mint(disabledStaff.sub, { mfa: true });
    const { status, body } = await call('admin/probe', { token });
    expect(status).toBe(403);
    expect(body.code).toBe('STAFF_ONLY');
  });

  it('rejects a staff-tenant token for someone with no staff row', async () => {
    const token = await staffTenant.mint('google-oauth2|contractor', { mfa: true });
    expect((await call('admin/probe', { token })).body.code).toBe('STAFF_ONLY');
  });

  it('enforces the admin §2.2 role matrix server-side', async () => {
    const token = await staffTenant.mint(opsStaff.sub, { mfa: true });
    const { status, body } = await call('admin/probe/super-only', { token });
    expect(status).toBe(403);
    expect(body.code).toBe('FORBIDDEN_ROLE');
  });

  it('does not treat /administrators as a staff route', async () => {
    const token = await customerTenant.mint(owner.sub);
    const { status } = await call('administrators', { token, workspace: workspaceA });
    expect(status).toBe(200);
  });
});

describe('workspace context', () => {
  it('attaches ctx = {userId, workspaceId, role, ip}', async () => {
    const token = await customerTenant.mint(owner.sub);
    const { status, body } = await call('probe/workspace', { token, workspace: workspaceA });
    expect(status).toBe(200);
    // `ip` is what every audit_log row the request writes takes (QA-074); inject() is 127.0.0.1.
    expect(body).toEqual({
      userId: owner.userId,
      workspaceId: workspaceA,
      role: 'owner',
      ip: '127.0.0.1',
    });
  });

  it('asks for a workspace when the header is missing', async () => {
    const token = await customerTenant.mint(owner.sub);
    const { status, body } = await call('probe/workspace', { token });
    expect(status).toBe(400);
    expect(body.code).toBe('WORKSPACE_REQUIRED');
  });

  it('skips the header on a @NoWorkspace() route', async () => {
    const token = await customerTenant.mint(owner.sub);
    expect((await call('probe/me', { token })).status).toBe(200);
  });

  it('refuses a workspace the caller is not a member of', async () => {
    const token = await customerTenant.mint(owner.sub);
    const { status, body } = await call('probe/workspace', { token, workspace: workspaceB });
    expect(status).toBe(403);
    expect(body.code).toBe('NOT_A_MEMBER');
  });

  it('answers a workspace that does not exist exactly as one that does — no probing', async () => {
    const token = await customerTenant.mint(owner.sub);
    const missing = await call('probe/workspace', { token, workspace: randomUUID() });
    const notMine = await call('probe/workspace', { token, workspace: workspaceB });
    expect(missing).toEqual(notMine);
  });

  it('refuses a malformed workspace id without reaching Postgres', async () => {
    const token = await customerTenant.mint(owner.sub);
    const { status, body } = await call('probe/workspace', { token, workspace: 'not-a-uuid' });
    expect(status).toBe(403);
    expect(body.code).toBe('NOT_A_MEMBER');
  });
});

describe('the §6.1 role matrix', () => {
  it('lets an owner through an owner-only route', async () => {
    const token = await customerTenant.mint(owner.sub);
    expect((await call('probe/owner-only', { token, workspace: workspaceA })).status).toBe(200);
  });

  it('stops a viewer at an owner-only route', async () => {
    const token = await customerTenant.mint(viewer.sub);
    const { status, body } = await call('probe/owner-only', { token, workspace: workspaceA });
    expect(status).toBe(403);
    expect(body.code).toBe('FORBIDDEN_ROLE');
  });

  it('stops a viewer at an editor-and-up route', async () => {
    const token = await customerTenant.mint(viewer.sub);
    expect((await call('probe/editor-and-up', { token, workspace: workspaceA })).status).toBe(403);
  });

  it('lets an owner through an editor-and-up route', async () => {
    const token = await customerTenant.mint(owner.sub);
    expect((await call('probe/editor-and-up', { token, workspace: workspaceA })).status).toBe(200);
  });
});

describe('the §16 error envelope', () => {
  it('answers every failure with {code, message}', async () => {
    const { body } = await call('probe/me');
    expect(Object.keys(body).sort()).toEqual(['code', 'message']);
    expect(typeof body.message).toBe('string');
  });

  it('never leaks a stack trace or an issuer to the client', async () => {
    const token = await staffTenant.mint(opsStaff.sub, { mfa: true });
    const { body } = await call('probe/me', { token });
    const serialised = JSON.stringify(body);
    expect(serialised).not.toMatch(/auth0|127\.0\.0\.1|at Object|\.ts:/);
  });
});
