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
    /**
     * Never a real email from a test. `load-env` copies the developer's `.env`, and a dev box
     * with SMTP or Resend set would mail every `@example.test` invitee and low-balance owner
     * — and the suites read what was "sent" off the log sender. Set here (empty), so
     * `load-env`, which never overrides a defined key, leaves them unset.
     */
    env: { RESEND_API_KEY: '', SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '' },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    /**
     * One file at a time. Every suite here shares one Postgres, one Redis and — the part
     * that actually bites — the *global* configuration tables: `pricing_configs`,
     * `kill_switches`, `feature_flags` and the `flags:*` cache in front of them. A suite
     * that flips `pause_generation` invalidates the cache another suite is in the middle
     * of asserting on, and the result is a failure that appears once in ten runs and
     * cannot be reproduced on its own.
     *
     * Workspace-scoped data is isolated by construction (every fixture makes its own
     * workspace), so this is only about the global rows. The cost is wall clock; the
     * alternative is a suite nobody trusts.
     */
    fileParallelism: false,
  },
  // Nest decorators need emitDecoratorMetadata; SWC handles that where esbuild cannot.
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
