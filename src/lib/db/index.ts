import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { env } from '@/lib/env';
import * as schema from './schema';

function resolveDbPath(url: string): string {
  return url.startsWith('file:') ? url.slice('file:'.length) : url;
}

function ensureDirFor(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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
  const dbPath = resolveDbPath(env.DATABASE_URL);
  ensureDirFor(dbPath);
  const inst = new Database(dbPath);
  inst.pragma('journal_mode = WAL');
  inst.pragma('foreign_keys = ON');
  return inst;
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
