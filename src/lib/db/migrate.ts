import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { detectLegacyCheckoutContent } from '../../../scripts/examify-data.mjs';
import { UnsafeDataDirError } from '../data-dir';
import { initDataFolder, SharedDataFolderError } from '../data-folder';
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

const { repoRoot, dataDir, dbPath, migrationsFolder } = loadConfig();

// Family content still inside the checkout (a pre-data-folder install that
// was upgraded with a plain `git pull`) is invisible to this version of the
// app: refuse until it is moved, so kids never lose subjects silently.
if (process.env.EXAMIFY_IGNORE_LEGACY_CONTENT !== '1') {
  const legacy = detectLegacyCheckoutContent(repoRoot);
  if (legacy.legacy) {
    console.error(
      [
        'db:migrate: family content is still inside the checkout, where this version no longer reads it:',
        ...legacy.items.slice(0, 20).map((item) => `  - ${item.kind}: ${item.path}`),
        'Move it into the family data folder first (a backup is taken before anything moves):',
        '  ./install.sh --upgrade',
        'or, with the server stopped:',
        '  node scripts/examify-data.mjs backup && node scripts/examify-data.mjs migrate-checkout',
        'In a development checkout doing committed-content CLI work, set EXAMIFY_IGNORE_LEGACY_CONTENT=1.',
      ].join('\n'),
    );
    process.exit(1);
  }
}

try {
  initDataFolder({ dataDir, dbPath });
} catch (error) {
  if (error instanceof SharedDataFolderError) {
    console.error(`db:migrate: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
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
