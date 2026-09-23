import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { UnsafeDataDirError } from '../data-dir';
import { initDataFolder } from '../data-folder';
import { resolveMigrateConfig, type MigrateConfig } from './migrate-env';

function loadConfig(): MigrateConfig {
  try {
    return resolveMigrateConfig();
  } catch (error) {
    if (error instanceof UnsafeDataDirError) {
      console.error(`db:migrate: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

const { dataDir, dbPath, migrationsFolder } = loadConfig();

// legacy-content check (wired at integration)

initDataFolder({ dataDir });
// An explicit DATABASE_URL may point outside the data folder.
const dir = path.dirname(dbPath);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
const db = drizzle(sqlite);

if (!fs.existsSync(migrationsFolder)) {
  console.log('No migrations directory yet — nothing to apply.');
  process.exit(0);
}

migrate(db, { migrationsFolder });
console.log(`Applied migrations against ${dbPath}`);
sqlite.close();
