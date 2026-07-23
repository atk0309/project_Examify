import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  pageExtensions: ['ts', 'tsx'],
  poweredByHeader: false,
  serverExternalPackages: ['better-sqlite3'],
  // Keep Turbopack resolution and output tracing anchored to this checkout.
  // Without explicit roots, a lockfile in a parent directory can make Next
  // infer that parent as the workspace and trace unrelated files.
  turbopack: { root: projectRoot },
  outputFileTracingRoot: projectRoot,
};

export default nextConfig;
