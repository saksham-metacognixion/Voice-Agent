import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLAIM_EMAIL, CLAIM_EMAIL_VERIFIED, CLAIM_MFA, CLAIM_MFA_AT, CLAIM_MFA_ENROLLED } from '@portal/schemas';

/*
 * The customer tenant's Actions, run as Auth0 runs them: the real file, a recorded `api`,
 * an `event` shaped like the documented one. What matters is what each branch asks Auth0
 * to do — challenge or not, offer "remember this device" or not — and the claims the API
 * then reads (ADR 0036 §2, §4, §5). The challenge itself (codes, expiry, reuse, the
 * five-attempt lock) is Auth0's and is not reproduced here.
 */
const actionsDir = join(__dirname, '../../../../../infra/auth0/actions');
const requireAction = createRequire(__filename);
const postLogin = requireAction(join(actionsDir, 'customer-post-login.js')).onExecutePostLogin as (event: unknown, api: unknown) => Promise<void>;
const postChangePassword = requireAction(join(actionsDir, 'customer-post-change-password.js')).onExecutePostChangePassword as (event: unknown) => Promise<void>;

interface Recorded {
  access: Record<string, unknown>;
  id: Record<string, unknown>;
  mfa: Array<{ provider: string; options: { allowRememberBrowser?: boolean } }>;
}

function fakeApi(): { api: unknown; seen: Recorded } {
  const seen: Recorded = { access: {}, id: {}, mfa: [] };
  const api = {
    accessToken: { setCustomClaim: (k: string, v: unknown) => (seen.access[k] = v) },
    idToken: { setCustomClaim: (k: string, v: unknown) => (seen.id[k] = v) },
    multifactor: { enable: (provider: string, options: { allowRememberBrowser?: boolean }) => seen.mfa.push({ provider, options }) },
  };
  return { api, seen };
}

function event(over: { enrolled?: boolean; acr?: string[]; refresh?: boolean; methods?: string[]; verified?: boolean } = {}) {
  return {
    user: {
      user_id: 'auth0|abc',
      email: 'owner@example.test',
      email_verified: over.verified ?? true,
      name: 'Owner',
      enrolledFactors: over.enrolled ? [{ type: 'otp' }] : [],
    },
    transaction: { acr_values: over.acr ?? [], protocol: over.refresh ? 'oauth2-refresh-token' : 'oidc-basic-profile' },
    authentication: { methods: (over.methods ?? ['pwd']).map((name) => ({ name, timestamp: '2026-11-03T10:00:00.000Z' })) },
    secrets: {},
  };
}

const STEP_UP = ['http://schemas.openid.net/pape/policies/2007/06/multi-factor'];

