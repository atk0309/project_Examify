import path from 'node:path';
import { parseEnvFile, readEnvFile } from '../env-file';
import { findRepoRoot } from '../repo-root';

export { parseEnvFile };

const ENV_FILES = ['.env', '.env.local'] as const;
const DEFAULT_DATABASE_URL = 'file:./data/app.db';

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

function resolveSqlitePath(url: string, repoRoot: string): string {
  const raw = url.startsWith('file:') ? url.slice('file:'.length) : url;
  return path.isAbsolute(raw) ? raw : path.resolve(repoRoot, raw);
}

export type MigrateConfig = {
  repoRoot: string;
  databaseUrl: string;
  dbPath: string;
  migrationsFolder: string;
};

/**
 * Resolve the SQLite file `pnpm db:migrate` should open.
 *
 * Next loads repo-root `.env` / `.env.local`; this uses the same
 * `findRepoRoot` walk so a cwd inside the tree (or a bare `pnpm db:migrate`
 * with no exported `DATABASE_URL`) still hits the file the app will open.
 * A non-empty `env.DATABASE_URL` wins (host-injected).
 */
export function resolveMigrateConfig(
  cwd = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): MigrateConfig {
  const repoRoot = findRepoRoot(cwd);
  const fromFiles: Record<string, string> = {};
  for (const name of ENV_FILES) {
    Object.assign(fromFiles, readEnvFile(path.join(repoRoot, name)));
  }
  const databaseUrl =
    firstNonEmpty(env.DATABASE_URL, fromFiles.DATABASE_URL) ?? DEFAULT_DATABASE_URL;
  return {
    repoRoot,
    databaseUrl,
    dbPath: resolveSqlitePath(databaseUrl, repoRoot),
    migrationsFolder: path.join(repoRoot, 'src', 'lib', 'db', 'migrations'),
  };
}
