import { readFileSync } from 'node:fs';
import path from 'node:path';

/** `package.json` name that marks the Examify checkout. */
export const EXAMIFY_PACKAGE_NAME = 'project-examify';

/**
 * Walk `startDir` and its parents until `package.json` name is `project-examify`.
 * Shared by env-store writes, onboarding content I/O, and examify-ingest
 * generate key loading so a cwd inside the tree still hits the same `.env`.
 * Throws if no checkout is found (fail closed — never write a stray `.env`).
 */
export function findRepoRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        name?: string;
      };
      if (pkg.name === EXAMIFY_PACKAGE_NAME) return dir;
    } catch {
      // keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error('could not find the Examify repo root (package.json name project-examify)');
    }
    dir = parent;
  }
}
