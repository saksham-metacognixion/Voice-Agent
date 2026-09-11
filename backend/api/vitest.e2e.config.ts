import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/**/*.e2e.test.ts'], environment: 'node', testTimeout: 30_000 },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
