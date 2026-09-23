import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { envFileValue, readProductionEnvFiles } from './env-file';
import { findRepoRoot } from './repo-root';

// Relative imports only and no `server-only`: `db:migrate` (tsx),
// drizzle-kit and `tools/examify-ingest` load this without the `@/` alias.
// `scripts/examify-data.mjs` carries a copy of these rules (it runs from the
// upstream revision against old node_modules); a parity test keeps them equal.

/** Default family data folder, relative to the checkout root. Gitignored (`/data`). */
export const DEFAULT_DATA_DIR = 'data';
/** Marker `db:migrate` / `examify-data init` write into an initialised data folder. */
export const DATA_DIR_MARKER = '.examify-data.json';
/** SQLite file name inside the data folder when `DATABASE_URL` is unset. */
export const DB_FILE = 'app.db';

export type DataDirSource = 'EXAMIFY_DATA_DIR' | 'DATABASE_URL' | 'default';

export type DataPaths = {
  /** Checkout root (`package.json` name `project-examify`). */
  repoRoot: string;
  /** Absolute family data folder. */
  dataDir: string;
  dataDirSource: DataDirSource;
  /**
   * Content root for onboarding + examify-ingest family I/O. Same relative
   * layout as the checkout: `content/subjects`, `content/source-pdfs`,
   * `content/generated`, `.examify-ingest`.
   */
  familyRoot: string;
  /** Explicit `DATABASE_URL`, else `file:<dataDir>/app.db`. */
  databaseUrl: string;
  databaseUrlExplicit: boolean;
  /** Absolute SQLite path (`:memory:` is passed through). */
  dbPath: string;
  /** Absolute local mail outbox folder. */
  outboxDir: string;
};

export type UnsafeDataDirReason =
  /**
   * `EXAMIFY_DATA_DIR`, `DATABASE_URL` or `MAIL_OUTBOX_DIR` with a leading `~`,
   * a quote / backtick / newline, `$` or ` #` (breaks `.env`, is never
   * expanded, or Next and the CLIs would read it differently).
   */
  | 'bad_value'
  /** The checkout root itself, or a folder that contains it. */
  | 'checkout_root'
  /** Inside the checkout but not `data/…` (or `tests/.tmp/…` for the test suites). */
  | 'inside_checkout'
  /** `DATABASE_URL` names a file inside the checkout but not under `data/…` / `tests/.tmp/…`. */
  | 'db_inside_checkout'
  /** `MAIL_OUTBOX_DIR` is inside the checkout but not under `data/…` / `tests/.tmp/…`. */
  | 'outbox_inside_checkout'
  /** `MAIL_OUTBOX_DIR` is the data folder, contains it, or is inside (or contains) a family tree. */
  | 'outbox_overlaps_data'
  /** The folder is a file, or one this user cannot read or create (ENOTDIR, EACCES, …). */
  | 'unreadable';

/** The data folder would overlap the checkout. `message` never includes the path. */
export class UnsafeDataDirError extends Error {
  readonly code = 'UNSAFE_DATA_DIR';
  readonly reason: UnsafeDataDirReason;

  constructor(reason: UnsafeDataDirReason, message: string) {
    super(message);
    this.name = 'UnsafeDataDirError';
    this.reason = reason;
  }
}

type EnvLike = Record<string, string | undefined>;

/** Keys the resolver reads. */
export const DATA_ENV_KEYS = [
  'EXAMIFY_DATA_DIR',
  'DATABASE_URL',
  'MAIL_OUTBOX_DIR',
  'RESEND_API_KEY',
  'NODE_ENV',
] as const;

