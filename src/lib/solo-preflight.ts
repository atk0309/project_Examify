/** Standalone launcher preflight: no app env imports and NO writes to the source folder. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';

const MESSAGE =
  'This folder contains existing or unrecognized data. Choose a separate solo installation; existing files have not been changed.';
const TABLES = new Set([
  'users',
  'households',
  'household_members',
  'household_invites',
  'magic_tokens',
  'rate_limit_events',
  'exam_attempts',
  'exam_sessions',
  'solo_profiles',
  'solo_launch_tokens',
]);

function exists(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function assertRegular(file: string): void {
  const stat = fs.lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error(MESSAGE);
}

/** Copy bytes into a newly created private file, never the source's Windows ACL. */
function copyPrivateFile(source: string, destination: string): void {
  const input = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let output: number | undefined;
  try {
    const stat = fs.fstatSync(input);
    if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error(MESSAGE);
    }
    output = fs.openSync(destination, 'wx', 0o600);
    const buffer = Buffer.alloc(64 * 1024);
    let read: number;
    while ((read = fs.readSync(input, buffer, 0, buffer.length, null)) > 0) {
      let written = 0;
      while (written < read) written += fs.writeSync(output, buffer, written, read - written);
    }
  } finally {
    fs.closeSync(input);
    if (output !== undefined) fs.closeSync(output);
  }
}

function assertAncestors(file: string): void {
  let current = path.dirname(file);
  while (true) {
    if (exists(current)) {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(MESSAGE);
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function assertNoOtherData(dbPath: string): void {
  const directory = path.dirname(dbPath);
  if (!exists(directory)) return;
  const base = path.basename(dbPath);
  const allowed = new Set([base, `${base}-wal`, `${base}-shm`, '.examify-data.json', '.gitignore']);
  if (fs.readdirSync(directory).some((name) => !allowed.has(name))) throw new Error(MESSAGE);
  for (const name of ['.examify-data.json', '.gitignore']) {
    const file = path.join(directory, name);
    if (exists(file)) assertRegular(file);
  }
  const ignore = path.join(directory, '.gitignore');
  if (exists(ignore) && fs.readFileSync(ignore, 'utf8') !== '*\n') throw new Error(MESSAGE);
}

/**
 * Copy SQLite + WAL into a private temporary directory before inspecting them.
 * Opening the ORIGINAL even read-only can create SQLite SHM files. Only our
 * disposable copy can create sidecars, checkpoint or recover. Any incoherent
 * concurrent copy fails closed; no migration, chmod, mkdir or repair is applied
 * to the source. The launcher serializes its own starts before reaching this.
 */
export function assertSoloDatabase(dbPath: string): void {
  let temporary: string | undefined;
  let sqlite: Database.Database | undefined;
  try {
    if (!path.isAbsolute(dbPath)) throw new Error(MESSAGE);
    assertAncestors(dbPath);
    if (!exists(dbPath)) {
      assertNoOtherData(dbPath);
      // Sidecars without their database are not a fresh installation.
      if (exists(`${dbPath}-wal`) || exists(`${dbPath}-shm`)) throw new Error(MESSAGE);
      return;
    }
    assertRegular(dbPath);
    if (exists(`${dbPath}-journal`)) throw new Error(MESSAGE);
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-solo-preflight-'));
    if (process.platform === 'win32') {
      // Windows ignores POSIX 0700. Lock down this newly-created temporary
      // directory before copying any potentially private household bytes.
      const here = path.dirname(fileURLToPath(import.meta.url));
      const packaged = path.join(here, 'desktop', 'private-path.ps1');
      const helper = exists(packaged)
        ? packaged
        : path.resolve(here, '../../scripts/desktop/private-path.ps1');
      execFileSync(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          helper,
          '-Path',
          temporary,
        ],
        { stdio: 'ignore', windowsHide: true },
      );
    }
    const copy = path.join(temporary, 'app.db');
    copyPrivateFile(dbPath, copy);
    if (exists(`${dbPath}-wal`)) {
      assertRegular(`${dbPath}-wal`);
      copyPrivateFile(`${dbPath}-wal`, `${copy}-wal`);
    }
    sqlite = new Database(copy, { readonly: true, fileMustExist: true });
    if (sqlite.pragma('quick_check', { simple: true }) !== 'ok') throw new Error(MESSAGE);
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string;
    }[];
    const names = new Set(tables.map((table) => table.name));
    for (const name of names) {
      if (!name.startsWith('sqlite_') && name !== '__drizzle_migrations' && !TABLES.has(name))
        throw new Error(MESSAGE);
    }
    const count = (table: string) =>
      names.has(table)
        ? (sqlite!.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n
        : 0;
    if (count('solo_profiles') === 1) {
      const profile = sqlite
        .prepare(
          `SELECT p.id, u.email, m.role FROM solo_profiles p
        JOIN users u ON u.id = p.user_id JOIN households h ON h.id = p.household_id
        JOIN household_members m ON m.user_id = u.id AND m.household_id = h.id`,
        )
        .get() as { id: number; email: string; role: string } | undefined;
      if (
        !profile ||
        profile.id !== 1 ||
        profile.email !== 'learner@solo.invalid' ||
        profile.role !== 'admin' ||
        count('users') !== 1 ||
        count('households') !== 1 ||
        count('household_members') !== 1 ||
        count('household_invites') !== 0
      )
        throw new Error(MESSAGE);
      return;
    }
    // Empty migrated DBs may resume an interrupted first launch. Any other
    // records or files require explicit separate installation rather than adoption.
    if ([...TABLES].some((table) => count(table) !== 0)) throw new Error(MESSAGE);
    assertNoOtherData(dbPath);
  } catch {
    throw new Error(MESSAGE);
  } finally {
    sqlite?.close();
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assertSoloDatabase(process.argv[2] ?? '');
  } catch {
    console.error(MESSAGE);
    process.exitCode = 1;
  }
}
