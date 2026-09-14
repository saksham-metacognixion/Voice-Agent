import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Auth boundary tests. They stand up a real Nest app against a real Postgres, so they
 * need the database running and the migrations applied:
 *
 *   pnpm infra:up && pnpm db:roles && pnpm db:deploy && pnpm db:seed
 *   pnpm --filter @portal/api test:e2e
 */
export default defineConfig({
  test: {
    include: ['test/**/*.e2e.test.ts'],
    environment: 'node',
    setupFiles: ['@portal/config/vitest/load-env'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  // Nest decorators need emitDecoratorMetadata; SWC handles that where esbuild cannot.
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
