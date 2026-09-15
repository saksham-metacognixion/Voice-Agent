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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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
  { key: 'ANTHROPIC_API_KEY', phase: 'D2', required: false, secret: true },
  { key: 'STRIPE_SECRET_KEY', phase: 'D3', required: true, secret: true },
  { key: 'STRIPE_WEBHOOK_SECRET', phase: 'D3', required: true, secret: true },
  { key: 'PORTAL_URL', phase: 'D3', required: true },
  { key: 'RESEND_API_KEY', phase: 'D5', required: false, secret: true },
  { key: 'SIP_CREDENTIALS_KMS_KEY_ID', phase: 'D8', required: false },
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

function loadEnvFile(path) {
  let contents;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    return; // Deployed environments inject real environment variables instead.
  }
  for (const line of contents.split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    if (process.env[key] !== undefined) continue;
    // dotenv's rules for an unquoted value: everything up to an unquoted '#'. A value
    // that is nothing but a comment — how .env.example documents an unset key — is empty.
    const quoted = /^\s*(['"`])([\s\S]*?)\1\s*$/.exec(raw);
    process.env[key] = quoted ? quoted[2] : raw.split('#')[0].trim();
  }
}

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
