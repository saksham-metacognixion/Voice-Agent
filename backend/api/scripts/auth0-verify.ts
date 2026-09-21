/**
 * The D5 gap: everything about Auth0 is exercised against a double.
 *
 *   pnpm --filter @portal/api verify:auth0
 *   pnpm --filter @portal/api verify:auth0 --token "<access token>"
 *   pnpm --filter @portal/api verify:auth0 --api http://localhost:4000
 *
 * `auth0-double.ts` mints tokens with a key the test owns, so the e2e suite proves the
 * guard's logic and nothing about the tenant: whether the Post-Login Action is bound to
 * its trigger, whether it stamps the claims on the **access** token rather than the ID
 * token, whether the shared secret in the Action matches the one in .env. All three fail
 * silently in production and all three have a check below, against the real tenant.
 *
 * Four things are verified, in the order they happen to a new customer:
 *
 *   1. the two Actions in the tenant are the ones in infra/auth0/actions/, are bound to a
 *      trigger, and carry their secrets;
 *   2. POST /webhooks/auth with the real shared secret stores an event and the worker
 *      writes the `users` row (§13.2 step 1);
 *   3. a real access token carries `https://portal/email` — the claim, on the token the
 *      API actually verifies;
 *   4. with that token and **no `users` row**, the first authenticated request provisions
 *      one (`AuthGuard.provision`) — the last line of defence, until now only ever seen
 *      with a forged token.
 *
 * Step 3 needs a token a browser would get. Two ways in, in order of preference:
 *
 *   --token "<jwt>"  — paste one from a real login. Nothing is changed in the tenant.
 *   password grant   — set AUTH0_CUSTOMER_TEST_CLIENT_ID / _SECRET to a non-public
 *                      application with the Password grant enabled, and this creates a
 *                      throwaway user, signs in as it, and deletes it again. Dev tenants
 *                      only; docs/runbooks/auth0.md §4 says how and why it is off by
 *                      default.
 *
 * Without either, steps 1 and 2 still run and step 3–4 are reported as skipped rather
 * than passed. Needs the API **and the worker** running, and refuses to run in prod.
 */
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { adminDb, disconnect } from '@portal/db';
import { resolveAppEnv } from '../src/common/env';

const ACTIONS_DIR = path.resolve(__dirname, '../../../infra/auth0/actions');
const run = randomUUID().slice(0, 8);

/** What each Action must look like in the tenant, and where its source lives here. */
const EXPECTED_ACTIONS = [
  {
    name: 'customer-post-registration',
    file: 'customer-post-registration.js',
    trigger: 'post-user-registration',
    secrets: ['API_PUBLIC_URL', 'ACTION_SECRET'],
  },
  {
    name: 'customer-post-login',
    file: 'customer-post-login.js',
    trigger: 'post-login',
    secrets: ['API_PUBLIC_URL', 'ACTION_SECRET'],
  },
] as const;

const CLAIM_EMAIL = 'https://portal/email';
const CLAIM_EMAIL_VERIFIED = 'https://portal/email_verified';

let failures = 0;
let skipped = 0;
const cleanup: Array<() => Promise<unknown>> = [];

function pass(what: string, detail = ''): void {
  console.log(`✓ ${what}${detail ? `  ${detail}` : ''}`);
}
function fail(what: string, detail: string): void {
  failures += 1;
  console.log(`✗ ${what}  ${detail}`);
}
function skip(what: string, why: string): void {
  skipped += 1;
  console.log(`· ${what}  skipped — ${why}`);
}

