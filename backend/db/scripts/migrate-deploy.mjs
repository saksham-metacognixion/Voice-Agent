#!/usr/bin/env node
/**
 * `prisma migrate deploy` inside the backend image (ADR 0034). infra/scripts/deploy.sh runs it
 * as the one-off `migrate` compose service after the pull and before api/worker restart, so a
 * deploy never puts code in front of a schema it does not have.
 *
 * The owner connection is built here, never stored:
 *   DB_OWNER_SECRET   the RDS-managed master secret (`{"username","password"}`), read from
 *                     Secrets Manager by deploy.sh on every run — it rotates every 7 days, so a
 *                     copy in SSM goes stale within the week. Host, port, database and query
 *                     come from ADMIN_DATABASE_URL (else DATABASE_URL): the same instance.
 *   DIRECT_DATABASE_URL  used as is when there is no secret (a database whose owner password
 *                     does not rotate).
 * Nothing prints the URL; Prisma names only the host and database.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function ownerUrl() {
  const secret = process.env.DB_OWNER_SECRET;
  if (secret) {
    let parsed;
    try {
      parsed = JSON.parse(secret);
    } catch {
      throw new Error('DB_OWNER_SECRET is not JSON');
    }
    const { username, password } = parsed ?? {};
    if (!username || !password) throw new Error('DB_OWNER_SECRET has no username/password');
    const base = process.env.ADMIN_DATABASE_URL || process.env.DATABASE_URL;
    if (!base) throw new Error('ADMIN_DATABASE_URL / DATABASE_URL is unset: no host to migrate');
    const url = new URL(base);
    // The setters leave `%` alone, so encode first: a generated password may contain one.
    url.username = encodeURIComponent(username);
    url.password = encodeURIComponent(password);
    return url.toString();
  }
  if (process.env.DIRECT_DATABASE_URL) return process.env.DIRECT_DATABASE_URL;
  throw new Error('neither DB_OWNER_SECRET nor DIRECT_DATABASE_URL is set');
}

let url;
try {
  url = ownerUrl();
} catch (error) {
  console.error(`!! migrate: ${error.message}`);
  process.exit(1);
}

const cli = join(here, 'node_modules', 'prisma', 'build', 'index.js');
const schema = join(here, 'prisma', 'schema.prisma');
const run = spawnSync(process.execPath, [cli, 'migrate', 'deploy', '--schema', schema], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: url, DIRECT_DATABASE_URL: url, DB_OWNER_SECRET: '' },
});
process.exit(run.status ?? 1);
