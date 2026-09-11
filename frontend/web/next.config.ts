import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@portal/ui', '@portal/api-client', '@portal/schemas'],
  poweredByHeader: false,
};

export default nextConfig;