async function main(): Promise<void> {
  const env = resolveAppEnv();
  if (env === 'prod') {
    throw new Error('This creates and deletes users. It does not run against prod.');
  }

  const domain = required('AUTH0_CUSTOMER_DOMAIN')
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  const audience = required('AUTH0_CUSTOMER_AUDIENCE');
  const actionSecret = required('AUTH0_CUSTOMER_ACTION_SECRET');
  const api = argValue('--api') ?? `http://localhost:${process.env.API_PORT ?? 4000}`;

  console.log(`tenant ${domain}  •  api ${api}  •  APP_ENV ${env}\n`);
  await assertApiUp(api);

  // ---- 1. the tenant runs the code in this repo ------------------------------------
  const management = await managementToken(domain);
  if (management) {
    await verifyActions(domain, management);
  } else {
    skip(
      'actions',
      'AUTH0_CUSTOMER_M2M_CLIENT_ID / _SECRET are not set (docs/runbooks/auth0.md §1)',
    );
  }

  // ---- 2. the registration webhook, with the real shared secret ---------------------
  await verifyWebhook(api, actionSecret);

  // ---- 3 & 4. claims on a real token, and provisioning from it ----------------------
  const token = await accessToken(domain, audience, management);
  if (!token) {
    skip(
      'claims + JIT provisioning',
      'no access token — pass --token "<jwt>" or set AUTH0_CUSTOMER_TEST_CLIENT_ID/_SECRET',
    );
  } else {
    await verifyClaimsAndProvisioning(api, token, domain);
  }
}

// ---------------------------------------------------------------------------

async function verifyActions(domain: string, token: string): Promise<void> {
  const listed =
    (
      await management<{ actions?: Array<Record<string, any>> }>(
        domain,
        token,
        '/actions/actions?per_page=100',
      )
    ).actions ?? [];

  for (const expected of EXPECTED_ACTIONS) {
    const action = listed.find((candidate) => candidate.name === expected.name);
    if (!action) {
      fail(expected.name, 'not in the tenant — run `pnpm auth0:deploy customer`');
      continue;
    }

    // The deployed code, not the draft. An Action edited in the dashboard and never
    // deployed is the failure this catches.
    const local = readFileSync(path.join(ACTIONS_DIR, expected.file), 'utf8');
    if (normalise(action.code ?? '') !== normalise(local)) {
      fail(
        expected.name,
        `the tenant's copy differs from infra/auth0/actions/${expected.file} — deploy it`,
      );
    } else if (action.all_changes_deployed === false) {
      fail(expected.name, 'has undeployed changes — it is running an older build');
    } else {
      pass(expected.name, 'matches this repo');
    }

    const secretNames = new Set(
      (action.secrets ?? []).map((secret: { name: string }) => secret.name),
    );
    const missing = expected.secrets.filter((name) => !secretNames.has(name));
    if (missing.length > 0)
      fail(`${expected.name} secrets`, `${missing.join(', ')} not set on the Action`);

    // Deployed is not running. Without a binding it executes never and logs nothing.
    const bindings = await management<{ bindings?: Array<{ action?: { name?: string } }> }>(
      domain,
      token,
      `/actions/triggers/${expected.trigger}/bindings`,
    );
    const bound = (bindings.bindings ?? []).some(
      (binding) => binding.action?.name === expected.name,
    );
    if (bound) pass(`${expected.name} → ${expected.trigger}`, 'bound');
    else fail(`${expected.name} → ${expected.trigger}`, 'not bound to the trigger — it never runs');
  }
}

/**
 * §13.2 step 1 end to end: the route accepts the shared secret that is really in .env,
 * the event is stored, and the worker turns it into a row. A 401 here means the Action's
 * ACTION_SECRET and AUTH0_CUSTOMER_ACTION_SECRET have drifted apart.
 */
