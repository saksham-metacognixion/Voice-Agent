#!/usr/bin/env node
/**
 * Auth0 tenant configuration, versioned instead of clicked in (ADR 0002).
 *
 *   pnpm auth0:validate                      parse both tenant files — no credentials needed
 *   pnpm auth0:check  [customer|staff|all]   credentials and scopes, before anything is changed
 *   pnpm auth0:export <customer|staff>       pull the live tenant into infra/auth0/export/<tenant>/
 *   pnpm auth0:plan   <customer|staff>       what a deploy would change, applying nothing
 *   pnpm auth0:deploy <customer|staff>       apply infra/auth0/tenant.<tenant>.yaml
 *
 * Always in that order the first time: the deploy CLI matches objects by NAME, so a
 * tenant.yaml written against the wrong names does not fail — it quietly creates a second
 * application, and the client_id in .env stops being the one people log in to. Export
 * first, diff, then plan.
 *
 * Three things this wrapper exists to do, none of which a raw `a0deploy` invocation does:
 *
 *  1. Point the CLI at the right tenant. It authenticates with AUTH0_DOMAIN /
 *     AUTH0_CLIENT_ID / AUTH0_CLIENT_SECRET, and those names are already taken in our .env
 *     by the customer SPA (a public client with no secret, ADR 0008). Running a0deploy
 *     with our environment inherited would try to deploy as the browser app. Worse,
 *     a0deploy reads AUTH0_AUDIENCE as the Management API audience and ours is the portal
 *     API — the token would come back for the wrong API and every call would 401.
 *     Everything it reads is overridden explicitly below.
 *  2. Substitute ##KEYWORD## from .env and refuse to continue while one is unresolved. An
 *     empty callback URL or an empty action secret deploys perfectly happily and breaks
 *     login an hour later. ##KEYWORD?## is the optional form: unset, its line is dropped.
 *  3. Keep the rendered file — which carries AUTH0_CUSTOMER_ACTION_SECRET — in a 0700
 *     temporary directory that is deleted on the way out, rather than next to the source.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  rmSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './lib/env.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const auth0Dir = join(root, 'infra/auth0');
loadEnvFile(join(root, '.env'));

/** Which .env keys hold each tenant's deploy credentials. */
const TENANTS = {
  customer: {
    domain: 'AUTH0_CUSTOMER_DOMAIN',
    clientId: 'AUTH0_CUSTOMER_M2M_CLIENT_ID',
    clientSecret: 'AUTH0_CUSTOMER_M2M_CLIENT_SECRET',
  },
  staff: {
    domain: 'AUTH0_STAFF_DOMAIN',
    clientId: 'AUTH0_STAFF_M2M_CLIENT_ID',
    clientSecret: 'AUTH0_STAFF_M2M_CLIENT_SECRET',
  },
};

/**
 * What the M2M application must be able to do. Split because they are granted for two
 * different reasons and a missing one fails in two different places: the deploy scopes
 * make `pnpm auth0:deploy` work, the runtime scopes are what the portal itself needs for
 * session revocation and what `verify:auth0` needs to create and delete its probe user.
 */
const DEPLOY_SCOPES = [
  'read:tenant_settings',
  'update:tenant_settings',
  'read:clients',
  'create:clients',
  'update:clients',
  'read:client_keys',
  'read:resource_servers',
  'create:resource_servers',
  'update:resource_servers',
  'read:connections',
  'create:connections',
  'update:connections',
  'read:actions',
  'create:actions',
  'update:actions',
  'read:attack_protection',
  'update:attack_protection',
];
const STAFF_ONLY_SCOPES = [
  'read:guardian_factors',
  'update:guardian_factors',
  'read:mfa_policies',
  'update:mfa_policies',
];
const RUNTIME_SCOPES = ['read:users', 'create:users', 'update:users', 'delete:users'];

const [command, tenantArg] = process.argv.slice(2);

