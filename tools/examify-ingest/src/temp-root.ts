import { realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findRepoRoot } from '../../../src/lib/repo-root';

/**
 * Whether `target` is inside an Examify checkout, judged on the realpath of
 * `target` (or, when it does not exist yet, of its nearest existing parent),
 * so a symlink cannot route around it.
 */
export function insideExamifyCheckout(target: string): boolean {
  let dir = path.resolve(target);
  for (;;) {
    try {
      dir = realpathSync(dir);
      break;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  try {
    findRepoRoot(dir);
    return true;
  } catch {
    return false;
  }
}

/** The system temp folder, then `/tmp` on POSIX. */
export function safeTempCandidates(): string[] {
  return process.platform === 'win32' ? [os.tmpdir()] : [os.tmpdir(), '/tmp'];
}

/**
 * Where generate's scratch folders go (agent CLI runs, PDF page rasters): the
 * first candidate that is a real folder outside every Examify checkout, judged
 * on its realpath. A `TMPDIR` pointing into the checkout would otherwise put
 * study pages, images and model output there (and Claude Code would load the
 * checkout's CLAUDE.md and settings from the parent folders). None usable →
 * refuse, so nothing is written.
 */
export function safeTempRoot(candidates = safeTempCandidates()): string {
  for (const candidate of candidates) {
    let real: string;
    try {
      real = realpathSync(candidate);
      if (!statSync(real).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!insideExamifyCheckout(real)) return real;
  }
  throw new Error(
    'the temporary folder (TMPDIR) is inside the Examify checkout; point TMPDIR outside it',
  );
}