async function verifyWebhook(api: string, secret: string): Promise<void> {
  const subject = `auth0|verify-${run}`;
  const email = `auth0-verify-${run}@example.test`;
  cleanup.push(() => adminDb.user.deleteMany({ where: { authProviderId: subject } }));
  cleanup.push(() =>
    adminDb.webhookEvent.deleteMany({ where: { provider: 'auth', externalId: subject } }),
  );

  const body = {
    event_type: 'user.registered',
    external_id: subject,
    email,
    email_verified: true,
    name: 'Auth0 verify',
    created_at: new Date().toISOString(),
  };
  const post = () =>
    fetch(`${api}/webhooks/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-action-secret': secret },
      body: JSON.stringify(body),
    });

  const first = await post();
  if (first.status !== 200) {
    fail(
      'POST /webhooks/auth',
      `${first.status} ${await first.text()} — is AUTH0_CUSTOMER_ACTION_SECRET the secret the Action sends?`,
    );
    return;
  }
  pass('POST /webhooks/auth', 'accepted the shared secret');

  const user = await waitFor(() =>
    adminDb.user.findUnique({ where: { authProviderId: subject }, select: { id: true } }),
  );
  if (user) pass('users row from the webhook', `worker wrote ${user.id}`);
  else {
    fail(
      'users row from the webhook',
      'the event was stored but no row appeared in 20 s — is `pnpm dev:worker` running?',
    );
    return;
  }

  const second = await post();
  if (second.status === 204) pass('replayed webhook', '204, nothing written twice');
  else fail('replayed webhook', `expected 204, got ${second.status}`);
}

/**
 * The claims live on the access token because that is the one the API verifies; a token
 * that carries them only on the ID token makes every gated route answer EMAIL_UNVERIFIED.
 * Then the part no double can test: delete the row and let the guard rebuild it.
 */
async function verifyClaimsAndProvisioning(
  api: string,
  token: string,
  domain: string,
): Promise<void> {
  const claims = decode(token);
  const subject = String(claims.sub ?? '');

  if (claims.iss !== `https://${domain}/`) {
    fail('access token', `issued by ${claims.iss}, not https://${domain}/`);
    return;
  }
  if (typeof claims[CLAIM_EMAIL] === 'string')
    pass('access token claims', `${CLAIM_EMAIL} present (${claims[CLAIM_EMAIL]})`);
  else {
    fail(
      'access token claims',
      `${CLAIM_EMAIL} is missing — the Post-Login Action is not bound, or sets it on the ID token only`,
    );
    return;
  }
  if (typeof claims[CLAIM_EMAIL_VERIFIED] === 'boolean')
    pass('access token claims', `${CLAIM_EMAIL_VERIFIED} present`);
  else
    fail(
      'access token claims',
      `${CLAIM_EMAIL_VERIFIED} is missing — §6.2 gates cannot be enforced`,
    );

  // Provisioning is only observable from an empty start. A token belonging to somebody
  // with a workspace is not ours to delete, so say so rather than half-run the check.
  const existing = await adminDb.user.findUnique({
    where: { authProviderId: subject },
    select: { id: true, _count: { select: { memberships: true } } },
  });
  if (existing && existing._count.memberships > 0) {
    skip(
      'JIT provisioning',
      `${subject} already has a users row with memberships; use a throwaway account`,
    );
  } else {
    if (existing) await adminDb.user.delete({ where: { id: existing.id } });

    const response = await fetch(`${api}/workspaces`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const row = await adminDb.user.findUnique({
      where: { authProviderId: subject },
      select: { id: true, email: true },
    });
    cleanup.push(() => adminDb.user.deleteMany({ where: { authProviderId: subject } }));

    if (response.status !== 200) {
      fail('GET /workspaces with a real token', `${response.status} ${await response.text()}`);
    } else if (row) {
      pass(
        'JIT provisioning',
        `first request created users ${row.id} (${row.email}) from the token claim`,
      );
    } else {
      fail('JIT provisioning', 'the request succeeded but no users row was created');
    }
  }
}

// --- Auth0 -----------------------------------------------------------------

async function managementToken(domain: string): Promise<string | null> {
  const clientId = process.env.AUTH0_CUSTOMER_M2M_CLIENT_ID?.trim();
  const clientSecret = process.env.AUTH0_CUSTOMER_M2M_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;

  const response = await fetch(`https://${domain}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      audience: `https://${domain}/api/v2/`,
    }),
  });
  if (!response.ok)
    throw new Error(`Management API token: ${response.status} ${await response.text()}`);
  return ((await response.json()) as { access_token: string }).access_token;
}

