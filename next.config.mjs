import path from 'node:path';
import { fileURLToPath } from 'node:url';

const portable = process.env.EXAMIFY_PORTABLE_BUILD === '1';
const projectRoot = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  // The desktop builder alone selects this mode. Hosted/default builds keep
  // Next's normal image optimizer and tracing behavior.
  ...(portable
    ? {
        images: { unoptimized: true },
        outputFileTracingExcludes: {
          '**/*': [
            'node_modules/sharp/**/*',
            'node_modules/@img/**/*',
            'node_modules/.pnpm/sharp@*/**/*',
            'node_modules/.pnpm/@img+*/**/*',
          ],
        },
      }
    : {}),
  outputFileTracingIncludes: {
    '/*': ['node_modules/better-sqlite3/**/*'],
  },
  pageExtensions: ['ts', 'tsx'],
  poweredByHeader: false,
  serverExternalPackages: ['better-sqlite3'],
  experimental: {
    serverActions: {
      // Above MAX_SOURCE_PDF_BYTES (8 MiB) so multipart headers + subjectId
      // still fit and attachSourcePdf can return the typed `too_large` result.
      bodySizeLimit: 10 * 1024 * 1024,
    },
  },
  // Keep Turbopack resolution and output tracing anchored to this checkout.
  // Without explicit roots, a lockfile in a parent directory can make Next
  // infer that parent as the workspace and trace unrelated files.
  turbopack: { root: projectRoot },
  outputFileTracingRoot: projectRoot,
};

export default nextConfig;
