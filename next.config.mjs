/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  pageExtensions: ['ts', 'tsx'],
  poweredByHeader: false,
  serverExternalPackages: ['better-sqlite3'],
};

export default nextConfig;