async function management<T>(
  domain: string,
  token: string,
  route: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`https://${domain}/api/v2${route}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error(`GET ${route}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

/**
 * A token a browser would have got. Either pasted, or minted through the password grant
 * for a user this script creates and then deletes — the Post-Login Action runs for that
 * grant too, which is the whole reason it is usable as a stand-in for a real sign-in.
 */
async function accessToken(
  domain: string,
  audience: string,
  managementToken: string | null,
): Promise<string | null> {
  const pasted = argValue('--token');
  if (pasted) return pasted.replace(/^Bearer\s+/i, '');

  const clientId = process.env.AUTH0_CUSTOMER_TEST_CLIENT_ID?.trim();
  const clientSecret = process.env.AUTH0_CUSTOMER_TEST_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  if (!managementToken)
    throw new Error(
      'The password-grant path needs the M2M credentials to create its throwaway user.',
    );

  const connection =
    process.env.AUTH0_CUSTOMER_TEST_CONNECTION?.trim() || 'Username-Password-Authentication';
  const email = `auth0-verify-${run}@example.test`;
  const password = `Pv-${randomUUID()}!aA1`;

  const created = await management<{ user_id: string }>(domain, managementToken, '/users', {
    method: 'POST',
    body: JSON.stringify({
      connection,
      email,
      password,
      email_verified: true,
      name: 'Auth0 verify',
    }),
  });
  cleanup.push(() =>
    management(domain, managementToken, `/users/${encodeURIComponent(created.user_id)}`, {
      method: 'DELETE',
    }),
  );
  console.log(`  (created throwaway Auth0 user ${created.user_id}; it is deleted on the way out)`);

  const response = await fetch(`https://${domain}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'http://auth0.com/oauth/grant-type/password-realm',
      realm: connection,
      username: email,
      password,
      audience,
      scope: 'openid profile email',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `password grant: ${response.status} ${detail}\n` +
        '  The application needs the Password grant enabled and the tenant needs a Default Directory — docs/runbooks/auth0.md §4.',
    );
  }
  return ((await response.json()) as { access_token: string }).access_token;
}

// --- small helpers ---------------------------------------------------------

function required(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`${key} is not set in .env.`);
  return value;
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function decode(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('--token is not a JWT. Copy the whole access token.');
  return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

function normalise(code: string): string {
  return code.replace(/\r\n/g, '\n').trim();
}

async function assertApiUp(api: string): Promise<void> {
  try {
    await fetch(`${api}/health`, { signal: AbortSignal.timeout(3000) });
  } catch {
    throw new Error(
      `${api} is not answering. Start it with \`pnpm --filter @portal/api dev\` (and dev:worker).`,
    );
  }
}

/** The webhook is processed by the worker, so the row arrives a moment after the 200. */
async function waitFor<T>(read: () => Promise<T | null>, timeoutMs = 20_000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

main()
  .then(async () => {
    for (const undo of cleanup.reverse()) {
      await undo().catch((error) =>
        console.warn(`  cleanup: ${error instanceof Error ? error.message : error}`),
      );
    }
    console.log(
      failures === 0
        ? `\nAuth0 is wired up${skipped > 0 ? ` (${skipped} check(s) skipped)` : ''}.`
        : `\n${failures} problem(s). See docs/runbooks/auth0.md.`,
    );
    await disconnect();
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (error) => {
    for (const undo of cleanup.reverse()) {
      await undo().catch(() => undefined);
    }
    console.error(`\n✗ ${error instanceof Error ? error.message : error}`);
    await disconnect();
    process.exit(1);
  });
