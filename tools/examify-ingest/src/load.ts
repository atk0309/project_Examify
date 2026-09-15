import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export type LoadedIrFile = { path: string; data: unknown };

/** Resolve a subjects directory (each child folder's bank.ir.json) or explicit IR file paths. */
export function resolveIrFiles(inputs: readonly string[], cwd: string): string[] {
  const resolved: string[] = [];
  const seen = new Set<string>();

  for (const input of inputs) {
    const abs = path.resolve(cwd, input);
    let stats;
    try {
      stats = statSync(abs);
    } catch {
      throw new Error(`path not found: ${input}`);
    }

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
        } catch {
          // skip subject dirs without a bank.ir.json
        }
      }
      if (found === 0) {
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

export function findRepoRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        name?: string;
      };
      if (pkg.name === 'project-examify') return dir;
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
