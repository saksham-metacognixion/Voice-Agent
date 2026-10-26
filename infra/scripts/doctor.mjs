#!/usr/bin/env node
/**
 * Environment doctor:  pnpm doctor
 *
 * Says which of the values in docs/runbooks/provisioning.md are still missing and which
 * services answer. Exits non-zero while anything required is unset, so it doubles as a
 * deployment gate.
 *
 * Nothing here prints a secret — only whether one is present.
 */
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadEnvFile } from './lib/env.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

loadEnvFile(resolve(root, '.env'));

/** phase: which day of the plan first needs it. Missing values are only fatal once due. */
const CHECKS = [
  { key: 'APP_ENV', phase: 'D0', required: true },
  { key: 'DATABASE_URL', phase: 'D1', required: true },
  { key: 'ADMIN_DATABASE_URL', phase: 'D1', required: true },
  { key: 'DIRECT_DATABASE_URL', phase: 'D1', required: true },
  { key: 'REDIS_URL', phase: 'D1', required: true },
  { key: 'AUTH0_CUSTOMER_DOMAIN', phase: 'D1', required: true },
  { key: 'AUTH0_CUSTOMER_AUDIENCE', phase: 'D1', required: true },
  { key: 'AUTH0_CUSTOMER_ACTION_SECRET', phase: 'D1', required: true, secret: true },
  { key: 'AUTH0_STAFF_DOMAIN', phase: 'D1', required: true },
  { key: 'AUTH0_STAFF_AUDIENCE', phase: 'D1', required: true },
  { key: 'RETELL_API_KEY', phase: 'D2', required: true, secret: true },
  { key: 'API_PUBLIC_URL', phase: 'D2', required: true },
  // D5 generates prompts with it. Still `required: false` so a machine running only the
  // call path boots, but the D5 checklist below says loudly when it is missing.
  { key: 'ANTHROPIC_API_KEY', phase: 'D2', required: false, secret: true },
  { key: 'STRIPE_SECRET_KEY', phase: 'D3', required: true, secret: true },
  { key: 'STRIPE_WEBHOOK_SECRET', phase: 'D3', required: true, secret: true },
  { key: 'PORTAL_URL', phase: 'D3', required: true },
  // D4: the call runtime. Both have safe defaults, so neither is fatal — but a multi-process
  // API without a shared recording secret mints links its own siblings refuse (§17).
  { key: 'RECORDING_SIGNING_SECRET', phase: 'D4', required: false, secret: true },
  { key: 'INBOUND_REDIS_DOWN_POLICY', phase: 'D4', required: false },
  { key: 'RESEND_API_KEY', phase: 'D5', required: false, secret: true },
  // Without Resend, SMTP delivers instead (a Gmail app password on a dev box). Neither set =
  // every email is a log line.
  { key: 'SMTP_HOST', phase: 'D7', required: false },
  { key: 'SMTP_USER', phase: 'D7', required: false },
  { key: 'SMTP_PASS', phase: 'D7', required: false, secret: true },
  // The Auth0 Deploy CLI and the portal's session revocation both authenticate as these.
  // Not required to boot — nothing in the request path reads them — but without them the
  // tenants can only be configured by hand, which is how the two Actions drift from
  // infra/auth0/actions/*.js. `pnpm auth0:check` says whether they actually work.
  { key: 'AUTH0_CUSTOMER_M2M_CLIENT_ID', phase: 'D5', required: false },
  { key: 'AUTH0_CUSTOMER_M2M_CLIENT_SECRET', phase: 'D5', required: false, secret: true },
  { key: 'AUTH0_STAFF_M2M_CLIENT_ID', phase: 'D5', required: false },
  { key: 'AUTH0_STAFF_M2M_CLIENT_SECRET', phase: 'D5', required: false, secret: true },
  // D6: one of the two masters must be set for Option C (SIP import). Neither is required
  // to boot — the route answers NOT_CONFIGURED — but staging without KMS is a finding.
  { key: 'SIP_CREDENTIALS_KMS_KEY_ID', phase: 'D6', required: false },
  { key: 'SIP_CREDENTIALS_LOCAL_KEY', phase: 'D6', required: false, secret: true },
  { key: 'OPS_ALERT_WEBHOOK_URL', phase: 'D6', required: false, secret: true },
  // D7: recurring operations. All have defaults; RESEND_API_KEY is what turns the low-balance,
  // rental and digest emails from log lines into deliveries.
  { key: 'RECONCILE_DRIFT_THRESHOLD_PCT', phase: 'D7', required: false },
  { key: 'CONCURRENCY_ALERT_PCT', phase: 'D7', required: false },
  { key: 'CONCURRENCY_PLATFORM_LIMIT', phase: 'D7', required: false },
  { key: 'DIGEST_LOCAL_HOUR', phase: 'D7', required: false },
  // D14: observability and the request budget. Unset = off (or the 600/min default).
  { key: 'SENTRY_DSN', phase: 'D14', required: false },
  { key: 'OTEL_EXPORTER_OTLP_ENDPOINT', phase: 'D14', required: false },
  { key: 'OTEL_EXPORTER_OTLP_HEADERS', phase: 'D14', required: false, secret: true },
  { key: 'API_RATE_LIMIT_PER_MIN', phase: 'D14', required: false },
];

const results = [];
let fatal = 0;

for (const check of CHECKS) {
  const value = process.env[check.key]?.trim();
  if (value) {
    results.push(['ok', check.key, check.secret ? 'set' : summarise(value)]);
  } else if (check.required) {
    fatal += 1;
    results.push(['FAIL', check.key, `required from ${check.phase} — not set`]);
  } else {
    results.push(['--', check.key, `needed by ${check.phase}`]);
  }
}

