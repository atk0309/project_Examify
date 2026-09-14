import fs from 'node:fs';
import path from 'node:path';

/** True when `pnpm build` has produced a startable `.next` output. */
export function productionBuildReady(cwd = process.cwd()): boolean {
  return fs.existsSync(path.join(cwd, '.next', 'BUILD_ID'));
}

/**
 * Fail before `next start` if there is no production build. `next start`
 * does not create `.next`; both Playwright suites require one already.
 */
export function requireProductionBuild(cwd = process.cwd()): void {
  if (productionBuildReady(cwd)) return;
  throw new Error(
    'Playwright e2e requires a Next.js production build (.next/BUILD_ID). Run `pnpm build` first, or `pnpm test:e2e` which builds before both suites.',
  );
}
