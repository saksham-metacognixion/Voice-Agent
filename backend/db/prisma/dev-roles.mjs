#!/usr/bin/env node
/**
 * Local and CI only:  pnpm db:roles
 *
 * The migration creates portal_app and portal_admin as NOLOGIN group roles. Here we give
 * them a password and log in as them directly, so `pnpm dev` and the e2e tests run against
 * the same RLS path production does rather than as the schema owner.
 *
 * staging / prod do NOT run this. There you create a separate login role in the Neon
 * console and `GRANT portal_app TO <that role>`; its password belongs in SSM.
 * See docs/runbooks/provisioning.md and ADR 0006.
 */
import { PrismaClient } from '@prisma/client';

if (process.env.NODE_ENV === 'production' || process.env.APP_ENV === 'prod') {
  console.error('Refusing to set well-known role passwords in production.');
  process.exit(1);
}

const url = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('DIRECT_DATABASE_URL is not set. Copy .env.example to .env.');
  process.exit(1);
}

// Passwords match the local URLs in .env.example and never leave docker-compose / CI.
const STATEMENTS = [
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portal_app')   THEN CREATE ROLE portal_app NOLOGIN;   END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portal_admin') THEN CREATE ROLE portal_admin NOLOGIN; END IF;
   END $$`,
  `ALTER ROLE portal_app   LOGIN PASSWORD 'portal_app'`,
  `ALTER ROLE portal_admin LOGIN PASSWORD 'portal_admin'`,
];

const db = new PrismaClient({ datasources: { db: { url } } });

try {
  for (const statement of STATEMENTS) {
    await db.$executeRawUnsafe(statement);
  }
  console.log('portal_app and portal_admin can now log in locally.');
} catch (error) {
  console.error(`Could not create the dev roles: ${error.message}`);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
