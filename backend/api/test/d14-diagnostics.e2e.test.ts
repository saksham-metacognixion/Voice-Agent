import { randomUUID } from 'node:crypto';
import { adminDb } from '@portal/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpsAlertService, type OpsAlert } from '../src/modules/alerts';
import { type D5Harness, startD5Harness } from './d5-fixtures';

/*
 * D14 — the two diagnostics routes staging's observability check is run with:
 *   POST /admin/system/test-error   a real throw through the exception filter (→ Sentry)
 *   POST /admin/system/test-alert   one ops alert through every sink (→ Slack)
 * Both super_admin/ops only; a customer token never reaches either.
 */

let h: D5Harness;
const delivered: OpsAlert[] = [];
let tokens: Record<'superAdmin' | 'ops' | 'finance' | 'readOnly', string>;
let customerToken: string;

beforeAll(async () => {
  h = await startD5Harness({ workers: false });
  const run = randomUUID().slice(0, 8);
  const make = async (label: string, role: 'super_admin' | 'ops' | 'finance' | 'read_only') => {
    const row = await adminDb.staffUser.create({
      data: {
        authProviderId: `google-oauth2|d14-${label}-${run}`,
        email: `d14-${label}-${run}@metacognixion.test`,
        role,
      },
    });
    return h.staffTenant.mint(row.authProviderId, { mfa: true });
  };
  tokens = {
    superAdmin: await make('sa', 'super_admin'),
    ops: await make('ops', 'ops'),
    finance: await make('fin', 'finance'),
    readOnly: await make('ro', 'read_only'),
  };
  customerToken = await h.customerTenant.mint(`auth0|d14-${run}`, {
    email: `d14-${run}@example.test`,
  });

  h.app.get(OpsAlertService).addSink({
    name: 'e2e-slack',
    deliver: async (alert) => {
      delivered.push(alert);
    },
  });
  h.app.get(OpsAlertService).addSink({
    name: 'e2e-broken',
    deliver: async () => {
      throw new Error('webhook answered 404');
    },
  });
});

afterAll(async () => {
  await h?.stop();
  await adminDb.$disconnect();
});

function post(path: string, token: string) {
  return h.app.inject({ method: 'POST', url: path, headers: { authorization: `Bearer ${token}` } });
}

describe('POST /admin/system/test-alert', () => {
  it('sends one alert to every sink and says what each answered', async () => {
    const res = await post('/admin/system/test-alert', tokens.ops);
    expect(res.statusCode).toBe(201);
    const body = res.json() as { delivered: Array<{ sink: string; ok: boolean; error?: string }> };
    expect(body.delivered).toEqual(
      expect.arrayContaining([
        { sink: 'e2e-slack', ok: true },
        { sink: 'e2e-broken', ok: false, error: 'webhook answered 404' },
      ]),
    );
    expect(delivered.at(-1)).toMatchObject({ kind: 'diagnostics_test', severity: 'warning' });
    expect(String(delivered.at(-1)?.fields.requested_by)).toMatch(/^d14-ops-/);
  });
});

describe('POST /admin/system/test-error', () => {
  it('answers 500 INTERNAL through the exception filter, never a stack trace', async () => {
    const res = await post('/admin/system/test-error', tokens.superAdmin);
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ code: 'INTERNAL', message: 'Something went wrong on our side.' });
    expect(res.body).not.toMatch(/D14 diagnostics|at .*\.ts/);
  });
});

describe('who may run them', () => {
  it.each(['/admin/system/test-error', '/admin/system/test-alert'])(
    '%s refuses finance, read-only and a customer token',
    async (path) => {
      expect((await post(path, tokens.finance)).statusCode).toBe(403);
      expect((await post(path, tokens.readOnly)).statusCode).toBe(403);
      expect((await post(path, customerToken)).statusCode).toBe(401);
      expect((await h.app.inject({ method: 'POST', url: path })).statusCode).toBe(401);
    },
  );
});
