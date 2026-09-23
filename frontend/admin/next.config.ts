import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /**
   * The dev server gets its own build directory, for the reason written out in the
   * portal's config: `next dev` and `next build` cannot share `.next` without the running
   * server losing the manifests it holds open. `pnpm dev` sets `NEXT_DIST_DIR=.next-dev`;
   * builds and CI keep writing `.next`.
   */
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  reactStrictMode: true,
  transpilePackages: ['@portal/ui', '@portal/api-client', '@portal/schemas'],
  poweredByHeader: false,
};

export default nextConfig;
