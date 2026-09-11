import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    environment: 'node',
    globals: false,
  },
  plugins: [
    // Nest decorators need emitDecoratorMetadata; SWC handles that where esbuild cannot.
    swc.vite({ module: { type: 'es6' } }),
  ],
});
