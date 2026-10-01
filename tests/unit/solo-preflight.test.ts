import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { assertSoloDatabase } from '@/lib/solo-preflight';
import { initDataFolder } from '@/lib/data-folder';

const roots: string[] = [];
const handles: Database.Database[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) if (handle.open) handle.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-preflight-test-'));
  roots.push(root);
  const file = path.join(root, 'data', 'app.db');
  return { root, file };
}
function database(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  handles.push(sqlite);
  migrate(drizzle(sqlite), { migrationsFolder: path.join(process.cwd(), 'src/lib/db/migrations') });
  return sqlite;
}
function snapshot(directory: string) {
  return fs
    .readdirSync(directory)
    .sort()
    .map((name) => {
      const file = path.join(directory, name);
      const stat = fs.statSync(file);
      return {
        name,
        mode: stat.mode,
        mtime: stat.mtimeMs,
        bytes: fs.readFileSync(file).toString('hex'),
      };
    });
}
function solo(sqlite: Database.Database) {
  sqlite.exec(`INSERT INTO users (id,email) VALUES (1,'learner@solo.invalid');
    INSERT INTO households (id,name) VALUES (1,'My learning');
    INSERT INTO household_members (user_id, household_id,role) VALUES (1,1,'admin');
    INSERT INTO solo_profiles (id,user_id,household_id,launch_key_hash) VALUES (1,1,1,'test-hash');`);
}

describe('solo preflight preserves original data before migration', () => {
  it('accepts absent data without creating or chmodding any folder', () => {
    const { file, root } = fixture();
    assertSoloDatabase(file);
    expect(fs.readdirSync(root)).toEqual([]);
  });
  it('allows an empty migrated database from interrupted first launch', () => {
    const { file } = fixture();
    initDataFolder({ dataDir: path.dirname(file), dbPath: file });
    database(file).close();
    const before = snapshot(path.dirname(file));
    assertSoloDatabase(file);
    expect(snapshot(path.dirname(file))).toEqual(before);
  });
  it('rejects household data before any original byte, permission or mtime changes', () => {
    const { file } = fixture();
    const sqlite = database(file);
    sqlite.exec("INSERT INTO users (email) VALUES ('household@example.test')");
    sqlite.close();
    const before = snapshot(path.dirname(file));
    expect(() => assertSoloDatabase(file)).toThrow(/separate solo installation/);
    expect(snapshot(path.dirname(file))).toEqual(before);
  });
  it('accepts marked solo data even when latest state lives in WAL, without touching source sidecars', () => {
    const { file } = fixture();
    const sqlite = database(file);
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('wal_autocheckpoint = 0');
    solo(sqlite);
    const before = snapshot(path.dirname(file));
    assertSoloDatabase(file);
    expect(snapshot(path.dirname(file))).toEqual(before);
  });
  it('does not overlook household identities written only to WAL', () => {
    const { file } = fixture();
    const sqlite = database(file);
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('wal_autocheckpoint = 0');
    sqlite.exec("INSERT INTO users (email) VALUES ('wal-only@example.test')");
    const before = snapshot(path.dirname(file));
    expect(() => assertSoloDatabase(file)).toThrow();
    expect(snapshot(path.dirname(file))).toEqual(before);
  });
  it('refuses unknown files without a database and malformed/foreign SQLite stores', () => {
    const { file } = fixture();
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(path.join(path.dirname(file), 'valuable.txt'), 'preserve me');
    expect(() => assertSoloDatabase(file)).toThrow();
    const sqlite = new Database(file);
    sqlite.exec('CREATE TABLE another_app (id INTEGER)');
    sqlite.close();
    expect(() => assertSoloDatabase(file)).toThrow();
  });
  it('rejects a copied marker with additional users and a symlinked database', () => {
    const { file, root } = fixture();
    const sqlite = database(file);
    solo(sqlite);
    sqlite.exec("INSERT INTO users (email) VALUES ('other@example.test')");
    sqlite.close();
    expect(() => assertSoloDatabase(file)).toThrow();
    fs.symlinkSync(file, path.join(root, 'linked.db'));
    expect(() => assertSoloDatabase(path.join(root, 'linked.db'))).toThrow();
  });
});
