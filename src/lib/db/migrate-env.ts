import path from 'node:path';
import { resolveCliDataPaths } from '../data-dir';
import { parseEnvFile } from '../env-file';

export { parseEnvFile };

export type MigrateConfig = {
  repoRoot: string;
  /** Family data folder `db:migrate` initialises (0700, `.gitignore`, marker). */
  dataDir: string;
  databaseUrl: string;
  dbPath: string;
  migrationsFolder: string;
};

/**
 * Resolve the SQLite file `pnpm db:migrate` should open — the same one the
 * app opens. Delegates to `resolveCliDataPaths`: repo-root env files in
 * `next start` order, a non-empty process env value wins (host-injected),
 * an explicit `DATABASE_URL` wins over `<EXAMIFY_DATA_DIR>/app.db`, and
 * relative values resolve against the checkout root (never cwd).
 * Throws `UnsafeDataDirError` for a data folder that overlaps the checkout.
 */
export function resolveMigrateConfig(
  cwd = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): MigrateConfig {
  const paths = resolveCliDataPaths(cwd, env);
  return {
    repoRoot: paths.repoRoot,
    dataDir: paths.dataDir,
    databaseUrl: paths.databaseUrl,
    dbPath: paths.dbPath,
    migrationsFolder: path.join(paths.repoRoot, 'src', 'lib', 'db', 'migrations'),
  };
}
