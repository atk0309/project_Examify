import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getDataPaths } from '@/lib/data-dir';
import { isProd } from '@/lib/env';
import * as schema from './schema';

/**
 * Production found no database file. Usually the data folder (volume) is not
 * mounted, or `pnpm db:migrate` has not run. The message never names the path.
 */
export class DatabaseMissingError extends Error {
  readonly code = 'DB_MISSING';

  constructor() {
    super('database file not found — is the data folder mounted? run pnpm db:migrate');
    this.name = 'DatabaseMissingError';
  }
}

function ensureDirFor(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Open the SQLite file. Dev/test create it (and its folder) on first use.
 * With `mustExist` (production) a missing file throws
 * {@link DatabaseMissingError} and nothing is created: an unmounted volume
 * must fail closed, not come up as a fresh, empty household.
 */
export function openSqliteFile(dbPath: string, options: { mustExist: boolean }): Database.Database {
  const memory = dbPath === ':memory:';
  if (!memory && options.mustExist && !fs.existsSync(dbPath)) throw new DatabaseMissingError();
  if (!memory && !options.mustExist) ensureDirFor(dbPath);
  const inst = new Database(dbPath, { fileMustExist: !memory && options.mustExist });
  inst.pragma('journal_mode = WAL');
  inst.pragma('foreign_keys = ON');
  return inst;
}

function createDb(sqlite: Database.Database) {
  return drizzle(sqlite, { schema });
}

type DrizzleDb = ReturnType<typeof createDb>;

const globalForDb = globalThis as unknown as {
  __sqlite?: Database.Database;
  __db?: DrizzleDb;
};

function openSqlite(): Database.Database {
  return openSqliteFile(getDataPaths().dbPath, { mustExist: isProd });
}

function getDb(): DrizzleDb {
  if (globalForDb.__db) return globalForDb.__db;
  const sqlite = globalForDb.__sqlite ?? openSqlite();
  if (!globalForDb.__sqlite) globalForDb.__sqlite = sqlite;
  const instance = createDb(sqlite);
  globalForDb.__db = instance;
  return instance;
}

// Lazy connection. Importing this module must NOT open SQLite: during
// `next build` the page-data collection pass imports every route module
// (including the force-dynamic /api/health) across many workers at once, and
// opening the same file + setting WAL mode concurrently raced into
// SQLITE_BUSY. With this proxy the database is opened on first real query at
// runtime instead, so the build never touches it.
export const db = new Proxy({} as DrizzleDb, {
  get(_target, prop) {
    const real = getDb() as object;
    const value = Reflect.get(real, prop, real);
    return typeof value === 'function'
      ? (value as (...args: unknown[]) => unknown).bind(real)
      : value;
  },
});

export { schema };
