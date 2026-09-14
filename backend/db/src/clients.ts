import { PrismaClient } from '@prisma/client';

/**
 * Two connections, two roles (§17, ADR 0006).
 *
 *   appDb    connects as a portal_app member. Row Level Security applies, so every
 *            query sees an empty database until app.tenant_id is set. Reach it through
 *            withWorkspace(), never directly.
 *   adminDb  connects as a portal_admin member. Crosses workspaces on purpose: webhook
 *            processing (the workspace is only known after the payload is parsed),
 *            scheduled jobs, workspace creation and every /admin/* route.
 *
 * Both are subject to the append-only triggers on credit_ledger, audit_log and
 * staff_audit_log. Neither can rewrite history.
 *
 * Both are lazy. Importing this package must not need a database — a unit test that
 * happens to pull in a guard should not have to invent a DATABASE_URL.
 */

declare global {
  // Hot reload in dev would otherwise open a new pool on every recompile.
  var __portalAppDb: PrismaClient | undefined;
  var __portalAdminDb: PrismaClient | undefined;
}

function connect(envVar: 'DATABASE_URL' | 'ADMIN_DATABASE_URL'): PrismaClient {
  const url =
    envVar === 'ADMIN_DATABASE_URL'
      ? (process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL)
      : process.env.DATABASE_URL;

  if (!url) {
    throw new Error(
      `${envVar} is not set. Copy .env.example to .env; see the database section for the two roles.`,
    );
  }

  return new PrismaClient({
    datasources: { db: { url } },
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
}

/**
 * Defers construction to the first property access, then reuses one client. The proxy
 * is transparent: appDb.user.findMany() behaves exactly as PrismaClient does.
 */
const opened: PrismaClient[] = [];

function lazyClient(
  envVar: 'DATABASE_URL' | 'ADMIN_DATABASE_URL',
  cacheKey: '__portalAppDb' | '__portalAdminDb',
): PrismaClient {
  const resolve = (): PrismaClient => {
    let client = globalThis[cacheKey];
    if (!client) {
      client = connect(envVar);
      opened.push(client);
      globalThis[cacheKey] = client;
    }
    return client;
  };

  return new Proxy({} as PrismaClient, {
    get(_target, property) {
      const client = resolve();
      const value = Reflect.get(client, property, client) as unknown;
      return typeof value === 'function' ? value.bind(client) : value;
    },
    has: (_target, property) => property in resolve(),
  });
}

export const appDb: PrismaClient = lazyClient('DATABASE_URL', '__portalAppDb');
export const adminDb: PrismaClient = lazyClient('ADMIN_DATABASE_URL', '__portalAdminDb');

/** Only disconnects clients that were actually opened. */
export async function disconnect(): Promise<void> {
  await Promise.all(opened.splice(0).map((client) => client.$disconnect()));
}
