/**
 * Apply migrations + reset state for the Playwright e2e database and the
 * suite's family data folder (`E2E_DATA_DIR`).
 *
 * Must run BEFORE `playwright test`, not from `globalSetup`. Playwright's
 * test runner starts `webServer` and waits for its `url` to return 2xx
 * before invoking globalSetup; our `/api/health` queries the `users` table,
 * which doesn't exist until migrations run. globalSetup-driven migration
 * therefore deadlocks the webServer healthcheck.
 *
 * Wired in via `pnpm test:e2e` -> `pnpm test:e2e:prepare && pnpm build && playwright test`
 * (and the `:fresh` / `:password` prepare scripts before their own suites).
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { initDataFolder } from '../../src/lib/data-folder';
import { seedExampleFamily } from './seed';

const cwd = process.cwd();
const tmp = path.join(cwd, 'tests', '.tmp');
fs.mkdirSync(tmp, { recursive: true });

const dbPath = process.env.E2E_DB_PATH ?? path.join(tmp, 'e2e.db');
for (const sidecar of [dbPath, `${dbPath}-journal`, `${dbPath}-shm`, `${dbPath}-wal`]) {
  if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
}

const configuredOutbox = process.env.MAIL_OUTBOX_DIR;
const outbox = configuredOutbox
  ? path.isAbsolute(configuredOutbox)
    ? configuredOutbox
    : path.join(cwd, configuredOutbox)
  : path.join(tmp, 'outbox');
if (fs.existsSync(outbox)) fs.rmSync(outbox, { recursive: true, force: true });

// The suite's family data folder (EXAMIFY_DATA_DIR in its Playwright config).
// Wiped every run, so it must stay under tests/.tmp — never a real folder.
const dataDir = path.resolve(cwd, process.env.E2E_DATA_DIR ?? path.join(tmp, 'e2e-seeded-data'));
const dataRel = path.relative(tmp, dataDir);
if (!dataRel || dataRel.startsWith('..') || path.isAbsolute(dataRel)) {
  console.error('[e2e:prepare] E2E_DATA_DIR must be a folder under tests/.tmp');
  process.exit(1);
}
fs.rmSync(dataDir, { recursive: true, force: true });
initDataFolder({ dataDir });

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

// `--empty`: no household (fresh first-run suite). `--password`: the example
// family with known passwords (AUTH_MODE=password suite). Default: the example
// family without password hashes (magic-link suite).
const seed = process.argv.includes('--empty')
  ? 'empty'
  : process.argv.includes('--password')
    ? 'example-family-password'
    : 'example-family';
if (seed !== 'empty') {
  seedExampleFamily(sqlite, { withPasswords: seed === 'example-family-password' });
} else {
  // The wizard lists family subjects only. Give the fresh suite the committed
  // `demo` fixture (subject.json + notes.txt) so its "Generate demo" step has
  // a subject with local sources, as a family that copied it in would.
  const demoSource = path.join(cwd, 'content', 'subjects', 'demo');
  const demoTarget = path.join(dataDir, 'content', 'subjects', 'demo');
  fs.mkdirSync(demoTarget, { recursive: true });
  for (const name of ['subject.json', 'notes.txt']) {
    fs.copyFileSync(path.join(demoSource, name), path.join(demoTarget, name));
  }
}

const tables = sqlite
  .prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name",
  )
  .all() as Array<{ name: string }>;
const expected = [
  'exam_attempts',
  'exam_sessions',
  'household_invites',
  'household_members',
  'households',
  'magic_tokens',
  'rate_limit_events',
  'users',
];
const missing = expected.filter((t) => !tables.some((row) => row.name === t));
if (missing.length > 0) {
  console.error(`[e2e:prepare] expected tables missing: ${missing.join(', ')}`);
  process.exit(1);
}

sqlite.close();
const size = fs.statSync(dbPath).size;
console.log(
  `[e2e:prepare] migrated ${expected.length} tables into ${dbPath} (${size} bytes), seed=${seed}, journal=DELETE, data=${path.relative(cwd, dataDir)}`,
);