try {
  switch (command) {
    case 'validate':
      validate();
      break;
    case 'check':
      await check(
        tenantArg === 'all' || !tenantArg ? Object.keys(TENANTS) : [tenantName(tenantArg)],
      );
      break;
    case 'export':
      await exportTenant(tenantName(tenantArg));
      break;
    case 'plan':
      await deploy(tenantName(tenantArg), { dryRun: true });
      break;
    case 'deploy':
      await deploy(tenantName(tenantArg), { dryRun: false });
      break;
    default:
      usage();
  }
} catch (error) {
  console.error(`\n✗ ${error.message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------

function usage() {
  console.error(
    [
      'Usage:',
      '  pnpm auth0:validate',
      '  pnpm auth0:check  [customer|staff|all]',
      '  pnpm auth0:export <customer|staff>',
      '  pnpm auth0:plan   <customer|staff>',
      '  pnpm auth0:deploy <customer|staff>',
      '',
      'See docs/runbooks/auth0.md.',
    ].join('\n'),
  );
  process.exit(1);
}

function tenantName(value) {
  if (!value || !TENANTS[value]) usage();
  return value;
}

/** Reads a tenant's three credentials, saying which .env key is missing rather than "unauthorized". */
function credentials(tenant) {
  const keys = TENANTS[tenant];
  const missing = Object.values(keys).filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `${tenant} tenant: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set in .env.\n` +
        '  Create the M2M application first — docs/runbooks/auth0.md §1.',
    );
  }
  const domain = process.env[keys.domain]
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  return {
    domain,
    clientId: process.env[keys.clientId].trim(),
    clientSecret: process.env[keys.clientSecret].trim(),
  };
}

/**
 * A client-credentials grant and a look at what came back. Run before a deploy, it turns
 * the two failures that look identical from the CLI — wrong tenant, missing scope — into
 * two different sentences.
 */
async function check(tenants) {
  let failures = 0;

  const customer = process.env.AUTH0_CUSTOMER_DOMAIN?.trim().toLowerCase();
  const staff = process.env.AUTH0_STAFF_DOMAIN?.trim().toLowerCase();
  if (customer && staff && customer === staff) {
    failures += 1;
    console.log('✗ tenants          customer and staff share one domain — see ADR 0002');
  }

  for (const tenant of tenants) {
    let creds;
    try {
      creds = credentials(tenant);
    } catch (error) {
      failures += 1;
      console.log(`✗ ${tenant.padEnd(16)} ${error.message.split('\n')[0]}`);
      continue;
    }

    const audience = `https://${creds.domain}/api/v2/`;
    const response = await fetch(`https://${creds.domain}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        audience,
      }),
    });
    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      failures += 1;
      // access_denied on the Management API audience nearly always means the M2M app
      // exists but was never authorised for it, which reads as a credentials error.
      console.log(
        `✗ ${tenant.padEnd(16)} ${creds.domain} refused the client credentials: ${body.error ?? response.status} ${body.error_description ?? ''}`,
      );
      continue;
    }

    const granted = new Set((body.scope ?? '').split(' ').filter(Boolean));
    const wanted = [
      ...DEPLOY_SCOPES,
      ...(tenant === 'staff' ? STAFF_ONLY_SCOPES : []),
      ...RUNTIME_SCOPES,
    ];
    const missing = wanted.filter((scope) => !granted.has(scope));

    if (missing.length > 0) {
      failures += 1;
      console.log(
        `✗ ${tenant.padEnd(16)} authenticated, but ${missing.length} scope(s) are not granted:`,
      );
      for (const scope of missing) console.log(`                   ${scope}`);
    } else {
      console.log(
        `✓ ${tenant.padEnd(16)} ${creds.domain} — ${granted.size} scopes, all required ones present`,
      );
    }
  }

  console.log(
    failures === 0
      ? '\nBoth tenants are deployable.'
      : `\n${failures} problem(s). See docs/runbooks/auth0.md.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

/**
 * Everything that can be wrong with the tenant files without asking Auth0: an unresolved
 * keyword, an action whose source file moved, and — the one that costs a day, because a
 * deploy reports success — an action that is never bound to a trigger and so never runs.
 *
 * No credentials, so this is the part of `auth0:plan` that works on a fresh clone.
 */
function validate() {
  const yaml = (() => {
    try {
      // realpath first: pnpm links the package in but keeps its dependencies beside the
      // real directory, and createRequire resolves from the path it is handed.
      return createRequire(realpathSync(join(root, 'node_modules/auth0-deploy-cli/package.json')))(
        'js-yaml',
      );
    } catch {
      throw new Error('auth0-deploy-cli is not installed. Run `pnpm install`.');
    }
  })();

  let failures = 0;
  for (const tenant of Object.keys(TENANTS)) {
    const source = join(auth0Dir, `tenant.${tenant}.yaml`);
    const doc = yaml.load(render(readFileSync(source, 'utf8'), source));
    const before = failures;

    const bound = new Set(
      Object.values(doc.triggers ?? {})
        .flat()
        .map((binding) => binding.action_name),
    );
    for (const action of doc.actions ?? []) {
      const codePath = join(auth0Dir, action.code);
      if (!existsSync(codePath)) {
        failures += 1;
        console.log(`✗ ${tenant}: ${action.name} points at ${action.code}, which does not exist`);
      }
      if (!bound.has(action.name)) {
        failures += 1;
        console.log(
          `✗ ${tenant}: ${action.name} is deployed but bound to no trigger — it would never run`,
        );
      }
      for (const secret of action.secrets ?? []) {
        if (!secret.value) {
          failures += 1;
          console.log(`✗ ${tenant}: ${action.name} secret ${secret.name} is empty`);
        }
      }
    }
    for (const name of bound) {
      if (!(doc.actions ?? []).some((action) => action.name === name)) {
        failures += 1;
        console.log(`✗ ${tenant}: trigger binding names ${name}, which this file does not define`);
      }
    }
    // A client with no callback URL deploys happily and answers every login attempt with
    // "Callback URL mismatch", which says nothing about which URL it wanted. Print the
    // list that would be sent, so the answer is on screen before the deploy.
    for (const client of doc.clients ?? []) {
      if ((client.callbacks ?? []).length === 0) {
        failures += 1;
        console.log(`✗ ${tenant}: client "${client.name}" would be deployed with no callback URL`);
      }
    }

    if (failures === before) {
      const names = (doc.actions ?? []).map((action) => action.name).join(', ');
      console.log(
        `✓ tenant.${tenant}.yaml — ${(doc.clients ?? []).length} client(s), ${(doc.resourceServers ?? []).length} API(s), actions bound: ${names}`,
      );
      for (const client of doc.clients ?? []) {
        console.log(`  ${client.name} accepts: ${(client.callbacks ?? []).join('  ')}`);
      }
    }
  }

  console.log(
    failures === 0 ? '\nBoth tenant files render and hang together.' : `\n${failures} problem(s).`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

async function exportTenant(tenant) {
  const creds = credentials(tenant);
  const out = join(auth0Dir, 'export', tenant);
  mkdirSync(out, { recursive: true });
  console.log(
    `Exporting ${creds.domain} → infra/auth0/export/${tenant}/ (gitignored — for diffing, not for deploying)`,
  );
  await a0deploy(['export', '--format', 'yaml', '--output_folder', out], creds);
  console.log(
    `\nDiff it against the source of truth:\n  diff infra/auth0/tenant.${tenant}.yaml ${join('infra/auth0/export', tenant, 'tenant.yaml')}`,
  );
}

async function deploy(tenant, { dryRun }) {
  const creds = credentials(tenant);
  const source = join(auth0Dir, `tenant.${tenant}.yaml`);
  if (!existsSync(source)) throw new Error(`${source} does not exist.`);

  const staging = mkdtempSync(join(tmpdir(), 'a0-')); // mkdtemp creates it 0700
  try {
    const rendered = render(readFileSync(source, 'utf8'), source);
    writeFileSync(join(staging, 'tenant.yaml'), rendered, { mode: 0o600 });

    // The CLI resolves an action's `code:` path relative to the input file and refuses to
    // leave that directory, so the sources travel with it.
    const actions = join(staging, 'actions');
    mkdirSync(actions, { mode: 0o700 });
    for (const file of readdirSync(join(auth0Dir, 'actions'))) {
      copyFileSync(join(auth0Dir, 'actions', file), join(actions, file));
    }

    console.log(
      `${dryRun ? 'Planning' : 'Deploying'} infra/auth0/tenant.${tenant}.yaml → ${creds.domain}`,
    );
    await a0deploy(
      ['import', '--input_file', join(staging, 'tenant.yaml'), ...(dryRun ? ['--dry-run'] : [])],
      creds,
    );
    if (dryRun)
      console.log('\nNothing was changed. `pnpm auth0:deploy ' + tenant + '` applies it.');
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * ##KEY## → process.env.KEY. An unresolved keyword stops the deploy; it never becomes ''.
 *
 * ##KEY?## is the optional form, and it exists for one situation: a URL list that has a
 * second entry in some environments and not others. A tenant serves more than one origin
 * — a developer on localhost while staging is deployed against the same tenant — and a
 * list that can hold only one of them means deploying for staging silently locks every
 * developer out of login. When the variable is unset the whole LINE is dropped, so a YAML
 * list item disappears rather than becoming an empty string that Auth0 would reject.
 */
function render(contents, source) {
  const missing = new Set();
  const withoutOptional = contents
    .split('\n')
    .filter((line) => {
      const optional = line.match(/##([A-Z0-9_]+)\?##/g);
      if (!optional) return true;
      return optional.every((token) => {
        const key = token.slice(2, -3);
        return Boolean(process.env[key]?.trim());
      });
    })
    .join('\n');

  const rendered = withoutOptional
    .replace(/##([A-Z0-9_]+)\?##/g, (_, key) => process.env[key].trim())
    .replace(/##([A-Z0-9_]+)##/g, (_, key) => {
      const value = process.env[key]?.trim();
      if (!value) {
        missing.add(key);
        return '';
      }
      return value;
    });

  if (missing.size > 0) {
    throw new Error(
      `${source} needs these, and .env does not set them: ${[...missing].join(', ')}`,
    );
  }
  return rendered;
}

/**
 * Runs the CLI with an environment built from scratch rather than inherited: a0deploy
 * reads AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET and AUTH0_AUDIENCE straight out
 * of the environment, and all four mean something else in ours.
 */
function a0deploy(args, creds) {
  const bin = join(root, 'node_modules/.bin/a0deploy');
  if (!existsSync(bin)) throw new Error('auth0-deploy-cli is not installed. Run `pnpm install`.');

  const child = spawn(bin, args, {
    stdio: 'inherit',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? '',
      AUTH0_DOMAIN: creds.domain,
      AUTH0_CLIENT_ID: creds.clientId,
      AUTH0_CLIENT_SECRET: creds.clientSecret,
      AUTH0_AUDIENCE: `https://${creds.domain}/api/v2/`,
      // Nothing in this repo deletes an Auth0 object. Removing a client or a connection is
      // a decision someone makes in the dashboard, not a side effect of deleting a block.
      AUTH0_ALLOW_DELETE: 'false',
    },
  });

  return new Promise((resolvePromise, reject) => {
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`a0deploy exited with ${code}`)),
    );
  });
}
