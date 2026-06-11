import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

const url = process.env.DATABASE_URL ?? 'file:./data/app.db';
const dbPath = url.startsWith('file:') ? url.slice('file:'.length) : url;
const dir = path.dirname(dbPath);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
const db = drizzle(sqlite);

const migrationsFolder = path.join(process.cwd(), 'src', 'lib', 'db', 'migrations');

if (!fs.existsSync(migrationsFolder)) {
  console.log('No migrations directory yet — nothing to apply.');
  process.exit(0);
}

migrate(db, { migrationsFolder });
console.log(`Applied migrations against ${dbPath}`);
sqlite.close();