function nonBlank(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

/** Data-folder trees a backup copies: the mail outbox must never be, contain or sit inside one. */
const OUTBOX_EXCLUDED_TREES = [
  'content/subjects',
  'content/source-pdfs',
  'content/generated',
  '.examify-ingest',
  'migration-conflicts',
];

/**
 * realpath of the nearest existing ancestor + the not-yet-created rest
 * (lowercased on case-insensitive filesystems): compare these, never raw
 * strings, so a symlink cannot route a path out of a folder.
 */
export function canonicalPath(absPath: string): string {
  let existing = path.resolve(absPath);
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  let real = existing;
  try {
    real = realpathSync.native(existing);
  } catch {
    // keep the lexical path
  }
  const joined = path.join(real, ...rest);
  return CASE_INSENSITIVE_FS ? joined.toLowerCase() : joined;
}

/** `child` is `parent` or inside it (both from {@link canonicalPath}). */
export function containsPath(parent: string, child: string): boolean {
  if (child === parent) return true;
  const withSep = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
  return child.startsWith(withSep);
}

function resolveFromRoot(repoRoot: string, value: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(repoRoot, value);
}

/** `file:<path>` / bare path → absolute path, resolved against the checkout root. */
export function sqlitePathFromUrl(databaseUrl: string, repoRoot: string): string {
  const raw = databaseUrl.startsWith('file:') ? databaseUrl.slice('file:'.length) : databaseUrl;
  if (raw === ':memory:') return raw;
  return resolveFromRoot(repoRoot, raw);
}

/** The path-valued settings the resolver reads (named in `bad_value` messages). */
export type DataPathVariable = 'EXAMIFY_DATA_DIR' | 'DATABASE_URL' | 'MAIL_OUTBOX_DIR';

/**
 * Refuse a path value `.env` cannot carry or that Next would read differently
 * from the CLIs: a leading `~` (never expanded), a quote, backtick or newline,
 * ` #` (an inline comment) and `$` (Next expands `$VAR` in env files; the
 * CLIs reading those files do not, so `db:migrate` could open another
 * database than the app). The message names the variable, never the value.
 */
export function assertPathValue(name: DataPathVariable, value: string): void {
  if (value.startsWith('~')) {
    throw new UnsafeDataDirError(
      'bad_value',
      `${name} starts with ~, which is never expanded; use an absolute path`,
    );
  }
  if (/[\r\n"'`$]/.test(value) || /\s#/.test(value)) {
    throw new UnsafeDataDirError(
      'bad_value',
      `${name} contains a quote, a newline, "$" or " #"; pick a plainer path`,
    );
  }
}

/** {@link assertPathValue} for `EXAMIFY_DATA_DIR`. */
export function assertDataDirValue(value: string): void {
  assertPathValue('EXAMIFY_DATA_DIR', value);
}

/**
 * Inside the checkout, only `data/…` and `tests/.tmp/…` (the suites' own
 * folders) may hold runtime files. True when `abs` is outside the checkout or
 * under one of those; the checkout root itself is not allowed.
 */
function allowedInCheckout(repoRoot: string, abs: string): boolean {
  const root = canonicalPath(repoRoot);
  const target = canonicalPath(abs);
  if (!containsPath(root, target)) return true;
  if (target === root) return false;
  const parts = path.relative(root, target).split(path.sep);
  return parts[0] === DEFAULT_DATA_DIR || (parts[0] === 'tests' && parts[1] === '.tmp');
}

/**
 * The data folder must not overlap tracked or tool-managed checkout files.
 * Inside the checkout only `data/…` is allowed (plus `tests/.tmp/…`, which
 * the test suites use and wipe — never a real install). Anywhere outside
 * the checkout is allowed, except a folder that contains the checkout.
 * Compared on realpaths, so a symlink cannot route around it.
 */
export function assertSafeDataDir(repoRoot: string, dataDir: string): void {
  const root = canonicalPath(repoRoot);
  const dir = canonicalPath(dataDir);
  if (containsPath(dir, root)) {
    throw new UnsafeDataDirError(
      'checkout_root',
      'the family data folder cannot be the checkout or a folder that contains it',
    );
  }
  if (!allowedInCheckout(repoRoot, dataDir)) {
    throw new UnsafeDataDirError(
      'inside_checkout',
      'inside the checkout the family data folder must be ./data (or a folder under it)',
    );
  }
}

/**
 * Resolve every runtime path from one env record (no file reads besides
 * realpath). Order for the data folder:
 * 1. `EXAMIFY_DATA_DIR` (relative → checkout root, never cwd);
 * 2. the folder of an explicit SQLite `DATABASE_URL` when it is outside the
 *    checkout (a volume install such as `file:/data/app.db` keeps its family
 *    content next to its database);
 * 3. `./data`.
 * The database is an explicit `DATABASE_URL` (existing installs keep theirs),
 * else `<dataDir>/app.db`. Neither the database nor the mail outbox (bearer
 * tokens) may sit inside the checkout outside `data/…` / `tests/.tmp/…`.
 * Throws {@link UnsafeDataDirError}; its message never names a path.
 */
export function resolveDataPaths(input: { repoRoot: string; env: EnvLike }): DataPaths {
  const { repoRoot, env } = input;
  const rawDir = nonBlank(env.EXAMIFY_DATA_DIR);
  const rawDbUrl = nonBlank(env.DATABASE_URL);
  if (rawDbUrl) {
    assertPathValue(
      'DATABASE_URL',
      rawDbUrl.startsWith('file:') ? rawDbUrl.slice('file:'.length) : rawDbUrl,
    );
  }

  let dataDir: string;
  let dataDirSource: DataDirSource;
  if (rawDir) {
    assertDataDirValue(rawDir);
    dataDir = resolveFromRoot(repoRoot, rawDir);
    dataDirSource = 'EXAMIFY_DATA_DIR';
  } else {
    const explicitDb = rawDbUrl ? sqlitePathFromUrl(rawDbUrl, repoRoot) : undefined;
    const dbDir = explicitDb && explicitDb !== ':memory:' ? path.dirname(explicitDb) : undefined;
    const root = canonicalPath(repoRoot);
    const dbDirCanonical = dbDir ? canonicalPath(dbDir) : undefined;
    // Only a folder fully outside the checkout: one inside it (./app.db) or
    // containing it (file:/app.db) falls back to ./data for family content.
    if (
      dbDir &&
      dbDirCanonical &&
      !containsPath(root, dbDirCanonical) &&
      !containsPath(dbDirCanonical, root)
    ) {
      dataDir = dbDir;
      dataDirSource = 'DATABASE_URL';
    } else {
      dataDir = path.join(/*turbopackIgnore: true*/ repoRoot, DEFAULT_DATA_DIR);
      dataDirSource = 'default';
    }
  }
  assertSafeDataDir(repoRoot, dataDir);

  const databaseUrl = rawDbUrl ?? `file:${path.join(dataDir, DB_FILE)}`;
  const dbPath = sqlitePathFromUrl(databaseUrl, repoRoot);
  if (dbPath !== ':memory:' && !allowedInCheckout(repoRoot, dbPath)) {
    throw new UnsafeDataDirError(
      'db_inside_checkout',
      'DATABASE_URL points inside the checkout; keep the database in the family data folder (./data/app.db) or outside the checkout',
    );
  }
  const outbox = nonBlank(env.MAIL_OUTBOX_DIR);
  if (outbox) assertPathValue('MAIL_OUTBOX_DIR', outbox);
  const production = env.NODE_ENV === 'production';
  let outboxDir: string;
  if (outbox) {
    outboxDir = resolveFromRoot(repoRoot, outbox);
  } else if (!production && (env.RESEND_API_KEY === 'test' || env.NODE_ENV === 'test')) {
    // Dev / unit sentinel only: a production host that copied
    // `RESEND_API_KEY=test` must not write bearer tokens into the checkout.
    outboxDir = path.join(/*turbopackIgnore: true*/ repoRoot, 'tests', '.tmp', 'outbox');
  } else {
    outboxDir = path.join(/*turbopackIgnore: true*/ dataDir, 'outbox');
  }
  if (!allowedInCheckout(repoRoot, outboxDir)) {
    throw new UnsafeDataDirError(
      'outbox_inside_checkout',
      'MAIL_OUTBOX_DIR points inside the checkout; keep the mail outbox in the family data folder (./data/outbox) or outside the checkout',
    );
  }
  // The outbox holds live sign-in tokens and is never backed up, so it must
  // not overlap a tree a backup copies: containing one (the data folder, an
  // ancestor) or sitting inside one (a subject folder) would take that family
  // content out of every backup.
  const outboxCanonical = canonicalPath(outboxDir);
  if (
    OUTBOX_EXCLUDED_TREES.some((rel) => {
      const tree = canonicalPath(path.join(dataDir, rel));
      return containsPath(outboxCanonical, tree) || containsPath(tree, outboxCanonical);
    })
  ) {
    throw new UnsafeDataDirError(
      'outbox_overlaps_data',
      "MAIL_OUTBOX_DIR is the family data folder, contains it, or is inside one of its content folders; give the mail outbox a folder of its own (the default is the data folder's outbox/)",
    );
  }

  return {
    repoRoot,
    dataDir,
    dataDirSource,
    familyRoot: dataDir,
    databaseUrl,
    databaseUrlExplicit: rawDbUrl !== undefined,
    dbPath,
    outboxDir,
  };
}

/**
 * CLI processes (`db:migrate`, `examify-ingest`, drizzle-kit) do not get
 * Next's env loading, so read the repo env files the way `next start` does
 * (`.env.production.local` > `.env.local` > `.env.production` > `.env`; the
 * first file that defines a key wins, even empty). A non-blank process env
 * value wins over the files.
 */
export function resolveCliDataPaths(
  cwd: string = process.cwd(),
  processEnv: EnvLike = process.env,
): DataPaths {
  const repoRoot = findRepoRoot(cwd);
  const files = readProductionEnvFiles(repoRoot);
  const env: EnvLike = {};
  for (const key of DATA_ENV_KEYS) {
    env[key] = nonBlank(processEnv[key]) ?? envFileValue(files, key);
  }
  return resolveDataPaths({ repoRoot, env });
}

let testDataDir: string | null = null;
let repoRootCache: { cwd: string; root: string } | null = null;
let pathsCache: { key: string; value: DataPaths } | null = null;

/** Tests only — point the data folder at a temp dir (`null` restores env resolution). */
export function setDataDirForTests(dir: string | null): void {
  testDataDir = dir;
  pathsCache = null;
}

function runtimeRepoRoot(): string {
  const cwd = process.cwd();
  if (repoRootCache?.cwd !== cwd) repoRootCache = { cwd, root: findRepoRoot(cwd) };
  return repoRootCache.root;
}

/**
 * Runtime paths. Next has already loaded the repo env files into
 * `process.env`, so this reads `process.env` as-is. Memoised on the inputs,
 * so an env change (tests) is picked up.
 */
export function getDataPaths(): DataPaths {
  const repoRoot = runtimeRepoRoot();
  const env: EnvLike = {};
  for (const key of DATA_ENV_KEYS) env[key] = process.env[key];
  if (testDataDir) env.EXAMIFY_DATA_DIR = testDataDir;
  const key = JSON.stringify([repoRoot, ...DATA_ENV_KEYS.map((name) => env[name] ?? null)]);
  if (pathsCache?.key === key) return pathsCache.value;
  const value = resolveDataPaths({ repoRoot, env });
  pathsCache = { key, value };
  return value;
}
