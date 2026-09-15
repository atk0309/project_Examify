import { readdirSync, readFileSync, statSync, type Stats } from 'node:fs';
import path from 'node:path';

export type LoadedIrFile = { path: string; data: unknown };

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function statOrThrow(absPath: string, label: string): Stats {
  try {
    return statSync(absPath);
  } catch (error) {
    if (isEnoent(error)) throw new Error(`path not found: ${label}`);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot stat ${label}: ${message}`, { cause: error });
  }
}

export type ResolveIrOptions = {
  /**
   * When true, a subjects directory with no child `bank.ir.json` files
   * contributes no paths instead of throwing. Authoritative emit uses this
   * so it can refuse an empty catalog with a clear error instead of treating
   * it as a generic resolve failure.
   */
  allowEmptyDirectory?: boolean;
};

/** Resolve a subjects directory (each child folder's bank.ir.json) or explicit IR file paths. */
export function resolveIrFiles(
  inputs: readonly string[],
  cwd: string,
  options: ResolveIrOptions = {},
): string[] {
  const resolved: string[] = [];
  const seen = new Set<string>();

  for (const input of inputs) {
    const abs = path.resolve(cwd, input);
    const stats = statOrThrow(abs, input);

    if (stats.isDirectory()) {
      const entries = readdirSync(abs, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
      let found = 0;
      for (const name of entries) {
        const candidate = path.join(abs, name, 'bank.ir.json');
        try {
          if (statSync(candidate).isFile()) {
            if (!seen.has(candidate)) {
              resolved.push(candidate);
              seen.add(candidate);
            }
            found += 1;
          }
        } catch (error) {
          if (isEnoent(error)) continue;
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`cannot stat ${candidate}: ${message}`, { cause: error });
        }
      }
      if (found === 0) {
        if (options.allowEmptyDirectory) continue;
        throw new Error(`no */bank.ir.json files under ${input}`);
      }
      continue;
    }

    if (!stats.isFile()) {
      throw new Error(`not a file or directory: ${input}`);
    }
    if (!seen.has(abs)) {
      resolved.push(abs);
      seen.add(abs);
    }
  }

  return resolved;
}

/**
 * True only when every emit input is a subjects directory (typically
 * `content/subjects`). That run is the authoritative generated catalog and
 * leftover subject JSON may be pruned. Any explicit IR file path — including
 * mixed file+directory argv — stays partial and never deletes siblings.
 */
export function isAuthoritativeCatalogInput(inputs: readonly string[], cwd: string): boolean {
  if (inputs.length === 0) return false;
  for (const input of inputs) {
    const abs = path.resolve(cwd, input);
    try {
      if (!statSync(abs).isDirectory()) return false;
    } catch (error) {
      if (isEnoent(error)) return false;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`cannot stat ${input}: ${message}`, { cause: error });
    }
  }
  return true;
}

export function loadIrFiles(paths: readonly string[]): LoadedIrFile[] {
  return paths.map((filePath) => {
    const raw = readFileSync(filePath, 'utf8');
    try {
      return { path: filePath, data: JSON.parse(raw) as unknown };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`invalid JSON in ${filePath}: ${message}`);
    }
  });
}

export { findRepoRoot } from '../../../src/lib/repo-root';