// APP_ENV is a gate, not a label: the backend reads an unset or unrecognised value as
// prod (backend/api/src/common/env/app-env.ts), which silently disables the dev routes
// and fixture capture. Catch a typo here instead.
const APP_ENVS = ['dev', 'ci', 'staging', 'prod'];
const appEnv = process.env.APP_ENV?.trim();
if (appEnv && !APP_ENVS.includes(appEnv)) {
  fatal += 1;
  results.push(['FAIL', 'APP_ENV', `"${appEnv}" is not one of ${APP_ENVS.join(' | ')}`]);
}

// Retell bakes API_PUBLIC_URL into every agent and number at create time, so a plaintext
// or unreachable callback host is not a runtime problem, it is a stranded-objects problem.
if (process.env.API_PUBLIC_URL?.trim() && appEnv === 'prod' && !/^https:\/\//i.test(process.env.API_PUBLIC_URL.trim())) {
  fatal += 1;
  results.push(['FAIL', 'API_PUBLIC_URL', 'must be https in prod — Retell callbacks are baked in at create time']);
}

// The §13.9 Redis-down policy is a deploy-time switch with exactly two values; a typo in it
// would silently mean "fail open" during the incident it was set for (ADR 0003 §12).
const inboundPolicy = process.env.INBOUND_REDIS_DOWN_POLICY?.trim().toLowerCase();
if (inboundPolicy && !['open', 'closed'].includes(inboundPolicy)) {
  fatal += 1;
  results.push(['FAIL', 'INBOUND_REDIS_DOWN_POLICY', `"${inboundPolicy}" is not open | closed`]);
} else if (inboundPolicy === 'closed') {
  results.push(['ok', 'INBOUND_REDIS_DOWN_POLICY', 'closed — a Redis outage answers busy on every inbound call']);
}

// A recording link signed with a per-process secret does not survive a second API process.
const recordingSecret = process.env.RECORDING_SIGNING_SECRET?.trim();
if (recordingSecret && recordingSecret.length < 32) {
  fatal += 1;
  results.push(['FAIL', 'RECORDING_SIGNING_SECRET', `${recordingSecret.length} characters; needs at least 32`]);
}

// Two Auth0 tenants or the staff boundary is decorative (ADR 0002).
const customer = canonicalIssuer(process.env.AUTH0_CUSTOMER_DOMAIN);
const staff = canonicalIssuer(process.env.AUTH0_STAFF_DOMAIN);
if (customer && staff) {
  if (customer === staff) {
    fatal += 1;
    results.push(['FAIL', 'auth0 tenants', 'customer and staff share one issuer — see ADR 0002']);
  } else {
    results.push(['ok', 'auth0 tenants', 'two distinct issuers']);
  }
}

// An id without a secret is worse than neither: `pnpm auth0:deploy` gets far enough to
// authenticate and then fails on the tenant it half-configured.
for (const tenant of ['CUSTOMER', 'STAFF']) {
  const id = process.env[`AUTH0_${tenant}_M2M_CLIENT_ID`]?.trim();
  const secret = process.env[`AUTH0_${tenant}_M2M_CLIENT_SECRET`]?.trim();
  if (Boolean(id) !== Boolean(secret)) {
    fatal += 1;
    results.push([
      'FAIL',
      `auth0 ${tenant.toLowerCase()} m2m`,
      `${id ? 'secret' : 'client id'} is missing — see docs/runbooks/auth0.md`,
    ]);
  } else if (id) {
    results.push(['ok', `auth0 ${tenant.toLowerCase()} m2m`, 'set — run `pnpm auth0:check` to test the scopes']);
  }
}

for (const [key, label] of [
  ['DATABASE_URL', 'postgres (app role)'],
  ['REDIS_URL', 'redis'],
]) {
  const url = process.env[key];
  if (!url) continue;
  const reachable = await reachable_(url);
  if (reachable) {
    results.push(['ok', label, 'reachable']);
  } else {
    fatal += 1;
    results.push(['FAIL', label, 'not reachable — is `pnpm infra:up` running?']);
  }
}

const width = Math.max(...results.map(([, key]) => key.length));
for (const [status, key, detail] of results) {
  const mark = status === 'ok' ? '✓' : status === 'FAIL' ? '✗' : '·';
  console.log(`${mark} ${key.padEnd(width)}  ${detail}`);
}

console.log(
  fatal === 0
    ? '\nEverything required is in place.'
    : `\n${fatal} problem${fatal === 1 ? '' : 's'}. See docs/runbooks/provisioning.md.`,
);
process.exit(fatal === 0 ? 0 : 1);

// ---------------------------------------------------------------------------

/** Hosts and ports are fine to print; anything with credentials in it is not. */
function summarise(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`;
  } catch {
    return value.length > 40 ? 'set' : value;
  }
}

function canonicalIssuer(domain) {
  if (!domain?.trim()) return undefined;
  return domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

/** A TCP connect, not a query: enough to tell "wrong host" from "wrong password". */
function reachable_(url) {
  let target;
  try {
    target = new URL(url);
  } catch {
    return Promise.resolve(false);
  }
  const port = Number(target.port) || (target.protocol.startsWith('redis') ? 6379 : 5432);

  return new Promise((resolveReachable) => {
    const socket = createConnection({ host: target.hostname, port, timeout: 3000 });
    const finish = (ok) => {
      socket.destroy();
      resolveReachable(ok);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}
