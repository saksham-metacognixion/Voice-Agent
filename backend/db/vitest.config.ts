import { defineConfig } from 'vitest/config';

/**
 * Unit tests only — nothing here may need a database. The RLS, append-only and boot
 * assertion suites live in test/*.e2e.test.ts and run under vitest.e2e.config.ts.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
