import { lstatSync } from 'node:fs';
import path from 'node:path';
import { getDataPaths } from '@/lib/data-dir';

let contentRootOverride: string | null = null;

/** Tests only — point subject/PDF/generated I/O at a temp tree. */
export function setOnboardingContentRootForTests(root: string | null): void {
  contentRootOverride = root;
}

/**
 * Family content root for wizard subjects / uploads / BankIR / generated
 * JSON and the live bank: the family data folder, never the checkout.
 * (`.env` stays in the checkout — see `getEnvStoreRoot`.)
 */
export function getOnboardingContentRoot(): string {
  return contentRootOverride ?? getDataPaths().familyRoot;
}

/**
 * `false` when a wizard write (create, rename, delete) to any of `targets`
 * would pass through a symlink below the family root. A `content/subjects`,
 * `content/source-pdfs` or `<subject>` folder (or a file) linked into the
 * checkout would otherwise route the write into tracked files. Every existing
 * component from the root down to each target is lstat-ed, a dangling link
 * included; the root itself was vetted on realpaths by the resolver. Call it
 * immediately before the write; pass both ends of a rename.
 */
export function isFamilyWritePathSafe(root: string, ...targets: string[]): boolean {
  const base = path.resolve(root);
  for (const target of targets) {
    const rel = path.relative(base, path.resolve(target));
    if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      return false;
    }
    let current = base;
    for (const part of rel.split(path.sep)) {
      current = path.join(current, part);
      let isLink: boolean;
      try {
        isLink = lstatSync(current).isSymbolicLink();
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Nothing further exists: the write creates real folders / files.
        if (code === 'ENOENT' || code === 'ENOTDIR') break;
        throw error;
      }
      if (isLink) return false;
    }
  }
  return true;
}
