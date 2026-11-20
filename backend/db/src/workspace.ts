import type { Prisma, PrismaClient } from '@prisma/client';
import { appDb } from './clients.js';

/** A Prisma client scoped to one workspace. Same surface as PrismaClient minus $transaction. */
export type WorkspaceDb = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/** The §6.2 request context, or just a workspace id for jobs that have no user. */
export type WorkspaceScope = string | { workspaceId: string; userId?: string };

export interface WithWorkspaceOptions {
  /**
   * Overall transaction budget. Deliberately tight: an interactive transaction pins a
   * pooled connection for its whole duration, and appDb's pool is `num_cpus × 2 + 1`
   * (5 on a 2-vCPU box). A callback that awaits an LLM or a Retell round trip therefore
   * exhausts the pool at a handful of concurrent users, long before CPU matters.
   * A job that genuinely needs longer passes its own timeout, which makes it visible.
   */
  timeout?: number;
  maxWait?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
}

/**
 * Runs `fn` with Postgres scoped to one workspace.
 *
 * Sets `app.tenant_id` — and `app.user_id` when a user is known — as transaction-local
 * GUCs, which is what the RLS policies read. `is_local = true` matters: the settings die
 * with the transaction, so a pooled connection can never hand workspace A's context to
 * workspace B's next request.
 *
 * Everything on the customer request path goes through here. A query that escapes it runs
 * with no tenant set and correctly sees nothing at all.
 *
 *     await withWorkspace(ctx, (db) => db.agent.findMany());
 *     await withWorkspace(workspaceId, (db) => db.call.count());   // jobs, no user
 */
export async function withWorkspace<T>(
  scope: WorkspaceScope,
  fn: (db: WorkspaceDb) => Promise<T>,
  options: WithWorkspaceOptions = {},
): Promise<T> {
  const workspaceId = typeof scope === 'string' ? scope : scope.workspaceId;
  const userId = typeof scope === 'string' ? undefined : scope.userId;

  // set_config takes text, so a malformed id would otherwise reach the cast inside
  // app.current_tenant_id() and fail there with a much less obvious message.
  assertUuid(workspaceId, 'workspace id');
  if (userId !== undefined) assertUuid(userId, 'user id');

  return appDb.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${workspaceId}, true)`;
      if (userId) {
        await tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`;
      }
      return fn(tx as unknown as WorkspaceDb);
    },
    { timeout: 5_000, maxWait: 5_000, ...options },
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, what: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`withWorkspace: "${value}" is not a ${what}`);
  }
}