describe('customer-post-login — MFA branch (ADR 0036 §2, §4)', () => {
  it('not enrolled, not asked: no challenge, no MFA claim, ordinary sign-in unchanged', async () => {
    const { api, seen } = fakeApi();
    await postLogin(event(), api);
    expect(seen.mfa).toEqual([]);
    expect(seen.access[CLAIM_MFA]).toBe(false);
    expect(seen.id[CLAIM_MFA_ENROLLED]).toBe(false);
    expect(seen.access[CLAIM_EMAIL_VERIFIED]).toBe(true);
    expect(seen.access[CLAIM_EMAIL]).toBe('owner@example.test');
  });

  it('enrolled: challenged, "remember this device" offered, the claim set (tokens only follow a passed challenge)', async () => {
    const { api, seen } = fakeApi();
    await postLogin(event({ enrolled: true }), api);
    expect(seen.mfa).toEqual([{ provider: 'any', options: { allowRememberBrowser: true } }]);
    expect(seen.access[CLAIM_MFA]).toBe(true);
    expect(seen.id[CLAIM_MFA_ENROLLED]).toBe(true);
  });

  it('step-up requested (A5, or the portal after MFA_REQUIRED): a fresh challenge, no remembered device', async () => {
    const { api, seen } = fakeApi();
    await postLogin(event({ acr: STEP_UP }), api);
    expect(seen.mfa).toEqual([{ provider: 'any', options: { allowRememberBrowser: false } }]);
    expect(seen.access[CLAIM_MFA]).toBe(true);
    // The enrolling sign-in: not enrolled when the Action read it, enrolled once tokens are issued.
    expect(seen.id[CLAIM_MFA_ENROLLED]).toBe(true);
    expect(seen.access[CLAIM_MFA_ENROLLED]).toBe(true);
  });

  it('after the factor is removed, a refresh says not enrolled although the session passed one (D6 turn off)', async () => {
    const { api, seen } = fakeApi();
    await postLogin(event({ enrolled: false, refresh: true, methods: ['pwd', 'mfa'] }), api);
    expect(seen.id[CLAIM_MFA_ENROLLED]).toBe(false);
    expect(seen.access[CLAIM_MFA_ENROLLED]).toBe(false);
  });

  it('a step-up challenges even a session that already passed a factor', async () => {
    const { api, seen } = fakeApi();
    await postLogin(event({ enrolled: true, acr: STEP_UP, methods: ['pwd', 'mfa'] }), api);
    expect(seen.mfa).toEqual([{ provider: 'any', options: { allowRememberBrowser: false } }]);
  });

  it('enrolled and the session already passed: no second challenge, the claim kept', async () => {
    const { api, seen } = fakeApi();
    await postLogin(event({ enrolled: true, methods: ['pwd', 'mfa'] }), api);
    expect(seen.mfa).toEqual([]);
    expect(seen.access[CLAIM_MFA]).toBe(true);
  });

  it('refresh grant from a session that passed: never challenged (it cannot be), claim kept', async () => {
    const { api, seen } = fakeApi();
    await postLogin(event({ enrolled: true, refresh: true, methods: ['pwd', 'mfa'] }), api);
    expect(seen.mfa).toEqual([]);
    expect(seen.access[CLAIM_MFA]).toBe(true);
  });

  it('refresh grant from a session that did not pass: never challenged, claim false — enrolment later does not upgrade old sessions', async () => {
    const { api, seen } = fakeApi();
    await postLogin(event({ enrolled: true, refresh: true, acr: STEP_UP }), api);
    expect(seen.mfa).toEqual([]);
    expect(seen.access[CLAIM_MFA]).toBe(false);
  });

  it('stamps when the factor was passed: now for a challenge, the session’s time otherwise, nothing without one (D6 re-auth)', async () => {
    const before = Math.floor(Date.now() / 1000);
    const challenged = fakeApi();
    await postLogin(event({ acr: STEP_UP }), challenged.api);
    expect(challenged.seen.access[CLAIM_MFA_AT]).toBeGreaterThanOrEqual(before);

    const passedEarlier = fakeApi();
    await postLogin(event({ enrolled: true, refresh: true, methods: ['pwd', 'mfa'] }), passedEarlier.api);
    expect(passedEarlier.seen.access[CLAIM_MFA_AT]).toBe(Math.floor(Date.parse('2026-11-03T10:00:00.000Z') / 1000));

    const never = fakeApi();
    await postLogin(event(), never.api);
    expect(never.seen.access[CLAIM_MFA_AT]).toBeUndefined();
    // The API keeps `users.mfa_enabled` from this.
    expect(never.seen.access[CLAIM_MFA_ENROLLED]).toBe(false);
  });

  it('an unverified address gets the claim the API refuses test calls and checkout on', async () => {
    const { api, seen } = fakeApi();
    await postLogin(event({ verified: false }), api);
    expect(seen.access[CLAIM_EMAIL_VERIFIED]).toBe(false);
  });

  it('malformed fields never fail the sign-in', async () => {
    const { api, seen } = fakeApi();
    await postLogin({ user: { user_id: 'auth0|x', email: 'a@b.test', enrolledFactors: 'otp', multifactor: null }, transaction: { acr_values: 'multi-factor' }, authentication: null, secrets: {} }, api);
    expect(seen.mfa).toHaveLength(1);
    expect(seen.access[CLAIM_MFA]).toBe(true);
  });
});

describe('customer-post-change-password (ADR 0036 §5)', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('tells the API, with a per-change event id and never the password', async () => {
    await postChangePassword({ user: { user_id: 'auth0|abc', email: 'owner@example.test', email_verified: true, name: 'O' }, secrets: { API_PUBLIC_URL: 'https://api.test', ACTION_SECRET: 's3cret' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.test/webhooks/auth');
    expect((init.headers as Record<string, string>)['x-action-secret']).toBe('s3cret');
    const body = JSON.parse(String(init.body));
    expect(body.event_type).toBe('user.password_changed');
    expect(body.external_id).toBe('auth0|abc');
    expect(body.event_id).toMatch(/^password_changed\|auth0\|abc\|\d{4}-/);
    expect(JSON.stringify(body)).not.toMatch(/password"\s*:/);
  });

  it('a dead API never blocks the change', async () => {
    fetchMock.mockRejectedValue(new Error('down'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(postChangePassword({ user: { user_id: 'auth0|abc', email: 'o@e.test' }, secrets: { API_PUBLIC_URL: 'https://api.test', ACTION_SECRET: 's' } })).resolves.toBeUndefined();
  });
});
