/**
 * Apply migrations + reset state for the Playwright e2e database.
 *
 * Must run BEFORE `playwright test`, not from `globalSetup`. Playwright's
 * test runner starts `webServer` and waits for its `url` to return 2xx
 * before invoking globalSetup; our `/api/health` queries the `users` table,
 * which doesn't exist until migrations run. globalSetup-driven migration
 * therefore deadlocks the webServer healthcheck.
 *
 * Wired in via `pnpm test:e2e` -> `pnpm test:e2e:prepare && playwright test`.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

const cwd = process.cwd();
const tmp = path.join(cwd, 'tests', '.tmp');
fs.mkdirSync(tmp, { recursive: true });

const dbPath = path.join(tmp, 'e2e.db');
for (const sidecar of [dbPath, `${dbPath}-journal`, `${dbPath}-shm`, `${dbPath}-wal`]) {
  if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
}

const outbox = path.join(tmp, 'outbox');
if (fs.existsSync(outbox)) fs.rmSync(outbox, { recursive: true, force: true });

const migrationsFolder = path.join(cwd, 'src', 'lib', 'db', 'migrations');
const journal = path.join(migrationsFolder, 'meta', '_journal.json');
if (!fs.existsSync(journal)) {
  console.error(`[e2e:prepare] no migration journal at ${journal}`);
  process.exit(1);
}

const sqlite = new Database(dbPath);
// DELETE journal so the file is self-contained on close — the production
// webServer then re-opens it cleanly with no checkpointing dance.
sqlite.pragma('journal_mode = DELETE');
sqlite.pragma('foreign_keys = ON');

migrate(drizzle(sqlite), { migrationsFolder });

const tables = sqlite
  .prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name",
  )
  .all() as Array<{ name: string }>;
const expected = ['exam_attempts', 'exam_sessions', 'magic_tokens', 'rate_limit_events', 'users'];
const missing = expected.filter((t) => !tables.some((row) => row.name === t));
if (missing.length > 0) {
  console.error(`[e2e:prepare] expected tables missing: ${missing.join(', ')}`);
  process.exit(1);
}

sqlite.close();
const size = fs.statSync(dbPath).size;
console.log(
  `[e2e:prepare] migrated ${expected.length} tables into ${dbPath} (${size} bytes), journal=DELETE`,
);
