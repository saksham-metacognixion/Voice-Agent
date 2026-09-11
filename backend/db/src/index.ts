import { PrismaClient } from '@prisma/client';

export * from '@prisma/client';

declare global {
  var __portalPrisma: PrismaClient | undefined;
}

/**
 * Single Prisma client per process. Hot-reload safe in dev.
 * Tenant-scoped access (RLS via set_config inside $transaction) is added on D1.
 */
export const prisma: PrismaClient =
  globalThis.__portalPrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalThis.__portalPrisma = prisma;
