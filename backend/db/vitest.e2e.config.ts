import { defineConfig } from 'vitest/config';

/**
 * These tests need a real Postgres with the migrations applied — RLS and the
 * append-only triggers cannot be exercised against a mock.
 *
 *   pnpm infra:up && pnpm db:roles && pnpm db:deploy
 *   pnpm --filter @portal/db test:e2e
 */
export default defineConfig({
  test: {
    include: ['test/**/*.e2e.test.ts'],
    environment: 'node',
    setupFiles: ['@portal/config/vitest/load-env'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // One Postgres, shared fixtures: parallel files would fight over the same rows.
    fileParallelism: false,
  },
});
