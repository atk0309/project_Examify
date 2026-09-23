import { chmodSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR_MARKER, UnsafeDataDirError, type DataPaths } from './data-dir';

// Relative imports only and no `server-only`: `db:migrate` (tsx) and the
// e2e prepare script load this without the `@/` alias.
// `scripts/examify-data.mjs` `init` mirrors these steps.

/** Layout version recorded in the data-folder marker. */
export const DATA_FOLDER_LAYOUT = 1;

export type DataFolderMarker = {
  layout: number;
  createdAt: string;
  migrations: unknown[];
};

/**
 * Names an Examify data folder may hold before it has a marker (an older
 * `./data`, or a volume holding only the database). Anything else means the
 * folder is shared with other software, which must never be chmodded or
 * written into.
 */
const KNOWN_ENTRIES = new Set([
  '.gitignore',
  '.DS_Store',
  '.examify-ingest',
  '.migrate-journal.json',
  '.upgrade-state.json',
  'app.db',
  'app.db-journal',
  'app.db-shm',
  'app.db-wal',
  'backups',
  'content',
  'lost+found',
  'migration-conflicts',
  'outbox',
]);

/** Restore leftovers: moved-aside content and an interrupted staging copy. */
const KNOWN_PREFIXES = ['before-restore-', '.restore-staging-'];

/** The folder holds files that are not Examify's; `message` carries no path. */
export class SharedDataFolderError extends Error {
  readonly code = 'SHARED_DATA_FOLDER';

  constructor() {
    super(
      "the family data folder already holds files that are not Examify's; set EXAMIFY_DATA_DIR to a folder of its own",
    );
    this.name = 'SharedDataFolderError';
  }
}

/** Filesystem failures that mean "not a folder this user can use" (never a bug). */
const UNUSABLE_FOLDER_CODES = new Set([
  'EACCES',
  'EEXIST',
  'EISDIR',
  'ELOOP',
  'ENAMETOOLONG',
  'ENOTDIR',
  'EPERM',
  'EROFS',
]);

export const UNREADABLE_DATA_FOLDER_MESSAGE =
  'the family data folder is not a folder this user can read (or create); check EXAMIFY_DATA_DIR (or DATABASE_URL) and who owns it';

/**
 * Rethrow a filesystem error from inspecting or creating the data folder as
 * an `UnsafeDataDirError` (`unreadable`) whose message names no path; Node's
 * own messages do (and would reach boot logs).
 */
function asUnreadable(error: unknown): never {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof code === 'string' && UNUSABLE_FOLDER_CODES.has(code)) {
    throw new UnsafeDataDirError('unreadable', UNREADABLE_DATA_FOLDER_MESSAGE);
  }
  throw error;
}

/**
 * Whether `target` exists. Only ENOENT means absent: `existsSync` also says
 * false for EACCES (an untraversable parent) or ELOOP, which would let an
 * unusable folder pass as "not created yet"; those become `unreadable`.
 */
function pathExists(target: string): boolean {
  try {
    statSync(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return false;
    asUnreadable(error);
  }
}

function assertDedicatedFolder(dataDir: string, dbPath: string | undefined): void {
  if (pathExists(path.join(dataDir, DATA_DIR_MARKER))) return;
  // A custom DATABASE_URL file name inside the folder (and its sidecars).
  const dbFiles = new Set<string>();
  if (dbPath && path.dirname(path.resolve(dbPath)) === path.resolve(dataDir)) {
    const base = path.basename(dbPath);
    for (const suffix of ['', '-wal', '-shm', '-journal']) dbFiles.add(`${base}${suffix}`);
  }
  let names: string[];
  try {
    names = readdirSync(dataDir);
  } catch (error) {
    asUnreadable(error);
  }
  for (const name of names) {
    if (
      KNOWN_ENTRIES.has(name) ||
      dbFiles.has(name) ||
      KNOWN_PREFIXES.some((p) => name.startsWith(p))
    ) {
      continue;
    }
    throw new SharedDataFolderError();
  }
}

/**
 * False when an existing, unmarked folder holds files Examify does not
 * recognise (a shared folder). A folder that does not exist yet is fine.
 * Throws `UnsafeDataDirError` (`unreadable`) for a file or a folder this user
 * cannot read.
 */
export function isDedicatedDataFolder(dataDir: string, dbPath?: string): boolean {
  if (!pathExists(dataDir)) return true;
  try {
    assertDedicatedFolder(dataDir, dbPath);
    return true;
  } catch (error) {
    if (error instanceof SharedDataFolderError) return false;
    throw error;
  }
}

/** Create `file` with `body` unless something already exists there (never clobbers). */
function writeIfMissing(file: string, body: string, mode: number): void {
  try {
    writeFileSync(file, body, { flag: 'wx', mode });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

/**
 * Initialise the family data folder: create it 0700 (and tighten it to
 * 0700 when this user owns it), then add a `.gitignore` (`*`, so the folder
 * is never committed by accident wherever it lives) and the marker. Existing
 * files are kept. Idempotent. Throws {@link SharedDataFolderError} for an
 * existing, unmarked folder that holds files Examify does not recognise, and
 * `UnsafeDataDirError` (`unreadable`, no path) when the folder is a file or
 * cannot be read or created by this user.
 */
export function initDataFolder(
  paths: Pick<DataPaths, 'dataDir'> & Partial<Pick<DataPaths, 'dbPath'>>,
  options: { warn?: (line: string) => void; now?: () => Date } = {},
): { created: boolean } {
  const { dataDir } = paths;
  const warn = options.warn ?? ((line: string) => console.warn(line));
  const created = !pathExists(dataDir);
  // An existing folder without the marker must look like Examify's own
  // before anything is chmodded or written (a DATABASE_URL-derived folder
  // could be shared, e.g. /var/lib).
  if (!created) assertDedicatedFolder(dataDir, paths.dbPath);
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    if (typeof process.getuid === 'function') {
      if (statSync(dataDir).uid === process.getuid()) {
        chmodSync(dataDir, 0o700);
      } else {
        warn(
          '[data] the family data folder belongs to another user; its permissions were left as is',
        );
      }
    }
    writeIfMissing(path.join(dataDir, '.gitignore'), '*\n', 0o600);
    const marker: DataFolderMarker = {
      layout: DATA_FOLDER_LAYOUT,
      createdAt: (options.now?.() ?? new Date()).toISOString(),
      migrations: [],
    };
    writeIfMissing(path.join(dataDir, DATA_DIR_MARKER), `${JSON.stringify(marker)}\n`, 0o600);
  } catch (error) {
    asUnreadable(error);
  }
  return { created };
}
