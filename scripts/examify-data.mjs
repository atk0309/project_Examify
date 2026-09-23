#!/usr/bin/env node
/**
 * examify-data — the family data folder tool: paths, init, backup, restore,
 * legacy-check, migrate-checkout, verify. `--help` lists the flags.
 *
 * `install.sh --upgrade` runs the UPSTREAM copy of this file
 * (`git show @{u}:scripts/examify-data.mjs`) against the OLD checkout's
 * node_modules, so it stays plain ESM on Node builtins only. better-sqlite3
 * comes from the checkout (`createRequire(<repo>/package.json)`) or from
 * `--sqlite-module` / `EXAMIFY_SQLITE_MODULE`. Nothing here imports from src/.
 *
 * The resolver below is a copy of src/lib/env-file.ts + src/lib/data-dir.ts;
 * tests/unit/examify-data.test.ts runs both over the same table of cases.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXIT = Object.freeze({
  OK: 0,
  UNEXPECTED: 1,
  USAGE: 2,
  UNSAFE_DATA_DIR: 3,
  LEGACY_CONTENT: 4,
  REFUSED: 5,
  VERIFY_FAILED: 6,
});

/** Thrown by commands; carries the exit code and a stable error code for `--json`. */
export class CliError extends Error {
  constructor(exitCode, code, message, extra = {}) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.code = code;
    this.extra = extra;
  }
}

function isEnoent(error) {
  return Boolean(error) && error.code === 'ENOENT';
}

// ---------------------------------------------------------------------------
// Resolver (copy of src/lib/env-file.ts + src/lib/data-dir.ts — keep in sync)
// ---------------------------------------------------------------------------

function isWrappedInQuotes(value) {
  if (value.length < 2) return false;
  const start = value[0];
  const end = value[value.length - 1];
  return (start === '"' && end === '"') || (start === "'" && end === "'");
}

function stripUnquotedInlineComment(value) {
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== '#') continue;
    if (i === 0) return '';
    const prev = value.charCodeAt(i - 1);
    if (prev === 32 || prev === 9 || prev === 11 || prev === 12 || prev === 13) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value;
}

function parseEnvAssignmentValue(raw) {
  const trimmed = raw.trim();
  if (isWrappedInQuotes(trimmed)) return trimmed.slice(1, -1);
  const uncommented = stripUnquotedInlineComment(trimmed);
  if (isWrappedInQuotes(uncommented)) return uncommented.slice(1, -1);
  return uncommented;
}

/** Parse KEY=VALUE lines. Never logs values. */
export function parseEnvFile(contents) {
  const out = {};
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out[key] = parseEnvAssignmentValue(body.slice(eq + 1));
  }
  return out;
}

export function readEnvFile(absPath) {
  try {
    return parseEnvFile(fs.readFileSync(absPath, 'utf8'));
  } catch (error) {
    if (isEnoent(error)) return {};
    throw error;
  }
}

/** The files `next start` loads, highest precedence first. */
export const PRODUCTION_ENV_FILES = [
  '.env.production.local',
  '.env.local',
  '.env.production',
  '.env',
];

export function envFileValue(files, key) {
  for (const file of files) {
    if (Object.prototype.hasOwnProperty.call(file, key)) return file[key];
  }
  return undefined;
}

export function readProductionEnvFiles(repoRoot) {
  return PRODUCTION_ENV_FILES.map((name) => readEnvFile(path.join(repoRoot, name)));
}

export const EXAMIFY_PACKAGE_NAME = 'project-examify';

function isExamifyCheckout(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return pkg.name === EXAMIFY_PACKAGE_NAME;
  } catch {
    return false;
  }
}

export function findRepoRoot(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    if (isExamifyCheckout(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error('could not find the Examify repo root (package.json name project-examify)');
    }
    dir = parent;
  }
}

export const DEFAULT_DATA_DIR = 'data';
export const DATA_DIR_MARKER = '.examify-data.json';
export const DB_FILE = 'app.db';

/** The data folder would overlap the checkout. `message` never includes the path. */
export class UnsafeDataDirError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'UnsafeDataDirError';
    this.code = 'UNSAFE_DATA_DIR';
    this.reason = reason;
  }
}

export const DATA_ENV_KEYS = [
  'EXAMIFY_DATA_DIR',
  'DATABASE_URL',
  'MAIL_OUTBOX_DIR',
  'RESEND_API_KEY',
  'NODE_ENV',
];

function nonBlank(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

/** realpath of the nearest existing ancestor + the not-yet-created rest. */
function canonical(absPath) {
  let existing = path.resolve(absPath);
  const rest = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  let real = existing;
  try {
    real = fs.realpathSync.native(existing);
  } catch {
    // keep the lexical path
  }
  const joined = path.join(real, ...rest);
  return CASE_INSENSITIVE_FS ? joined.toLowerCase() : joined;
}

/** `child` is `parent` or inside it (both canonical). */
function contains(parent, child) {
  if (child === parent) return true;
  const withSep = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
  return child.startsWith(withSep);
}

function resolveFromRoot(repoRoot, value) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(repoRoot, value);
}

export function sqlitePathFromUrl(databaseUrl, repoRoot) {
  const raw = databaseUrl.startsWith('file:') ? databaseUrl.slice('file:'.length) : databaseUrl;
  if (raw === ':memory:') return raw;
  return resolveFromRoot(repoRoot, raw);
}

/** A path value `.env` cannot carry or Next and the CLIs would read differently. */
export function assertPathValue(name, value) {
  if (value.startsWith('~')) {
    throw new UnsafeDataDirError(
      'bad_value',
      `${name} starts with ~, which is never expanded; use an absolute path`,
    );
  }
  if (/[\r\n"'`$]/.test(value) || /\s#/.test(value)) {
    // `$` too: Next expands `$VAR` in env files, CLIs reading them do not.
    throw new UnsafeDataDirError(
      'bad_value',
      `${name} contains a quote, a newline, "$" or " #"; pick a plainer path`,
    );
  }
}

export function assertDataDirValue(value) {
  assertPathValue('EXAMIFY_DATA_DIR', value);
}

/** Outside the checkout, or under its `data/…` / `tests/.tmp/…` (never the root itself). */
function allowedInCheckout(repoRoot, abs) {
  const root = canonical(repoRoot);
  const target = canonical(abs);
  if (!contains(root, target)) return true;
  if (target === root) return false;
  const parts = path.relative(root, target).split(path.sep);
  return parts[0] === DEFAULT_DATA_DIR || (parts[0] === 'tests' && parts[1] === '.tmp');
}

export function assertSafeDataDir(repoRoot, dataDir) {
  const root = canonical(repoRoot);
  const dir = canonical(dataDir);
  if (contains(dir, root)) {
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

export function resolveDataPaths({ repoRoot, env }) {
  const rawDir = nonBlank(env.EXAMIFY_DATA_DIR);
  const rawDbUrl = nonBlank(env.DATABASE_URL);
  if (rawDbUrl) {
    assertPathValue(
      'DATABASE_URL',
      rawDbUrl.startsWith('file:') ? rawDbUrl.slice('file:'.length) : rawDbUrl,
    );
  }

  let dataDir;
  let dataDirSource;
  if (rawDir) {
    assertDataDirValue(rawDir);
    dataDir = resolveFromRoot(repoRoot, rawDir);
    dataDirSource = 'EXAMIFY_DATA_DIR';
  } else {
    const explicitDb = rawDbUrl ? sqlitePathFromUrl(rawDbUrl, repoRoot) : undefined;
    const dbDir = explicitDb && explicitDb !== ':memory:' ? path.dirname(explicitDb) : undefined;
    const root = canonical(repoRoot);
    const dbDirCanonical = dbDir ? canonical(dbDir) : undefined;
    if (
      dbDir &&
      dbDirCanonical &&
      !contains(root, dbDirCanonical) &&
      !contains(dbDirCanonical, root)
    ) {
      dataDir = dbDir;
      dataDirSource = 'DATABASE_URL';
    } else {
      dataDir = path.join(repoRoot, DEFAULT_DATA_DIR);
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
  let outboxDir;
  if (outbox) {
    outboxDir = resolveFromRoot(repoRoot, outbox);
  } else if (!production && (env.RESEND_API_KEY === 'test' || env.NODE_ENV === 'test')) {
    outboxDir = path.join(repoRoot, 'tests', '.tmp', 'outbox');
  } else {
    outboxDir = path.join(dataDir, 'outbox');
  }
  if (!allowedInCheckout(repoRoot, outboxDir)) {
    throw new UnsafeDataDirError(
      'outbox_inside_checkout',
      'MAIL_OUTBOX_DIR points inside the checkout; keep the mail outbox in the family data folder (./data/outbox) or outside the checkout',
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

/** `resolveDataPaths` over parsed env files (highest precedence first); non-blank process env wins. */
function dataPathsFromFiles(repoRoot, files, processEnv) {
  const env = {};
  for (const key of DATA_ENV_KEYS) {
    env[key] = nonBlank(processEnv[key]) ?? envFileValue(files, key);
  }
  return resolveDataPaths({ repoRoot, env });
}

/** `resolveCliDataPaths` for a known checkout root: env files, non-blank process env wins. */
export function resolveRepoDataPaths(repoRoot, processEnv = process.env) {
  return dataPathsFromFiles(repoRoot, readProductionEnvFiles(repoRoot), processEnv);
}

export function resolveCliDataPaths(cwd = process.cwd(), processEnv = process.env) {
  return resolveRepoDataPaths(findRepoRoot(cwd), processEnv);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const SUBJECT_ID_RE = /^[a-z][a-z0-9-]*$/;
const REGISTRARS = ['src/lib/exam/generated-public.ts', 'src/lib/exam/generated-keys.server.ts'];
const MIGRATION_ID = 'checkout-content-v1';
const MIGRATE_JOURNAL = '.migrate-journal.json';
const BACKUP_KINDS = ['manual', 'pre-upgrade'];
/** Family entries of the data folder that backup / restore / migrate move around. */
const FAMILY_ENTRIES = ['content', '.examify-ingest', 'migration-conflicts'];
const BIG_BUFFER = 512 * 1024 * 1024;

function defaultGeteuid() {
  return typeof process.geteuid === 'function' ? process.geteuid() : undefined;
}

function randomHex(bytes) {
  return randomBytes(bytes).toString('hex');
}

/** `20260923T001700Z` */
function compactUtc(date) {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lstatOrNull(abs) {
  try {
    return fs.lstatSync(abs);
  } catch (error) {
    if (isEnoent(error) || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

function isFile(abs) {
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

function toPosix(rel) {
  return rel.split(path.sep).join('/');
}

function fromPosix(base, rel) {
  return path.join(base, ...rel.split('/'));
}

/** OS junk never counts as family content and is never copied. */
export function isJunkName(name) {
  const lower = name.toLowerCase();
  return (
    name === '.DS_Store' ||
    name.startsWith('._') ||
    lower === 'thumbs.db' ||
    lower === 'desktop.ini'
  );
}

function sha256File(abs) {
  const hash = createHash('sha256');
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Copy of src/lib/exam/generated-revision.ts `generatedRevision` (this file
 * imports nothing from src/): sha256 over a family subject's questions bytes,
 * "\n", then its keys bytes. A parity test keeps the two equal.
 */
export function generatedRevision(questions, keys) {
  return createHash('sha256').update(questions).update('\n').update(keys).digest('hex');
}

function fsyncDir(dir) {
  try {
    const fd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // not supported everywhere; the file itself was fsynced
  }
}

/**
 * Copy `src` (a symlink is followed) to `dest` through a hidden temp file in
 * the same folder, fsync, rename. Returns the sha256 + size of the bytes
 * written, so a caller can verify against an expected hash.
 */
function copyFileHashed(src, dest, { mode = 0o600, dirMode = 0o700 } = {}) {
  const dir = path.dirname(dest);
  fs.mkdirSync(dir, { recursive: true, mode: dirMode });
  const tmp = path.join(dir, `.${path.basename(dest)}.tmp-${randomHex(4)}`);
  const hash = createHash('sha256');
  let size = 0;
  const inFd = fs.openSync(src, 'r');
  let outFd;
  try {
    outFd = fs.openSync(tmp, 'wx', mode);
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = fs.readSync(inFd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
      size += n;
      let off = 0;
      while (off < n) off += fs.writeSync(outFd, buf, off, n - off);
    }
    fs.fchmodSync(outFd, mode);
    fs.fsyncSync(outFd);
    fs.closeSync(outFd);
    outFd = undefined;
    fs.renameSync(tmp, dest);
  } catch (error) {
    if (outFd !== undefined) fs.closeSync(outFd);
    fs.rmSync(tmp, { force: true });
    throw error;
  } finally {
    fs.closeSync(inFd);
  }
  return { sha256: hash.digest('hex'), size };
}

function writeFileAtomic(dest, body, { mode = 0o600, dirMode = 0o700 } = {}) {
  const dir = path.dirname(dest);
  fs.mkdirSync(dir, { recursive: true, mode: dirMode });
  const tmp = path.join(dir, `.${path.basename(dest)}.tmp-${randomHex(4)}`);
  try {
    const fd = fs.openSync(tmp, 'wx', mode);
    try {
      fs.writeFileSync(fd, body);
      fs.fchmodSync(fd, mode);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, dest);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

function writeIfMissing(file, body, mode) {
  try {
    fs.writeFileSync(file, body, { flag: 'wx', mode });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

/**
 * Regular files under `abs` (followed through symlinks, a cycle on the
 * current chain is skipped), mapped to `rel`. OS junk and special files are
 * skipped; `warn` gets one line per skipped special file / broken link.
 */
function filesUnder(abs, rel, warn = () => {}, chain = []) {
  let st;
  try {
    st = fs.statSync(abs);
  } catch (error) {
    if (isEnoent(error) || error.code === 'ENOTDIR') {
      if (lstatOrNull(abs)?.isSymbolicLink()) warn(`skipped a broken symlink: ${rel}`);
      return [];
    }
    throw error;
  }
  if (st.isFile()) return [{ src: abs, rel }];
  if (!st.isDirectory()) {
    warn(`skipped a special file: ${rel}`);
    return [];
  }
  const real = fs.realpathSync(abs);
  if (chain.includes(real)) {
    warn(`skipped a symlink loop: ${rel}`);
    return [];
  }
  const out = [];
  for (const name of fs.readdirSync(abs).sort()) {
    if (isJunkName(name)) continue;
    out.push(...filesUnder(path.join(abs, name), `${rel}/${name}`, warn, [...chain, real]));
  }
  return out;
}

/** True when `abs` holds at least one non-directory entry (lstat, links count). */
function hasAnyEntry(abs) {
  const st = lstatOrNull(abs);
  if (!st) return false;
  if (!st.isDirectory()) return true;
  return fs.readdirSync(abs).some((name) => hasAnyEntry(path.join(abs, name)));
}

// ---------------------------------------------------------------------------
// Context, ownership, data folder
// ---------------------------------------------------------------------------

function resolveContext(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  let repoRoot;
  if (options.repo) {
    repoRoot = path.resolve(cwd, options.repo);
    if (!isExamifyCheckout(repoRoot)) {
      throw new CliError(
        EXIT.USAGE,
        'not_a_checkout',
        '--repo is not an Examify checkout (package.json name project-examify)',
      );
    }
  } else {
    try {
      repoRoot = findRepoRoot(cwd);
    } catch {
      throw new CliError(
        EXIT.USAGE,
        'not_a_checkout',
        'run this inside the Examify checkout or pass --repo <dir>',
      );
    }
  }
  const resolveEnv = { ...env };
  if (options.dataDir !== undefined) resolveEnv.EXAMIFY_DATA_DIR = options.dataDir;
  const paths = unsafeAsCliError(() => resolveRepoDataPaths(repoRoot, resolveEnv));
  return { cwd, env, repoRoot, paths, log: options.log ?? (() => {}) };
}

/** Run a resolver; an `UnsafeDataDirError` becomes exit 3 with its reason code. */
function unsafeAsCliError(resolve, prefix = '') {
  try {
    return resolve();
  } catch (error) {
    if (error instanceof UnsafeDataDirError) {
      throw new CliError(EXIT.UNSAFE_DATA_DIR, 'unsafe_data_dir', `${prefix}${error.message}`, {
        reason: error.reason,
      });
    }
    throw error;
  }
}

/**
 * Writing commands refuse when this process does not run as the owner of the
 * checkout, the data folder or the database: files created as root (sudo,
 * a root cron) are unreadable to the app user and break grading.
 */
function assertOwnership(ctx, options) {
  if (options.allowOwnerMismatch) return;
  const uid = (options.geteuid ?? defaultGeteuid)();
  if (uid === undefined) return;
  const targets = [
    ['checkout', ctx.repoRoot],
    ['family data folder', ctx.paths.dataDir],
  ];
  if (ctx.paths.dbPath !== ':memory:') targets.push(['database', ctx.paths.dbPath]);
  for (const [label, target] of targets) {
    let st;
    try {
      st = fs.statSync(target);
    } catch (error) {
      // Not there (yet), or cannot be: nothing to own.
      if (isEnoent(error) || error.code === 'ENOTDIR') continue;
      asUnreadable(error);
    }
    if (st.uid !== uid) {
      throw new CliError(
        EXIT.REFUSED,
        'owner_mismatch',
        `the ${label} belongs to uid ${st.uid} but this runs as uid ${uid}; run it as the user that runs Examify (or pass --allow-owner-mismatch)`,
      );
    }
  }
}

/**
 * Names an Examify data folder may hold before it has a marker (an older
 * `./data`, or a volume holding only the database). Mirrors
 * `src/lib/data-folder.ts`. Anything else means the folder is shared with
 * other software, which must never be chmodded or written into.
 */
const KNOWN_DATA_ENTRIES = new Set([
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
const KNOWN_DATA_PREFIXES = ['before-restore-', '.restore-staging-'];

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

/**
 * Rethrow a filesystem error from inspecting or creating the data folder as
 * exit 3 (`unsafe_data_dir`, reason `unreadable`) without a path; Node's own
 * messages name it. Mirrors src/lib/data-folder.ts.
 */
function asUnreadable(error) {
  if (error && typeof error.code === 'string' && UNUSABLE_FOLDER_CODES.has(error.code)) {
    throw new CliError(
      EXIT.UNSAFE_DATA_DIR,
      'unsafe_data_dir',
      'the family data folder is not a folder this user can read (or create); check EXAMIFY_DATA_DIR (or DATABASE_URL) and who owns it',
      { reason: 'unreadable' },
    );
  }
  throw error;
}

function assertDedicatedFolder(dataDir, dbPath) {
  if (fs.existsSync(path.join(dataDir, DATA_DIR_MARKER))) return;
  const dbFiles = new Set();
  if (dbPath && path.dirname(path.resolve(dbPath)) === path.resolve(dataDir)) {
    const base = path.basename(dbPath);
    for (const suffix of ['', '-wal', '-shm', '-journal']) dbFiles.add(`${base}${suffix}`);
  }
  let names;
  try {
    names = fs.readdirSync(dataDir);
  } catch (error) {
    asUnreadable(error);
  }
  for (const name of names) {
    if (
      KNOWN_DATA_ENTRIES.has(name) ||
      dbFiles.has(name) ||
      KNOWN_DATA_PREFIXES.some((p) => name.startsWith(p))
    ) {
      continue;
    }
    throw new CliError(
      EXIT.REFUSED,
      'shared_folder',
      "the family data folder already holds files that are not Examify's; set EXAMIFY_DATA_DIR to a folder of its own",
    );
  }
}

/**
 * Create the data folder (0700; chmod only when this user owns it), its
 * `.gitignore` (`*`) and the marker. Existing files are never rewritten.
 * `created` is true when the folder did not exist before. An existing,
 * unmarked folder holding files Examify does not recognise is refused
 * (exit 5, `shared_folder`) before anything is chmodded or written, unless
 * the caller already vetted it (`vetted`, restore after placing its files).
 */
export function initDataFolder(
  paths,
  { geteuid = defaultGeteuid, warn = () => {}, vetted = false } = {},
) {
  const { dataDir } = paths;
  const created = !fs.existsSync(dataDir);
  if (!created && !vetted) assertDedicatedFolder(dataDir, paths.dbPath);
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const st = fs.statSync(dataDir);
    const uid = geteuid();
    if (uid === undefined || st.uid === uid) {
      if ((st.mode & 0o777) !== 0o700) fs.chmodSync(dataDir, 0o700);
    } else {
      warn('the family data folder belongs to another user; its permissions were left unchanged');
    }
    writeIfMissing(path.join(dataDir, '.gitignore'), '*\n', 0o644);
    const marker = { layout: 1, createdAt: new Date().toISOString(), migrations: [] };
    writeIfMissing(
      path.join(dataDir, DATA_DIR_MARKER),
      `${JSON.stringify(marker, null, 2)}\n`,
      0o600,
    );
  } catch (error) {
    asUnreadable(error);
  }
  return { created };
}

function readMarker(dataDir) {
  const file = path.join(dataDir, DATA_DIR_MARKER);
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (isEnoent(error)) return null;
    throw new CliError(EXIT.UNEXPECTED, 'marker_invalid', `${DATA_DIR_MARKER} is not valid JSON`);
  }
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
    throw new CliError(EXIT.UNEXPECTED, 'marker_invalid', `${DATA_DIR_MARKER} is not an object`);
  }
  return marker;
}

function appendMarkerMigration(dataDir, entry) {
  const marker = readMarker(dataDir) ?? { layout: 1, createdAt: new Date().toISOString() };
  const migrations = Array.isArray(marker.migrations) ? marker.migrations : [];
  const next = { ...marker, migrations: [...migrations, entry] };
  writeFileAtomic(path.join(dataDir, DATA_DIR_MARKER), `${JSON.stringify(next, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// SQLite, tar, git, server probe
// ---------------------------------------------------------------------------

/** better-sqlite3 from `sqliteModule` (a path) or from the checkout's node_modules. */
export function loadSqlite(repoRoot, sqliteModule) {
  try {
    if (sqliteModule) {
      return createRequire(import.meta.url)(path.resolve(sqliteModule));
    }
    return createRequire(path.join(repoRoot, 'package.json'))('better-sqlite3');
  } catch {
    throw new CliError(
      EXIT.UNEXPECTED,
      'sqlite_missing',
      'better-sqlite3 could not be loaded; run pnpm install in the checkout (or pass --sqlite-module <path>)',
    );
  }
}

function sqliteModuleOption(ctx, options) {
  const value = options.sqliteModule ?? nonBlank(ctx.env.EXAMIFY_SQLITE_MODULE);
  return value ? path.resolve(ctx.cwd, value) : undefined;
}

function isBusy(error) {
  return Boolean(error) && typeof error.code === 'string' && error.code.startsWith('SQLITE_BUSY');
}

/**
 * Point-in-time copy with `VACUUM INTO` on a read-only connection: one read
 * transaction, includes un-checkpointed WAL frames, and the output has no
 * -wal. Never copies the live file. Retries SQLITE_BUSY three times.
 */
async function snapshotDatabase(Database, dbPath, dest) {
  for (let attempt = 1; ; attempt += 1) {
    let db;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 10_000 });
      db.prepare('VACUUM INTO ?').run(dest);
      return;
    } catch (error) {
      fs.rmSync(dest, { force: true });
      if (!isBusy(error) || attempt > 3) throw error;
      await sleep(250 * attempt);
    } finally {
      db?.close();
    }
  }
}

/** Read-only integrity / quick check plus the `__drizzle_migrations` row count. */
function inspectDatabase(Database, file, check = 'integrity_check') {
  const db = new Database(file, { readonly: true, fileMustExist: true, timeout: 10_000 });
  try {
    const result = db.pragma(check, { simple: true });
    const hasTable =
      db
        .prepare(
          "select count(*) as n from sqlite_master where type = 'table' and name = '__drizzle_migrations'",
        )
        .get().n > 0;
    const migrations = hasTable
      ? db.prepare('select count(*) as n from __drizzle_migrations').get().n
      : 0;
    return { integrity: result === 'ok' ? 'ok' : 'failed', migrations };
  } finally {
    db.close();
  }
}

/** Number of migrations this checkout ships (`drizzle` journal entries). */
export function checkoutMigrationCount(repoRoot) {
  const file = path.join(repoRoot, 'src', 'lib', 'db', 'migrations', 'meta', '_journal.json');
  let journal;
  try {
    journal = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new CliError(
      EXIT.UNEXPECTED,
      'journal_missing',
      'the checkout has no readable migration journal (src/lib/db/migrations/meta/_journal.json)',
    );
  }
  if (!Array.isArray(journal?.entries)) {
    throw new CliError(EXIT.UNEXPECTED, 'journal_missing', 'the migration journal has no entries');
  }
  return journal.entries.length;
}

/** tar without a host `TAR_OPTIONS` injecting flags. */
function tarEnv() {
  const env = { ...process.env };
  delete env.TAR_OPTIONS;
  return env;
}

function assertTar() {
  const result = spawnSync('tar', ['--version'], { encoding: 'utf8', env: tarEnv() });
  if (result.error || result.status !== 0) {
    throw new CliError(
      EXIT.UNEXPECTED,
      'tar_missing',
      'tar was not found; install it (for example `sudo apt install tar`) and run this again',
    );
  }
}

function git(repoRoot, args) {
  return spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
    maxBuffer: BIG_BUFFER,
  });
}

function zList(result) {
  return result.status === 0 ? result.stdout.split('\0').filter(Boolean) : [];
}

/** `git status --porcelain=v1 -z` → `{ xy, path }` (a rename also yields its old path as `D`). */
function parseStatus(result) {
  const parts = result.stdout.split('\0');
  const out = [];
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    if (!entry) continue;
    const xy = entry.slice(0, 2);
    out.push({ xy, path: entry.slice(3) });
    if (xy[0] === 'R' || xy[0] === 'C') {
      i += 1;
      if (xy[0] === 'R' && parts[i]) out.push({ xy: 'D ', path: parts[i] });
    }
  }
  return out;
}

function gitStatus(repoRoot, pathspecs, { ignored = false } = {}) {
  const args = ['status', '--porcelain=v1', '-z', '--untracked-files=all'];
  if (ignored) args.push('--ignored=traditional');
  const result = git(repoRoot, [...args, '--', ...pathspecs]);
  if (result.error || result.status !== 0) {
    throw new CliError(EXIT.UNEXPECTED, 'git_failed', 'git status failed in the checkout');
  }
  return parseStatus(result);
}

/** `{ ok:true, head, branch }` or `{ ok:false, reason }` (no git / not the repo root / no commit). */
function gitCheckout(repoRoot) {
  const top = git(repoRoot, ['rev-parse', '--show-toplevel']);
  if (top.error) return { ok: false, reason: 'no_git' };
  if (top.status !== 0) {
    // e.g. "detected dubious ownership" when run as another user
    const notRepo = /not a git repository/i.test(top.stderr);
    return { ok: false, reason: notRepo ? 'not_a_git_checkout' : 'git_failed' };
  }
  if (canonical(top.stdout.trim()) !== canonical(repoRoot)) {
    return { ok: false, reason: 'not_a_git_checkout' };
  }
  const head = git(repoRoot, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
  if (head.status !== 0) return { ok: false, reason: 'no_head' };
  const branch = git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return {
    ok: true,
    head: head.stdout.trim(),
    branch: branch.status === 0 ? branch.stdout.trim() : null,
  };
}

function serverPorts(ctx) {
  const files = readProductionEnvFiles(ctx.repoRoot);
  const ports = [];
  for (const raw of [nonBlank(ctx.env.PORT), nonBlank(envFileValue(files, 'PORT')), '3000']) {
    const port = Number(raw);
    if (Number.isInteger(port) && port > 0 && port < 65536 && !ports.includes(port)) {
      ports.push(port);
    }
  }
  return ports;
}

/** First port whose `/api/health` answers with Examify's `{ ok: boolean }`, else null. */
export async function probeServer(ports) {
  for (const port of ports) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1500),
        redirect: 'manual',
      });
      const body = await response.json().catch(() => null);
      if (body && typeof body === 'object' && typeof body.ok === 'boolean') return port;
    } catch {
      // nothing listening
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// paths / init
// ---------------------------------------------------------------------------

export function paths(options = {}) {
  const { paths: resolved } = resolveContext(options);
  return {
    repoRoot: resolved.repoRoot,
    dataDir: resolved.dataDir,
    dataDirSource: resolved.dataDirSource,
    dbPath: resolved.dbPath,
    outboxDir: resolved.outboxDir,
    databaseUrlExplicit: resolved.databaseUrlExplicit,
  };
}

export function init(options = {}) {
  const ctx = resolveContext(options);
  assertOwnership(ctx, options);
  const { created } = initDataFolder(ctx.paths, {
    geteuid: options.geteuid ?? defaultGeteuid,
    warn: ctx.log,
  });
  return { dataDir: ctx.paths.dataDir, created };
}

// ---------------------------------------------------------------------------
// backup
// ---------------------------------------------------------------------------

const GENERATED_TREE = 'content/generated';

/**
 * sha256 of every file `filesUnder` would stage from `abs` (keyed by `rel`
 * paths), or null when a file vanished while hashing.
 */
function treeDigest(abs, rel) {
  try {
    return new Map(filesUnder(abs, rel).map((file) => [file.rel, sha256File(file.src)]));
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

function sameDigest(a, b) {
  if (!a || !b || a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

const BACKUP_FAMILY_TREES = [
  'content/subjects',
  'content/source-pdfs',
  'content/generated',
  '.examify-ingest/runs',
];

/** Catalog rows of a (staged) generated folder whose questions or keys file is missing. */
function catalogGaps(generatedDir) {
  const file = path.join(generatedDir, 'subjects.json');
  if (!fs.existsSync(file)) return [];
  let rows;
  try {
    rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return ['subjects.json is not valid JSON'];
  }
  if (!Array.isArray(rows)) return ['subjects.json is not a list'];
  const gaps = [];
  for (const row of rows) {
    const id = row && typeof row === 'object' ? row.id : undefined;
    if (typeof id !== 'string' || !SUBJECT_ID_RE.test(id)) {
      gaps.push('subjects.json has an invalid subject id');
      continue;
    }
    for (const dir of ['questions', 'keys']) {
      if (!isFile(path.join(generatedDir, dir, `${id}.json`))) gaps.push(`${dir}/${id}.json`);
    }
  }
  return gaps;
}

function resolveOutDir(ctx, out) {
  const { repoRoot, paths: resolved } = ctx;
  if (!out) {
    // `backups/` goes into the data folder: never into one shared with other
    // software (the folder of DATABASE_URL=file:/root/examify.db is $HOME).
    if (fs.existsSync(resolved.dataDir)) assertDedicatedFolder(resolved.dataDir, resolved.dbPath);
    fs.mkdirSync(resolved.dataDir, { recursive: true, mode: 0o700 });
    const dir = path.join(resolved.dataDir, 'backups');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = fs.statSync(dir);
    const uid = defaultGeteuid();
    if ((uid === undefined || st.uid === uid) && (st.mode & 0o777) !== 0o700) {
      fs.chmodSync(dir, 0o700);
    }
    return dir;
  }
  const dir = path.resolve(ctx.cwd, out);
  const inCheckout = contains(canonical(repoRoot), canonical(dir));
  if (inCheckout && !contains(canonical(resolved.dataDir), canonical(dir))) {
    throw new CliError(
      EXIT.USAGE,
      'usage',
      '--out must be outside the checkout (or inside the family data folder): archives hold secrets',
    );
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function archiveName(kind, sha) {
  const suffix = kind === 'pre-upgrade' ? `-pre-upgrade${sha ? `-${sha.slice(0, 7)}` : ''}` : '';
  return `examify-backup-${compactUtc(new Date())}-${randomHex(2)}${suffix}.tar.gz`;
}

/** The archive's MANIFEST.json text, or null when tar cannot read it. */
function readArchiveManifestText(archive) {
  const result = spawnSync('tar', ['-xOzf', archive, 'MANIFEST.json'], {
    encoding: 'utf8',
    env: tarEnv(),
    maxBuffer: BIG_BUFFER,
  });
  return result.error || result.status !== 0 ? null : result.stdout;
}

/**
 * Read the published archive back: the whole gzip stream lists, every
 * MANIFEST file is a member, and its MANIFEST.json is the one written. One
 * that does not is removed, so it is never reported as a backup.
 */
function verifyPublishedArchive(archive, manifest, manifestText) {
  const list = spawnSync('tar', ['-tzf', archive], {
    encoding: 'utf8',
    env: tarEnv(),
    maxBuffer: BIG_BUFFER,
  });
  const names =
    list.error || list.status !== 0
      ? null
      : new Set(list.stdout.split('\n').map((name) => name.replace(/^\.\//, '')));
  const intact =
    names !== null &&
    names.has('MANIFEST.json') &&
    manifest.files.every((file) => names.has(file.path)) &&
    readArchiveManifestText(archive) === manifestText;
  if (!intact) {
    fs.rmSync(archive, { force: true });
    throw new CliError(
      EXIT.UNEXPECTED,
      'archive_unreadable',
      'the archive did not read back intact (tar -tzf and its MANIFEST.json); it was removed, so there is no backup',
    );
  }
}

/** Publish without clobbering: link() + unlink(), rename() only where links are unsupported. */
function publishNoClobber(tmp, dir, makeName) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const dest = path.join(dir, makeName());
    try {
      fs.linkSync(tmp, dest);
      fs.unlinkSync(tmp);
      return dest;
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK'].includes(error.code)) throw error;
      if (fs.existsSync(dest)) continue;
      fs.renameSync(tmp, dest);
      return dest;
    }
  }
  throw new CliError(EXIT.UNEXPECTED, 'publish_failed', 'could not pick a free archive name');
}

export async function backup(options = {}) {
  const kind = options.kind ?? 'manual';
  if (!BACKUP_KINDS.includes(kind)) {
    throw new CliError(EXIT.USAGE, 'usage', '--kind must be manual or pre-upgrade');
  }
  const ctx = resolveContext(options);
  const { repoRoot, paths: resolved, log } = ctx;
  assertOwnership(ctx, options);
  assertTar();
  if (resolved.dbPath === ':memory:') {
    throw new CliError(
      EXIT.UNEXPECTED,
      'db_missing',
      'DATABASE_URL is :memory:; nothing to back up',
    );
  }
  if (!isFile(resolved.dbPath)) {
    throw new CliError(
      EXIT.UNEXPECTED,
      'db_missing',
      'the database file does not exist yet; nothing to back up (see `paths`)',
    );
  }
  const Database = loadSqlite(repoRoot, sqliteModuleOption(ctx, options));
  const outDir = resolveOutDir(ctx, options.out);
  const warnings = [];
  const warn = (line) => {
    warnings.push(line);
    log(`warning: ${line}`);
  };

  const staging = fs.mkdtempSync(path.join(outDir, '.staging-'));
  const tmp = path.join(outDir, `.examify-backup-${randomHex(6)}.partial`);
  const records = new Map();
  const stageFile = (src, rel) => {
    const { sha256, size } = copyFileHashed(src, fromPosix(staging, rel));
    records.set(rel, { path: rel, sha256, size });
    options.onFileStaged?.(rel);
  };
  const stageTree = (srcAbs, rel) => {
    for (const file of filesUnder(srcAbs, rel, warn)) stageFile(file.src, file.rel);
  };

  try {
    // 1. Database snapshot.
    const snapshot = fromPosix(staging, 'db/app.db');
    fs.mkdirSync(path.dirname(snapshot), { mode: 0o700 });
    await snapshotDatabase(Database, resolved.dbPath, snapshot);
    fs.chmodSync(snapshot, 0o600);
    const db = inspectDatabase(Database, snapshot);
    if (db.integrity !== 'ok') {
      throw new CliError(
        EXIT.UNEXPECTED,
        'integrity_failed',
        'the database snapshot failed integrity_check',
      );
    }
    const dbSha = sha256File(snapshot);
    records.set('db/app.db', {
      path: 'db/app.db',
      sha256: dbSha,
      size: fs.statSync(snapshot).size,
    });

    // 2. Family files (never outbox/ or backups/).
    const trees = [...BACKUP_FAMILY_TREES, 'migration-conflicts'].filter(
      (rel) => rel !== GENERATED_TREE,
    );
    if (options.includeCache) trees.push('.examify-ingest/cache');
    for (const rel of trees) stageTree(fromPosix(resolved.dataDir, rel), `family/${rel}`);
    const marker = path.join(resolved.dataDir, DATA_DIR_MARKER);
    if (isFile(marker)) stageFile(marker, `family/${DATA_DIR_MARKER}`);

    // content/generated as one revision: a wizard Apply may land mid-copy (no
    // cross-process lock), and questions/<id>.json from one Apply with
    // keys/<id>.json from another would mis-grade. Hash the source before and
    // after staging; the staged bytes must equal both, or it is staged again.
    const generatedSrc = fromPosix(resolved.dataDir, GENERATED_TREE);
    const generatedRel = `family/${GENERATED_TREE}`;
    const stagedGenerated = fromPosix(staging, generatedRel);
    for (let attempt = 1; ; attempt += 1) {
      fs.rmSync(stagedGenerated, { recursive: true, force: true });
      for (const key of [...records.keys()]) {
        if (key.startsWith(`${generatedRel}/`)) records.delete(key);
      }
      const before = treeDigest(generatedSrc, generatedRel);
      let copied = true;
      try {
        stageTree(generatedSrc, generatedRel);
      } catch (error) {
        if (!isEnoent(error)) throw error;
        copied = false; // a file went away mid-copy
      }
      const after = treeDigest(generatedSrc, generatedRel);
      const staged = new Map(
        [...records.values()]
          .filter((record) => record.path.startsWith(`${generatedRel}/`))
          .map((record) => [record.path, record.sha256]),
      );
      const stable = copied && sameDigest(before, after) && sameDigest(after, staged);
      const gaps = stable ? catalogGaps(stagedGenerated) : [];
      if (stable && gaps.length === 0) break;
      if (attempt >= 3) {
        if (!stable) {
          throw new CliError(
            EXIT.UNEXPECTED,
            'content_changing',
            'the family content changed while it was being backed up (an Apply in the wizard?); nothing was written, run the backup again',
          );
        }
        warn(`the family catalog is incomplete: ${gaps.join(', ')}`);
        break;
      }
      await sleep(200 * attempt);
    }

    // 3. Repo env files: every one `next start` reads (an install may be
    // configured only through .env.local or .env.production*).
    const envFiles = [];
    if (!options.noEnv) {
      for (const name of [...PRODUCTION_ENV_FILES].reverse()) {
        const src = path.join(repoRoot, name);
        if (!isFile(src)) continue;
        stageFile(src, `env/${name}`);
        envFiles.push(name);
      }
    }

    // 4. Pre-upgrade: everything family-ish still in the checkout.
    const gitInfo = gitCheckout(repoRoot);
    const gitSha = gitInfo.ok ? gitInfo.head : null;
    if (options.includeCheckout) {
      stageTree(path.join(repoRoot, 'content'), 'checkout/content');
      for (const rel of REGISTRARS) {
        const src = fromPosix(repoRoot, rel);
        if (isFile(src)) stageFile(src, `checkout/${rel}`);
      }
      for (const rel of ['.examify-ingest/runs', '.examify-ingest/cache/ir']) {
        stageTree(fromPosix(repoRoot, rel), `checkout/${rel}`);
      }
    }

    // 5. MANIFEST.json.
    let version = null;
    try {
      version =
        JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version ?? null;
    } catch {
      // keep null
    }
    const manifest = {
      format: 1,
      kind,
      createdAt: new Date().toISOString(),
      app: { version, gitSha, branch: gitInfo.ok ? gitInfo.branch : null },
      paths: { repoRoot, dataDir: resolved.dataDir, dbPath: resolved.dbPath },
      db: { file: 'db/app.db', sha256: dbSha, migrations: db.migrations, integrity: db.integrity },
      env: { included: envFiles.length > 0, files: envFiles },
      checkout: options.includeCheckout
        ? { included: true, ...(gitSha ? { gitSha } : {}) }
        : { included: false },
      files: [...records.values()].sort((a, b) => (a.path < b.path ? -1 : 1)),
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    fs.writeFileSync(path.join(staging, 'MANIFEST.json'), manifestText, { mode: 0o600 });

    // 6. tar into a 0600 temp file we created, fsync, publish without clobbering.
    // `db/app.db` by name: nothing next to the snapshot (-wal / -shm) is archived.
    const members = [
      'MANIFEST.json',
      'db/app.db',
      ...['family', 'env', 'checkout'].filter((dir) => fs.existsSync(path.join(staging, dir))),
    ];
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      const result = spawnSync('tar', ['-czf', '-', '-C', staging, ...members], {
        stdio: ['ignore', fd, 'pipe'],
        env: tarEnv(),
        maxBuffer: BIG_BUFFER,
      });
      if (result.error || result.status !== 0) {
        throw new CliError(EXIT.UNEXPECTED, 'tar_failed', 'tar could not write the archive');
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const archive = publishNoClobber(tmp, outDir, () => archiveName(kind, gitSha));
    fs.chmodSync(archive, 0o600);
    fsyncDir(outDir);
    verifyPublishedArchive(archive, manifest, manifestText);
    return {
      archive,
      verified: true,
      size: fs.statSync(archive).size,
      kind,
      createdAt: manifest.createdAt,
      db: { migrations: db.migrations, integrity: db.integrity },
      files: records.size,
      env: { included: manifest.env.included },
      checkout: { included: Boolean(options.includeCheckout) },
      warnings,
    };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(tmp, { force: true });
  }
}

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

const ARCHIVE_TOP = new Set(['MANIFEST.json', 'db', 'env', 'family', 'checkout']);
const FAMILY_PREFIXES = [
  'family/content/subjects/',
  'family/content/source-pdfs/',
  'family/content/generated/',
  'family/.examify-ingest/',
  'family/migration-conflicts/',
];
const CHECKOUT_PREFIXES = ['checkout/content/', 'checkout/.examify-ingest/'];

function invalidArchive(message) {
  return new CliError(EXIT.UNEXPECTED, 'archive_invalid', message);
}

/** A relative POSIX member path with no empty, `.` or `..` segment. */
function safeMemberPath(raw) {
  if (typeof raw !== 'string' || raw === '' || raw.includes('\0') || raw.startsWith('/')) {
    return null;
  }
  const parts = raw.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null;
  return raw;
}

function archiveArea(rel) {
  if (rel === 'db/app.db') return 'db';
  if (PRODUCTION_ENV_FILES.some((name) => rel === `env/${name}`)) return 'env';
  if (rel === `family/${DATA_DIR_MARKER}`) return 'family';
  if (FAMILY_PREFIXES.some((prefix) => rel.startsWith(prefix))) return 'family';
  if (REGISTRARS.some((reg) => rel === `checkout/${reg}`)) return 'checkout';
  if (CHECKOUT_PREFIXES.some((prefix) => rel.startsWith(prefix))) return 'checkout';
  return null;
}

/** List members before extracting: only regular files and folders, no absolute / `..` names. */
function checkArchiveMembers(archive) {
  const verbose = spawnSync('tar', ['-tvzf', archive], {
    encoding: 'utf8',
    env: tarEnv(),
    maxBuffer: BIG_BUFFER,
  });
  const names = spawnSync('tar', ['-tzf', archive], {
    encoding: 'utf8',
    env: tarEnv(),
    maxBuffer: BIG_BUFFER,
  });
  if (verbose.error || verbose.status !== 0 || names.error || names.status !== 0) {
    throw invalidArchive('the archive could not be read (not a gzipped tar?)');
  }
  for (const line of verbose.stdout.split('\n')) {
    if (line === '') continue;
    if (line[0] !== '-' && line[0] !== 'd') {
      throw invalidArchive('the archive holds a link or special file; refusing to extract it');
    }
  }
  for (const raw of names.stdout.split('\n')) {
    if (raw === '') continue;
    if (raw.startsWith('/')) throw invalidArchive('the archive holds an absolute path');
    let name = raw;
    while (name.startsWith('./')) name = name.slice(2);
    if (name === '' || name === '.') continue;
    const parts = name.replace(/\/+$/, '').split('/');
    if (parts.includes('..')) throw invalidArchive('the archive holds a path with ..');
    if (!ARCHIVE_TOP.has(parts[0])) throw invalidArchive('the archive holds an unexpected entry');
  }
}

/** After extraction: nothing but folders and regular files. */
function assertPlainTree(abs) {
  const st = fs.lstatSync(abs);
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(abs)) assertPlainTree(path.join(abs, name));
    return;
  }
  if (!st.isFile()) throw invalidArchive('the archive holds a link or special file');
}

function selectArchiveFiles(manifest, root, { withEnv, includeCheckout }) {
  if (!manifest || manifest.format !== 1 || !Array.isArray(manifest.files)) {
    throw invalidArchive('MANIFEST.json is missing or not an examify-data backup (format 1)');
  }
  const selected = {
    db: null,
    family: [],
    env: [],
    checkout: [],
    skipped: { env: 0, checkout: 0 },
  };
  const seen = new Set();
  for (const entry of manifest.files) {
    const rel = safeMemberPath(entry?.path);
    if (
      !rel ||
      seen.has(rel) ||
      typeof entry.sha256 !== 'string' ||
      !Number.isSafeInteger(entry.size)
    ) {
      throw invalidArchive('MANIFEST.json lists an invalid file entry');
    }
    seen.add(rel);
    const area = archiveArea(rel);
    if (!area) throw invalidArchive('MANIFEST.json lists a file outside the allowed folders');
    if (area === 'env' && !withEnv) {
      selected.skipped.env += 1;
      continue;
    }
    if (area === 'checkout' && !includeCheckout) {
      selected.skipped.checkout += 1;
      continue;
    }
    const abs = fromPosix(root, rel);
    const st = lstatOrNull(abs);
    if (!st || !st.isFile()) throw invalidArchive('a file listed in MANIFEST.json is missing');
    if (st.size !== entry.size || sha256File(abs) !== entry.sha256) {
      throw invalidArchive('a file does not match its MANIFEST.json hash');
    }
    const item = { rel, abs, sha256: entry.sha256 };
    if (area === 'db') selected.db = item;
    else selected[area].push(item);
  }
  if (!selected.db) throw invalidArchive('the archive has no database snapshot');
  return selected;
}

/** What a restore would replace: DB files and family content (not backups/ or outbox/). */
function restoreTargetContents(resolved) {
  const present = [];
  if (resolved.dbPath !== ':memory:') {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      if (lstatOrNull(resolved.dbPath + suffix))
        present.push({ kind: 'db', abs: resolved.dbPath + suffix });
    }
  }
  for (const name of FAMILY_ENTRIES) {
    const abs = path.join(resolved.dataDir, name);
    if (hasAnyEntry(abs)) present.push({ kind: 'family', abs, name });
  }
  return present;
}

function uniquePath(base) {
  if (!lstatOrNull(base)) return base;
  for (;;) {
    const candidate = `${base}-${randomHex(2)}`;
    if (!lstatOrNull(candidate)) return candidate;
  }
}

function movePath(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  try {
    fs.renameSync(src, dest);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    fs.cpSync(src, dest, {
      recursive: true,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
    });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

/** Move the current DB + family content into `dir` (`$DATA/before-restore-<ts>/`, never backups/). */
function moveAside(resolved, present, dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const item of present) {
    if (item.kind === 'db') movePath(item.abs, path.join(dir, 'db', path.basename(item.abs)));
  }
  for (const name of [...FAMILY_ENTRIES, DATA_DIR_MARKER, MIGRATE_JOURNAL]) {
    const abs = path.join(resolved.dataDir, name);
    if (lstatOrNull(abs)) movePath(abs, path.join(dir, name));
  }
}

function placeVerified(item, dest, modes) {
  const written = copyFileHashed(item.abs, dest, modes);
  if (written.sha256 !== item.sha256) {
    throw new CliError(EXIT.UNEXPECTED, 'copy_failed', 'a restored file did not match its hash');
  }
}

/** Refuse to write through a symlinked folder inside `base`. */
function assertNoSymlinkParents(base, dest) {
  const rel = path.relative(base, path.dirname(dest));
  let cursor = base;
  for (const part of rel === '' ? [] : rel.split(path.sep)) {
    cursor = path.join(cursor, part);
    const st = lstatOrNull(cursor);
    if (!st) return;
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new CliError(
        EXIT.UNEXPECTED,
        'symlink_in_checkout',
        `refusing to write through ${toPosix(path.relative(base, cursor))} (a symlink or file)`,
      );
    }
  }
}

function isKeysPath(rel) {
  return rel.startsWith('content/generated/keys/') || rel.includes('/content/generated/keys/');
}

/**
 * The paths `next start` will resolve once the archived env files replace the
 * current ones: non-blank process env, then `.env.production.local` >
 * `.env.local` > `.env.production` > `.env`, each the archived copy when the
 * archive carries it, else the file already in the checkout.
 */
function restoredEnvDataPaths(repoRoot, processEnv, envItems) {
  const archived = new Map(
    envItems.map((item) => [item.rel.slice('env/'.length), readEnvFile(item.abs)]),
  );
  const files = PRODUCTION_ENV_FILES.map(
    (name) => archived.get(name) ?? readEnvFile(path.join(repoRoot, name)),
  );
  return unsafeAsCliError(
    () => dataPathsFromFiles(repoRoot, files, processEnv),
    'the archived env files name an unsafe family data folder: ',
  );
}

/** Remove `dir` and its parents up to `firstCreated` (what mkdir made) while they are empty. */
function removeCreatedIfEmpty(dir, firstCreated) {
  if (!firstCreated) return;
  let cursor = dir;
  for (;;) {
    try {
      fs.rmdirSync(cursor);
    } catch {
      return; // not empty (or already gone)
    }
    if (cursor === firstCreated) return;
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

function samePlace(a, b) {
  return a.dbPath === b.dbPath && canonical(a.dataDir) === canonical(b.dataDir);
}

export async function restore(options = {}) {
  if (!options.archive) throw new CliError(EXIT.USAGE, 'usage', 'restore needs an archive path');
  const ctx = resolveContext(options);
  const { repoRoot, paths: current } = ctx;
  const archive = path.resolve(ctx.cwd, options.archive);
  if (!isFile(archive)) {
    throw new CliError(
      EXIT.UNEXPECTED,
      'archive_missing',
      'the archive does not exist or is not a file',
    );
  }
  assertOwnership(ctx, options);
  assertTar();
  const runningPort = await (options.probe ?? probeServer)(serverPorts(ctx));
  if (runningPort !== null) {
    throw new CliError(
      EXIT.REFUSED,
      'server_running',
      `Examify is answering on port ${runningPort}; stop the server before restoring`,
    );
  }
  const Database = loadSqlite(repoRoot, sqliteModuleOption(ctx, options));
  // With --with-env (and no --data-dir) the archived env files decide where
  // the app will look, so the target is settled after reading the archive.
  const targetFollowsEnv = Boolean(options.withEnv) && options.dataDir === undefined;
  const memoryTarget = () =>
    new CliError(EXIT.UNEXPECTED, 'db_missing', 'DATABASE_URL is :memory:; nowhere to restore to');
  if (current.dbPath === ':memory:' && !targetFollowsEnv) throw memoryTarget();

  // Staging lives in the current folder; one created just for it goes again if it ends up empty.
  // Never stage (a copy of an archive holding secrets) inside a folder shared with other software.
  if (fs.existsSync(current.dataDir)) assertDedicatedFolder(current.dataDir, current.dbPath);
  const createdForStaging = fs.mkdirSync(current.dataDir, { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(current.dataDir, '.restore-staging-'));
  try {
    // 1. Private copy, member check, extraction, MANIFEST + hash verification.
    const copy = path.join(staging, 'archive.tar.gz');
    fs.copyFileSync(archive, copy);
    fs.chmodSync(copy, 0o600);
    checkArchiveMembers(copy);
    const root = path.join(staging, 'x');
    fs.mkdirSync(root, { mode: 0o700 });
    const extract = spawnSync(
      'tar',
      ['-xzf', copy, '-C', root, '--no-same-owner', '--no-same-permissions'],
      { encoding: 'utf8', env: tarEnv(), maxBuffer: BIG_BUFFER },
    );
    if (extract.error || extract.status !== 0)
      throw invalidArchive('tar could not extract the archive');
    assertPlainTree(root);
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(root, 'MANIFEST.json'), 'utf8'));
    } catch {
      throw invalidArchive('MANIFEST.json is missing or not valid JSON');
    }
    const selected = selectArchiveFiles(manifest, root, {
      withEnv: Boolean(options.withEnv),
      includeCheckout: Boolean(options.includeCheckout),
    });

    // 2. The snapshot must be sound and not newer than this checkout.
    const snapshot = inspectDatabase(Database, selected.db.abs);
    if (snapshot.integrity !== 'ok')
      throw invalidArchive('the database snapshot failed integrity_check');
    const known = checkoutMigrationCount(repoRoot);
    if (snapshot.migrations > known) {
      throw new CliError(
        EXIT.REFUSED,
        'newer_snapshot',
        `this backup comes from a newer Examify (${snapshot.migrations} migrations; this checkout has ${known}); update the checkout first`,
      );
    }

    // 3. The target: where the app will look after this restore, checked like any other.
    let target = current;
    let targetSource = options.dataDir === undefined ? 'env' : 'data-dir';
    if (targetFollowsEnv && selected.env.length > 0) {
      target = restoredEnvDataPaths(repoRoot, ctx.env, selected.env);
      targetSource = 'restored-env';
    }
    if (target.dbPath === ':memory:') throw memoryTarget();
    if (target !== current) assertOwnership({ repoRoot, paths: target }, options);
    if (fs.existsSync(target.dataDir)) assertDedicatedFolder(target.dataDir, target.dbPath);

    // 4. Refuse a non-empty target unless --force.
    const present = restoreTargetContents(target);
    if (present.length > 0 && !options.force) {
      const what = present.map((item) =>
        item.kind === 'db' ? path.basename(item.abs) : `${item.name}/`,
      );
      throw new CliError(
        EXIT.REFUSED,
        'target_not_empty',
        `the target already holds ${[...new Set(what)].join(', ')}; pass --force to move it aside first`,
        { present: [...new Set(what)] },
      );
    }

    // Checkout destinations are checked before anything moves.
    const checkoutItems = selected.checkout.map((item) => {
      const rel = item.rel.slice('checkout/'.length);
      const dest = fromPosix(repoRoot, rel);
      assertNoSymlinkParents(repoRoot, dest);
      return { item, rel, dest };
    });

    // 5. Point of no return: move aside, then place. A failure from here on
    // names where the replaced data went.
    const ts = compactUtc(new Date());
    const movedAside =
      present.length > 0 ? uniquePath(path.join(target.dataDir, `before-restore-${ts}`)) : null;
    const envRestored = [];
    const envSaved = [];
    try {
      fs.mkdirSync(target.dataDir, { recursive: true, mode: 0o700 });
      if (movedAside) moveAside(target, present, movedAside);

      for (const suffix of ['-wal', '-shm', '-journal'])
        fs.rmSync(target.dbPath + suffix, { force: true });
      placeVerified(selected.db, target.dbPath);

      for (const item of selected.family) {
        placeVerified(item, fromPosix(target.dataDir, item.rel.slice('family/'.length)));
      }

      for (const item of selected.env) {
        const name = item.rel.slice('env/'.length);
        const dest = path.join(repoRoot, name);
        if (lstatOrNull(dest)) {
          // `.env.*.local` is gitignored in every Examify checkout, old ones included.
          const saved = uniquePath(path.join(repoRoot, `${name}.before-restore-${ts}.local`));
          fs.copyFileSync(dest, saved, fs.constants.COPYFILE_EXCL);
          fs.chmodSync(saved, 0o600);
          envSaved.push(saved);
        }
        placeVerified(item, dest, { mode: 0o600, dirMode: 0o755 });
        envRestored.push(name);
      }

      for (const { item, rel, dest } of checkoutItems) {
        placeVerified(item, dest, { mode: isKeysPath(rel) ? 0o600 : 0o644, dirMode: 0o755 });
      }
    } catch (error) {
      if (!movedAside || !lstatOrNull(movedAside)) throw error;
      const cli = error instanceof CliError ? error : null;
      throw new CliError(
        cli?.exitCode ?? EXIT.UNEXPECTED,
        cli?.code ?? 'restore_failed',
        `${error instanceof Error ? error.message : String(error)}; the data this restore replaced is in ${movedAside}`,
        { ...cli?.extra, movedAside, envSaved },
      );
    }

    // Everything is in place: the folder was vetted above (its marker may be
    // aside now), and a failure to finish initialising it is only a warning.
    const warnings = [];
    try {
      initDataFolder(target, {
        geteuid: options.geteuid ?? defaultGeteuid,
        warn: ctx.log,
        vetted: true,
      });
    } catch (error) {
      const line = `the data folder was restored but not fully initialised (${error instanceof Error ? error.message : String(error)}); pnpm db:migrate finishes it`;
      warnings.push(line);
      ctx.log(`warning: ${line}`);
    }
    return {
      dataDir: target.dataDir,
      dbPath: target.dbPath,
      target: {
        source: targetSource,
        before: { dataDir: current.dataDir, dbPath: current.dbPath },
        after: { dataDir: target.dataDir, dbPath: target.dbPath },
        changed: !samePlace(current, target),
      },
      migrations: { snapshot: snapshot.migrations, checkout: known },
      restored: {
        db: true,
        familyFiles: selected.family.length,
        env: envRestored,
        checkoutFiles: selected.checkout.length,
      },
      archiveHasEnv: selected.env.length + selected.skipped.env > 0,
      movedAside,
      envSaved,
      warnings,
    };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    removeCreatedIfEmpty(current.dataDir, createdForStaging);
  }
}

// ---------------------------------------------------------------------------
// legacy-check / migrate-checkout
// ---------------------------------------------------------------------------

const RESTORE_PATHS = ['content/subjects', 'content/generated', ...REGISTRARS];
/** Folders that must not survive in the checkout, even holding only empty folders or OS junk. */
const LEFTOVER_DIRS = ['content/source-pdfs', '.examify-ingest'];
const CONFLICT_STATES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/** lstat walk: leaves are files, symlinks (never followed) and special files. */
function listLeaves(abs, rel) {
  const st = lstatOrNull(abs);
  if (!st) return [];
  if (st.isSymbolicLink())
    return [{ rel, abs, type: 'link', junk: isJunkName(path.basename(abs)) }];
  if (st.isFile()) return [{ rel, abs, type: 'file', junk: isJunkName(path.basename(abs)) }];
  if (!st.isDirectory()) return [{ rel, abs, type: 'special', junk: false }];
  const out = [];
  for (const name of fs.readdirSync(abs).sort()) {
    out.push(...listLeaves(path.join(abs, name), `${rel}/${name}`));
  }
  return out;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(
    (key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]),
  );
}

function parseCatalog(text) {
  try {
    const rows = JSON.parse(text);
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

function validRow(row, id) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const { label, icon, l, c, h } = row;
  if (row.id !== id || typeof label !== 'string' || !label || typeof icon !== 'string' || !icon) {
    return null;
  }
  if (![l, c, h].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  return { id, label, icon, l, c, h };
}

/** A missing catalog row, rebuilt from the IR subject block or subject.json. */
function rebuildRow(repoRoot, id) {
  const dir = path.join(repoRoot, 'content', 'subjects', id);
  const sources = [
    ['bank.ir.json', (json) => json?.subject],
    ['subject.json', (json) => json],
  ];
  for (const [file, pick] of sources) {
    try {
      const row = validRow(pick(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))), id);
      if (row) return { row, source: file };
    } catch {
      // try the next source
    }
  }
  return null;
}

function pdfSubjectId(rel) {
  const rest = rel.slice('content/source-pdfs/'.length).split('/');
  const id = rest.length > 1 ? rest[0] : rest[0].replace(/\.[^.]*$/, '');
  return SUBJECT_ID_RE.test(id) ? id : null;
}

/**
 * M1: classify what the old runtime left in the checkout. Read-only.
 * Returns `{ checked:false, reason }` when git cannot answer.
 */
export function planMigrateCheckout(repoRoot) {
  const gitInfo = gitCheckout(repoRoot);
  if (!gitInfo.ok) return { checked: false, reason: gitInfo.reason };

  const headFiles = new Set(
    zList(
      git(repoRoot, ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', 'content', ...REGISTRARS]),
    ),
  );
  const indexFiles = new Set(
    zList(git(repoRoot, ['ls-files', '-z', '--', 'content', '.examify-ingest', ...REGISTRARS])),
  );
  const status = gitStatus(repoRoot, ['content', '.examify-ingest', ...REGISTRARS], {
    ignored: true,
  });
  const modified = new Set();
  const blocking = [];
  let restoreTracked = false;
  const restoredTracked = [];
  for (const { xy, path: rel } of status) {
    if (xy === '??' || xy === '!!') continue;
    if (CONFLICT_STATES.has(xy)) {
      blocking.push({ path: rel, reason: 'unmerged' });
      continue;
    }
    const underRestore = RESTORE_PATHS.some((p) => rel === p || rel.startsWith(`${p}/`));
    if (!underRestore) {
      if (!rel.startsWith('.examify-ingest/'))
        blocking.push({
          path: rel,
          reason: 'tracked change outside content/subjects and content/generated',
        });
      continue;
    }
    restoreTracked = true;
    if (headFiles.has(rel)) {
      modified.add(rel);
      restoredTracked.push(rel);
    }
  }
  // Hand edits next to the registrars are not family content, but M5 needs
  // src/lib/exam clean, so they block an actual migration (not legacy-check).
  const examChanges = [];
  for (const { xy, path: rel } of gitStatus(repoRoot, ['src/lib/exam'])) {
    if (REGISTRARS.includes(rel) && xy !== '??') continue;
    examChanges.push({ path: rel, reason: 'uncommitted change in src/lib/exam; commit it first' });
  }

  const leaves = [
    ...listLeaves(path.join(repoRoot, 'content'), 'content'),
    ...listLeaves(path.join(repoRoot, '.examify-ingest'), '.examify-ingest'),
  ];
  const byArea = { subjects: [], pdfs: [], generated: [], ingest: [], other: [] };
  for (const leaf of leaves) {
    leaf.inIndex = indexFiles.has(leaf.rel);
    leaf.state = headFiles.has(leaf.rel) ? (modified.has(leaf.rel) ? 'modified' : 'clean') : 'new';
    // OS junk is never family content; pruning removes it from folders that empty out.
    if (leaf.junk) continue;
    if (leaf.type === 'special') {
      blocking.push({ path: leaf.rel, reason: 'special file' });
      continue;
    }
    if (leaf.type === 'link' && !fs.existsSync(leaf.abs)) {
      blocking.push({ path: leaf.rel, reason: 'broken symlink; remove it' });
      continue;
    }
    const { rel } = leaf;
    if (rel.startsWith('content/subjects/')) byArea.subjects.push(leaf);
    else if (rel === 'content/source-pdfs' || rel.startsWith('content/source-pdfs/'))
      byArea.pdfs.push(leaf);
    else if (rel.startsWith('content/generated/')) byArea.generated.push(leaf);
    else if (rel === '.examify-ingest' || rel.startsWith('.examify-ingest/'))
      byArea.ingest.push(leaf);
    else byArea.other.push(leaf);
  }

  // Copies (checkout → same relative path in $DATA), unlinks, orphans.
  const copies = [];
  const unlinks = [];
  const orphans = [];
  const addLeaf = (leaf, { target = 'data', unlink = !leaf.inIndex, kind = 'file' } = {}) => {
    const files =
      leaf.type === 'link' ? filesUnder(leaf.abs, leaf.rel) : [{ src: leaf.abs, rel: leaf.rel }];
    const items = files.map((file) => ({ src: file.src, rel: file.rel, target, kind }));
    copies.push(...items);
    if (unlink) unlinks.push({ abs: leaf.abs, rel: leaf.rel, type: leaf.type, copies: items });
    return items;
  };
  const addOrphan = (leaf) => {
    // A committed file the old runtime never wrote (a README upstream added):
    // not family content, and `git checkout HEAD` leaves it as it is.
    if (leaf.inIndex && leaf.state === 'clean') return;
    if (leaf.inIndex) {
      blocking.push({
        path: leaf.rel,
        reason: 'staged file with no place in the family data folder',
      });
      return;
    }
    orphans.push(leaf.rel);
    addLeaf(leaf, { target: 'conflict', kind: 'orphan' });
  };

  // Subjects.
  const subjectLeaves = new Map();
  const presentDirs = new Set();
  for (const leaf of byArea.subjects) {
    const parts = leaf.rel.split('/');
    const id = parts[2];
    const dirLink =
      parts.length === 3 && leaf.type === 'link' && fs.statSync(leaf.abs).isDirectory();
    if (parts.length === 3 && !dirLink) {
      addOrphan(leaf);
      continue;
    }
    presentDirs.add(id);
    if (!SUBJECT_ID_RE.test(id)) {
      addOrphan(leaf);
      continue;
    }
    if (!subjectLeaves.has(id)) subjectLeaves.set(id, []);
    subjectLeaves.get(id).push(leaf);
  }
  const committedIds = new Set();
  for (const rel of headFiles) {
    const parts = rel.split('/');
    if (parts[0] === 'content' && parts[1] === 'subjects' && parts.length > 3)
      committedIds.add(parts[2]);
  }
  const hiddenCommitted = [...committedIds].filter((id) => !presentDirs.has(id)).sort();
  if (hiddenCommitted.length > 0) restoreTracked = true;
  const subjects = new Map();
  for (const [id, idLeaves] of subjectLeaves) {
    const committed = committedIds.has(id);
    const changed = idLeaves.some((leaf) => leaf.state !== 'clean');
    if (!committed) subjects.set(id, 'new');
    else if (changed) subjects.set(id, 'changed');
  }

  // Source PDFs (everything) and ingest state (whole tree).
  const pdfIds = new Set();
  let sourcePdfFiles = 0;
  for (const leaf of byArea.pdfs) {
    for (const item of addLeaf(leaf)) {
      sourcePdfFiles += 1;
      const id = pdfSubjectId(item.rel);
      if (id) pdfIds.add(id);
    }
  }
  let ingestFiles = 0;
  for (const leaf of byArea.ingest) ingestFiles += addLeaf(leaf).length;

  // Generated: catalog rows by id against HEAD, plus changed questions / keys files.
  const catalogRel = 'content/generated/subjects.json';
  const catalogPath = fromPosix(repoRoot, catalogRel);
  let workingRows = [];
  let catalogUnreadable = false;
  if (fs.existsSync(catalogPath)) {
    const rows = parseCatalog(fs.readFileSync(catalogPath, 'utf8'));
    if (rows) workingRows = rows;
    else catalogUnreadable = true;
  }
  const headShow = git(repoRoot, ['show', `HEAD:${catalogRel}`]);
  const headRows = headShow.status === 0 ? (parseCatalog(headShow.stdout) ?? []) : [];
  const headById = new Map();
  for (const row of headRows) if (row && typeof row.id === 'string') headById.set(row.id, row);
  const workingById = new Map();
  let invalidCatalogRows = 0;
  const generatedIds = new Set();
  for (const row of workingRows) {
    const id = row && typeof row === 'object' ? row.id : undefined;
    if (typeof id !== 'string' || !SUBJECT_ID_RE.test(id) || workingById.has(id)) {
      invalidCatalogRows += 1;
      continue;
    }
    workingById.set(id, row);
    if (!headById.has(id) || !deepEqual(headById.get(id), row)) generatedIds.add(id);
  }
  const generatedLeaves = new Map();
  for (const leaf of byArea.generated) {
    const rest = leaf.rel.slice('content/generated/'.length).split('/');
    if (rest.length === 1 && headFiles.has(leaf.rel)) {
      // A tracked top-level file (subjects.json, README.md): git checkout restores it.
      // A corrupt catalog is kept in migration-conflicts as well as in the backup.
      if (leaf.rel === catalogRel && catalogUnreadable) {
        orphans.push(leaf.rel);
        addLeaf(leaf, { target: 'conflict', unlink: false, kind: 'orphan' });
      }
      continue;
    }
    const match =
      rest.length === 2 && /^(questions|keys)$/.test(rest[0]) && /^(.+)\.json$/.exec(rest[1]);
    if (!match || !SUBJECT_ID_RE.test(match[1]) || (leaf.type === 'link' && !isFile(leaf.abs))) {
      addOrphan(leaf);
      continue;
    }
    generatedLeaves.set(leaf.rel, leaf);
    if (leaf.state !== 'clean') generatedIds.add(match[1]);
  }
  const generated = [];
  const incompleteGenerated = [];
  // Working catalog order first (tiles keep their order), then rebuilt rows.
  const orderedIds = [
    ...[...workingById.keys()].filter((id) => generatedIds.has(id)),
    ...[...generatedIds].filter((id) => !workingById.has(id)).sort(),
  ];
  for (const id of orderedIds) {
    const qRel = `content/generated/questions/${id}.json`;
    const kRel = `content/generated/keys/${id}.json`;
    const q = generatedLeaves.get(qRel);
    const k = generatedLeaves.get(kRel);
    const working = workingById.has(id) ? validRow(workingById.get(id), id) : null;
    const rebuilt = working ? null : rebuildRow(repoRoot, id);
    const row = working ?? rebuilt?.row ?? null;
    if (!row || !q || !k) {
      const missing = [!row && 'catalog row', !q && 'questions', !k && 'keys'].filter(Boolean);
      incompleteGenerated.push({ id, missing });
      for (const leaf of [q, k]) if (leaf && leaf.state === 'new') addOrphan(leaf);
      continue;
    }
    generated.push({
      id,
      row,
      rowSource: working ? 'catalog' : rebuilt.source,
      files: [q, k].map((leaf) => addLeaf(leaf, { kind: 'generated' })[0]),
    });
  }

  // A committed subject with family PDFs or generated rows keeps its tracked dir in $DATA too.
  for (const id of [...pdfIds, ...generated.map((entry) => entry.id)]) {
    if (committedIds.has(id) && subjectLeaves.has(id) && !subjects.has(id)) {
      subjects.set(id, 'has-family-content');
    }
  }
  for (const [id] of [...subjects].sort()) {
    for (const leaf of subjectLeaves.get(id)) addLeaf(leaf);
  }

  // Anything else under content/: untracked → migration-conflicts; tracked → blocking.
  for (const leaf of byArea.other) {
    if (leaf.state === 'clean') continue;
    addOrphan(leaf);
  }

  // Folders that must not survive in the checkout even when they only hold OS junk.
  const leftoverDirs = LEFTOVER_DIRS.filter((rel) =>
    lstatOrNull(fromPosix(repoRoot, rel))?.isDirectory(),
  );

  const registrars = restoredTracked.filter((rel) => REGISTRARS.includes(rel));
  return {
    checked: true,
    fromSha: gitInfo.head,
    subjects: [...subjects].sort().map(([id, reason]) => ({ id, reason })),
    generated: generated.map(({ id, rowSource }) => ({ id, rowSource })),
    generatedPlan: generated,
    sourcePdfFiles,
    ingestFiles,
    registrars,
    restoredTracked: restoredTracked.filter((rel) => !REGISTRARS.includes(rel)),
    restoreTracked,
    hiddenCommitted,
    orphans,
    incompleteGenerated,
    invalidCatalogRows,
    leftoverDirs,
    blocking,
    examChanges,
    copies,
    unlinks,
  };
}

/** Summary list of what a plan would move / restore (empty ⇒ the checkout is clean). */
function legacyItems(plan) {
  const items = [];
  for (const { id } of plan.subjects)
    items.push({ kind: 'subject', path: `content/subjects/${id}` });
  for (const { id } of plan.generated)
    items.push({ kind: 'generated', path: `content/generated (${id})` });
  if (plan.sourcePdfFiles > 0) {
    items.push({ kind: 'source-pdfs', path: 'content/source-pdfs', files: plan.sourcePdfFiles });
  }
  if (plan.ingestFiles > 0) {
    items.push({ kind: 'ingest-state', path: '.examify-ingest', files: plan.ingestFiles });
  }
  for (const rel of plan.leftoverDirs) {
    const counted = rel === '.examify-ingest' ? plan.ingestFiles : plan.sourcePdfFiles;
    if (counted === 0) items.push({ kind: 'leftover-folder', path: rel });
  }
  for (const rel of plan.registrars) items.push({ kind: 'registrar', path: rel });
  for (const id of plan.hiddenCommitted) {
    items.push({ kind: 'deleted-built-in', path: `content/subjects/${id}` });
  }
  const covered = new Set([
    ...plan.subjects.map(({ id }) => `content/subjects/${id}/`),
    ...plan.generated.map(({ id }) => `content/generated/questions/${id}.json`),
    ...plan.generated.map(({ id }) => `content/generated/keys/${id}.json`),
  ]);
  for (const rel of plan.restoredTracked) {
    if (rel === 'content/generated/subjects.json' && plan.generated.length > 0) continue;
    if ([...covered].some((prefix) => rel === prefix || rel.startsWith(prefix))) continue;
    if (plan.hiddenCommitted.some((id) => rel.startsWith(`content/subjects/${id}/`))) continue;
    items.push({ kind: 'tracked-change', path: rel });
  }
  for (const { id, missing } of plan.incompleteGenerated) {
    items.push({ kind: 'incomplete-generated', path: `content/generated (${id})`, missing });
  }
  for (const rel of plan.orphans) items.push({ kind: 'unrecognised', path: rel });
  for (const { path: rel, reason } of plan.blocking)
    items.push({ kind: 'blocking', path: rel, reason });
  return items;
}

/**
 * Family content still inside the checkout (what `migrate-checkout` would
 * move). `checked:false` when git is unavailable or this is not the repo root.
 */
export function detectLegacyCheckoutContent(repoRoot) {
  const plan = planMigrateCheckout(repoRoot);
  if (!plan.checked) return { checked: false, reason: plan.reason, legacy: false, items: [] };
  const items = legacyItems(plan);
  return { checked: true, legacy: items.length > 0, items };
}

export function legacyCheck(options = {}) {
  const ctx = resolveContext(options);
  const result = detectLegacyCheckoutContent(ctx.repoRoot);
  return { ...result, exitCode: result.legacy ? EXIT.LEGACY_CONTENT : EXIT.OK };
}

function loadJournal(dataDir) {
  try {
    const journal = JSON.parse(fs.readFileSync(path.join(dataDir, MIGRATE_JOURNAL), 'utf8'));
    if (journal?.id === MIGRATION_ID && journal.written && typeof journal.written === 'object') {
      return { ...journal, resumed: true };
    }
  } catch {
    // missing or unreadable: start a fresh journal
  }
  return { id: MIGRATION_ID, startedAt: new Date().toISOString(), written: {}, resumed: false };
}

function saveJournal(dataDir, journal) {
  const { resumed: _resumed, ...body } = journal;
  writeFileAtomic(path.join(dataDir, MIGRATE_JOURNAL), `${JSON.stringify(body, null, 2)}\n`);
}

/**
 * Destination state for one planned copy: `copy` (absent), `same`,
 * `overwrite` (still exactly what an unfinished earlier run wrote) or
 * `conflict` (someone else's differing file — never overwritten).
 */
function destinationState(dest, rel, srcSha, journal) {
  const st = lstatOrNull(dest);
  if (!st) return 'copy';
  if (!st.isFile()) return 'conflict';
  const destSha = sha256File(dest);
  if (destSha === srcSha) return 'same';
  if (journal.written[rel] === destSha) return 'overwrite';
  return 'conflict';
}

function modeFor(rel) {
  return isKeysPath(rel) ? 0o600 : 0o644;
}

/**
 * The folder a pruned path belongs to: one subject, one generated area, the
 * source PDFs or the ingest state (else the folder itself).
 */
function pruneRoot(repoRoot, dir) {
  const parts = toPosix(path.relative(repoRoot, dir)).split('/');
  if (parts[0] === 'content' && ['subjects', 'generated'].includes(parts[1]) && parts.length > 2) {
    return fromPosix(repoRoot, parts.slice(0, 3).join('/'));
  }
  if (parts[0] === 'content' && parts[1] === 'source-pdfs') {
    return fromPosix(repoRoot, 'content/source-pdfs');
  }
  if (parts[0] === '.examify-ingest') return fromPosix(repoRoot, '.examify-ingest');
  return dir;
}

/**
 * Remove `dir` and every folder under it that holds nothing but OS junk and
 * folders removed here, bottom-up and never through a symlink (lstat). True
 * when `dir` is gone.
 */
function pruneTree(dir) {
  const st = lstatOrNull(dir);
  if (!st || !st.isDirectory()) return false;
  let keep = false;
  for (const name of fs.readdirSync(dir)) {
    const child = lstatOrNull(path.join(dir, name));
    if (!child) continue;
    if (child.isDirectory()) {
      if (!pruneTree(path.join(dir, name))) keep = true;
    } else if (!isJunkName(name)) {
      keep = true;
    }
  }
  if (keep) return false;
  for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name));
  fs.rmdirSync(dir);
  return true;
}

/**
 * Remove folders that emptied out (OS junk alone does not keep a folder
 * alive): each touched area as a whole — nested empty folders included, such
 * as the subject folder a detached upload left behind — then parents, deepest
 * first. Never the checkout root, content/, subjects/ or generated/, and never
 * through a symlinked folder. Returns the removed area roots (relative).
 */
function pruneEmptyDirs(repoRoot, dirs) {
  const stop = new Set(
    ['content', 'content/subjects', 'content/generated'].map((rel) => fromPosix(repoRoot, rel)),
  );
  const inside = (dir) => dir.startsWith(`${repoRoot}${path.sep}`) && !stop.has(dir);
  const removed = [];
  for (const root of new Set([...dirs].map((dir) => pruneRoot(repoRoot, dir)))) {
    if (!inside(root) || !realParents(repoRoot, root)) continue;
    if (pruneTree(root)) removed.push(toPosix(path.relative(repoRoot, root)));
  }
  const all = new Set();
  for (const dir of dirs) {
    let cursor = dir;
    while (cursor !== repoRoot && inside(cursor)) {
      all.add(cursor);
      cursor = path.dirname(cursor);
    }
  }
  for (const dir of [...all].sort((a, b) => b.length - a.length)) {
    const st = lstatOrNull(dir);
    if (!st || !st.isDirectory() || !realParents(repoRoot, dir)) continue;
    const names = fs.readdirSync(dir);
    const onlyJunk = names.every(
      (name) => isJunkName(name) && !lstatOrNull(path.join(dir, name))?.isDirectory(),
    );
    if (!onlyJunk) continue;
    for (const name of names) fs.unlinkSync(path.join(dir, name));
    fs.rmdirSync(dir);
  }
  return removed;
}

/** Every folder between the checkout root and `abs` is a real folder (no symlink). */
function realParents(repoRoot, abs) {
  let cursor = path.dirname(abs);
  while (cursor !== repoRoot) {
    if (!cursor.startsWith(`${repoRoot}${path.sep}`)) return false;
    const st = lstatOrNull(cursor);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) return false;
    cursor = path.dirname(cursor);
  }
  return true;
}

function statusLines(repoRoot, pathspecs) {
  return gitStatus(repoRoot, pathspecs)
    .filter(({ path: rel }) => !isJunkName(path.posix.basename(rel)))
    .map(({ xy, path: rel }) => `${xy} ${rel}`);
}

/**
 * Backup → M2–M5. Back up the checkout + data (or check `--backup`) → copy
 * (journal first) → verify → record in the marker → restore tracked files +
 * unlink exactly the verified copies → assert a clean checkout. Reruns are
 * no-ops; `dryRun` only plans.
 */
export async function migrateCheckout(options = {}) {
  const ctx = resolveContext(options);
  const { repoRoot, paths: resolved, log } = ctx;
  if (!options.dryRun) assertOwnership(ctx, options);
  const plan = planMigrateCheckout(repoRoot);
  if (!plan.checked) {
    throw new CliError(
      EXIT.UNEXPECTED,
      'git_unavailable',
      `migrate-checkout needs a git checkout (${plan.reason})`,
    );
  }
  const summary = {
    fromSha: plan.fromSha,
    subjects: plan.subjects,
    generated: plan.generated,
    sourcePdfFiles: plan.sourcePdfFiles,
    ingestFiles: plan.ingestFiles,
    registrars: plan.registrars,
    hiddenCommitted: plan.hiddenCommitted,
    orphans: plan.orphans,
    incompleteGenerated: plan.incompleteGenerated,
    invalidCatalogRows: plan.invalidCatalogRows,
    leftoverDirs: plan.leftoverDirs,
  };
  const noop =
    plan.blocking.length === 0 &&
    plan.copies.length === 0 &&
    plan.unlinks.length === 0 &&
    plan.leftoverDirs.length === 0 &&
    !plan.restoreTracked;
  if (noop) return { ...summary, noop: true, dryRun: Boolean(options.dryRun), copies: [] };
  const blocking = [...plan.blocking, ...plan.examChanges];
  if (blocking.length > 0) {
    throw new CliError(
      EXIT.UNEXPECTED,
      'blocked',
      'the checkout has changes migrate-checkout cannot move; nothing was changed',
      { blocking },
    );
  }

  const dataDir = resolved.dataDir;
  const journal = loadJournal(dataDir);
  const catalogRel = 'content/generated/subjects.json';
  const catalogDest = fromPosix(dataDir, catalogRel);
  let dataRows = [];
  let catalogOwned = false;
  if (fs.existsSync(catalogDest)) {
    const rows = parseCatalog(fs.readFileSync(catalogDest, 'utf8'));
    if (!rows) {
      throw new CliError(
        EXIT.UNEXPECTED,
        'family_catalog_invalid',
        'the family catalog in the data folder is not valid JSON; fix or move it first',
      );
    }
    dataRows = rows;
    catalogOwned = journal.written[catalogRel] === sha256File(catalogDest);
  }
  const dataById = new Map();
  for (const row of dataRows) if (row && typeof row.id === 'string') dataById.set(row.id, row);

  // Decide every copy up front (the dry run prints exactly this).
  for (const item of plan.copies) {
    item.srcSha = sha256File(item.src);
    item.state =
      item.target === 'conflict'
        ? 'conflict'
        : destinationState(fromPosix(dataDir, item.rel), item.rel, item.srcSha, journal);
  }
  // A generated subject moves as one unit (row + questions + keys): mixing
  // one side's questions with the other side's keys would mis-grade.
  const conflictRows = [];
  const upsertRows = [];
  const generatedActions = {};
  for (const entry of plan.generatedPlan) {
    const existing = dataById.get(entry.id);
    let rowState = 'copy';
    if (existing) {
      if (deepEqual(existing, entry.row)) rowState = 'same';
      else rowState = catalogOwned ? 'overwrite' : 'conflict';
    }
    const conflict =
      rowState === 'conflict' || entry.files.some((item) => item.state === 'conflict');
    if (conflict) {
      for (const item of entry.files) item.state = 'conflict';
      conflictRows.push(entry.row);
    } else if (rowState !== 'same') {
      upsertRows.push(entry.row);
    }
    generatedActions[entry.id] = conflict ? 'conflict' : rowState;
  }

  const copyReport = plan.copies.map((item) => ({ path: item.rel, action: item.state }));
  if (options.dryRun) {
    return { ...summary, noop: false, dryRun: true, copies: copyReport, generatedActions };
  }

  // Only empty leftover folders: nothing to copy or revert, so no backup.
  if (plan.copies.length === 0 && plan.unlinks.length === 0 && !plan.restoreTracked) {
    const cleaned = cleanCheckout(repoRoot, plan);
    return {
      ...summary,
      noop: false,
      dryRun: false,
      dataDir,
      backup: null,
      moved: 0,
      copied: 0,
      overwritten: 0,
      same: 0,
      conflicts: [],
      ...cleaned,
    };
  }

  initDataFolder(resolved, { geteuid: options.geteuid ?? defaultGeteuid, warn: log });
  // Before anything moves: M4 reverts tracked edits the data folder never gets.
  const migrationBackup = await backupBeforeMigrating(ctx, options, plan);
  const conflictRoot = `migration-conflicts/${compactUtc(new Date())}`;

  // M2: journal every destination this run will own, then copy + verify.
  if (!journal.resumed) journal.fromSha = plan.fromSha;
  for (const item of plan.copies) {
    if (item.state === 'copy' || item.state === 'overwrite')
      journal.written[item.rel] = item.srcSha;
  }
  let nextCatalog = null;
  if (upsertRows.length > 0) {
    const rows = [...dataRows];
    for (const row of upsertRows) {
      const index = rows.findIndex((existing) => existing && existing.id === row.id);
      if (index >= 0) rows[index] = row;
      else rows.push(row);
    }
    nextCatalog = `${JSON.stringify(rows, null, 2)}\n`;
    journal.written[catalogRel] = sha256Text(nextCatalog);
  }
  saveJournal(dataDir, journal);

  const conflicts = [];
  const counts = { copied: 0, overwritten: 0, same: 0 };
  for (const item of plan.copies) {
    if (item.state === 'same') {
      item.writtenSha = item.srcSha;
      counts.same += 1;
      continue;
    }
    const destRel = item.state === 'conflict' ? `${conflictRoot}/${item.rel}` : item.rel;
    const dest = fromPosix(dataDir, destRel);
    const written = copyFileHashed(item.src, dest, { mode: modeFor(item.rel) });
    if (sha256File(dest) !== written.sha256) {
      throw new CliError(EXIT.UNEXPECTED, 'copy_failed', `${destRel} did not verify after copying`);
    }
    item.writtenSha = written.sha256;
    if (item.state === 'conflict') conflicts.push(destRel);
    else {
      journal.written[item.rel] = written.sha256;
      counts[item.state === 'overwrite' ? 'overwritten' : 'copied'] += 1;
    }
  }
  saveJournal(dataDir, journal);
  // The family catalog last (the commit point), after its questions + keys.
  if (nextCatalog !== null) writeFileAtomic(catalogDest, nextCatalog, { mode: 0o644 });
  if (conflictRows.length > 0) {
    const rel = `${conflictRoot}/${catalogRel}`;
    writeFileAtomic(fromPosix(dataDir, rel), `${JSON.stringify(conflictRows, null, 2)}\n`, {
      mode: 0o644,
    });
    conflicts.push(rel);
  }

  // M3: record, then drop the journal.
  const moved = counts.copied + counts.overwritten + counts.same;
  appendMarkerMigration(dataDir, {
    id: MIGRATION_ID,
    at: new Date().toISOString(),
    fromSha: journal.fromSha ?? plan.fromSha,
    moved,
    conflicts,
    hiddenCommitted: plan.hiddenCommitted,
  });
  fs.rmSync(path.join(dataDir, MIGRATE_JOURNAL), { force: true });

  // M4: only if nothing changed since the copy.
  for (const item of plan.copies) {
    if (sha256File(item.src) !== item.writtenSha) {
      throw new CliError(
        EXIT.UNEXPECTED,
        'changed_during_migration',
        `${item.rel} changed while it was being copied; nothing was removed, run migrate-checkout again`,
      );
    }
  }
  const cleaned = cleanCheckout(repoRoot, plan);
  return {
    ...summary,
    noop: false,
    dryRun: false,
    dataDir,
    backup: migrationBackup,
    moved,
    ...counts,
    conflicts,
    ...cleaned,
  };
}

/**
 * M4 + M5: restore the tracked content from HEAD, unlink exactly the
 * verified untracked / ignored copies (never `git clean`, never through a
 * symlinked folder), prune the folders that emptied out, then require a clean
 * checkout.
 */
function cleanCheckout(repoRoot, plan) {
  if (plan.restoreTracked) {
    const heads = new Set(
      zList(git(repoRoot, ['ls-tree', '-z', '--name-only', 'HEAD', '--', ...RESTORE_PATHS])),
    );
    const specs = RESTORE_PATHS.filter((rel) => heads.has(rel));
    if (specs.length > 0) {
      const result = git(repoRoot, ['checkout', '--no-overlay', 'HEAD', '--', ...specs]);
      if (result.error || result.status !== 0) {
        throw new CliError(
          EXIT.UNEXPECTED,
          'git_failed',
          'git checkout could not restore the committed content',
        );
      }
    }
  }
  // A file taken out of the index (`git rm --cached`) is tracked again now
  // that git checkout restored it: it stays (its copy is in the data folder).
  const trackedNow = new Set(
    zList(git(repoRoot, ['ls-files', '-z', '--', 'content', '.examify-ingest', ...REGISTRARS])),
  );
  const problems = [];
  const touched = new Set(plan.leftoverDirs.map((rel) => fromPosix(repoRoot, rel)));
  let removed = 0;
  for (const unlink of plan.unlinks) {
    if (trackedNow.has(unlink.rel)) continue;
    const st = lstatOrNull(unlink.abs);
    if (!st) continue;
    if (!realParents(repoRoot, unlink.abs)) {
      problems.push(`${unlink.rel} (inside a symlinked folder; left in place)`);
      continue;
    }
    const expected =
      unlink.type === 'link' ? st.isSymbolicLink() : st.isFile() && !st.isSymbolicLink();
    if (!expected) {
      problems.push(`${unlink.rel} (changed type; left in place)`);
      continue;
    }
    fs.unlinkSync(unlink.abs);
    removed += 1;
    touched.add(path.dirname(unlink.abs));
  }
  const pruned = pruneEmptyDirs(repoRoot, touched);

  // M5: the checkout must now be clean, ignored leftovers included.
  const left = statusLines(repoRoot, ['content', 'src/lib/exam']);
  for (const rel of LEFTOVER_DIRS) {
    if (lstatOrNull(fromPosix(repoRoot, rel))) problems.push(`${rel}/ (still in the checkout)`);
  }
  if (left.length > 0 || problems.length > 0) {
    throw new CliError(
      EXIT.UNEXPECTED,
      'checkout_not_clean',
      'the family content was copied, but the checkout is not clean yet',
      { remaining: [...left, ...problems] },
    );
  }
  return { removed, removedFolders: pruned.filter((rel) => plan.leftoverDirs.includes(rel)) };
}

/**
 * A backup that holds everything M4 reverts: `--backup` must be a MANIFEST
 * with this checkout at HEAD and the current bytes of every tracked file M4
 * puts back; without it migrate-checkout takes its own pre-upgrade backup.
 */
async function backupBeforeMigrating(ctx, options, plan) {
  if (options.backup) {
    const archive = path.resolve(ctx.cwd, options.backup);
    const refuse = (why) =>
      new CliError(
        EXIT.REFUSED,
        'backup_mismatch',
        `--backup ${why}; nothing was moved (without --backup, migrate-checkout takes its own)`,
      );
    if (!isFile(archive)) throw refuse('is not a file');
    let manifest = null;
    try {
      manifest = JSON.parse(readArchiveManifestText(archive) ?? '');
    } catch {
      manifest = null;
    }
    if (!manifest || manifest.format !== 1 || !Array.isArray(manifest.files)) {
      throw refuse('is not an examify-data backup');
    }
    if (!manifest.checkout?.included || manifest.checkout.gitSha !== plan.fromSha) {
      throw refuse('does not hold this checkout at HEAD (take it with --include-checkout)');
    }
    const archived = new Map(manifest.files.map((file) => [file.path, file.sha256]));
    const missing = [...plan.restoredTracked, ...plan.registrars].filter((rel) => {
      const abs = fromPosix(ctx.repoRoot, rel);
      return isFile(abs) && archived.get(`checkout/${rel}`) !== sha256File(abs);
    });
    if (missing.length > 0) {
      throw refuse(`does not hold the current ${missing.join(', ')}`);
    }
    return { archive, taken: false };
  }
  try {
    const result = await backup({
      ...options,
      kind: 'pre-upgrade',
      includeCheckout: true,
      out: undefined,
      noEnv: false,
      includeCache: false,
    });
    return { archive: result.archive, taken: true };
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    throw new CliError(
      error.exitCode,
      error.code,
      `migrate-checkout backs up the checkout and the data before moving anything, and that backup failed: ${error.message}; nothing was moved`,
      error.extra,
    );
  }
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

export function verify(options = {}) {
  const ctx = resolveContext(options);
  const { repoRoot, paths: resolved } = ctx;
  // A read-only open still creates -wal / -shm; as another user (sudo) they
  // would lock the app out of its own database.
  assertOwnership(ctx, options);
  const failures = [];
  const warnings = [];
  const fail = (check, detail) => failures.push({ check, detail });

  if (resolved.dbPath === ':memory:') {
    fail('database', 'DATABASE_URL is :memory:');
  } else if (!isFile(resolved.dbPath)) {
    fail('database', 'the database file is missing');
  } else {
    const Database = loadSqlite(repoRoot, sqliteModuleOption(ctx, options));
    try {
      const db = inspectDatabase(Database, resolved.dbPath, 'quick_check');
      if (db.integrity !== 'ok') fail('database', 'quick_check failed');
    } catch {
      fail('database', 'the database could not be opened read-only');
    }
  }

  const generatedDir = fromPosix(resolved.dataDir, 'content/generated');
  const catalog = path.join(generatedDir, 'subjects.json');
  if (fs.existsSync(catalog)) {
    let rows = null;
    try {
      rows = parseCatalog(fs.readFileSync(catalog, 'utf8'));
    } catch {
      rows = null;
    }
    if (!rows) fail('family catalog', 'content/generated/subjects.json is not a valid JSON list');
    for (const row of rows ?? []) {
      const id = row && typeof row === 'object' ? row.id : undefined;
      if (typeof id !== 'string' || !SUBJECT_ID_RE.test(id)) {
        fail('family catalog', 'a catalog row has an invalid subject id');
        continue;
      }
      const raw = {};
      for (const dir of ['questions', 'keys']) {
        const file = path.join(generatedDir, dir, `${id}.json`);
        try {
          raw[dir] = fs.readFileSync(file, 'utf8');
          JSON.parse(raw[dir]);
        } catch {
          raw[dir] = undefined;
          fail('family catalog', `${dir}/${id}.json is missing, unreadable or not JSON`);
        }
      }
      // A row's `rev` names the questions + keys one Apply wrote together.
      if (
        typeof row.rev === 'string' &&
        raw.questions !== undefined &&
        raw.keys !== undefined &&
        generatedRevision(raw.questions, raw.keys) !== row.rev
      ) {
        fail('revision', id);
      }
    }
  }
  const keysDir = path.join(generatedDir, 'keys');
  if (process.platform !== 'win32' && fs.existsSync(keysDir)) {
    for (const name of fs.readdirSync(keysDir)) {
      const st = lstatOrNull(path.join(keysDir, name));
      if (st?.isFile() && (st.mode & 0o077) !== 0) {
        fail('keys permissions', `keys/${name} is readable by other users (want 0600)`);
      }
    }
  }

  const gitInfo = gitCheckout(repoRoot);
  if (gitInfo.ok) {
    for (const { xy, path: rel } of gitStatus(repoRoot, ['content', ...REGISTRARS])) {
      if (isJunkName(path.posix.basename(rel))) continue;
      fail('checkout', `${xy} ${rel}`);
    }
  } else {
    warnings.push('git is not available here; checkout cleanliness was not checked');
  }
  for (const rel of ['content/source-pdfs', '.examify-ingest']) {
    if (lstatOrNull(fromPosix(repoRoot, rel))) fail('checkout', `${rel}/ is still in the checkout`);
  }
  return { ok: failures.length === 0, failures, warnings };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export const USAGE = `Usage: node scripts/examify-data.mjs <command> [options]

Commands:
  paths [--check]            Print the resolved checkout, data folder, database and outbox paths
  init                       Create the data folder (0700), its .gitignore and marker
  backup [--out DIR] [--no-env] [--include-cache] [--kind manual|pre-upgrade] [--include-checkout]
                             Write a 0600 .tar.gz (DB snapshot, family files, .env)
  restore <archive> [--force] [--with-env] [--include-checkout]
                             Restore a backup (stop the server first)
  legacy-check               Exit 4 when family content is still inside the checkout
  migrate-checkout [--dry-run] [--backup ARCHIVE]
                             Move family content from the checkout into the data folder,
                             after a pre-upgrade backup (or one given with --backup that
                             holds this checkout at HEAD)
  verify                     Check the database, the family catalog and a clean checkout

Options for every command:
  --repo DIR                 The Examify checkout (default: found from the current folder)
  --data-dir DIR             Use this data folder (same rules as EXAMIFY_DATA_DIR)
  --json                     Print one JSON object on stdout
  --sqlite-module PATH       better-sqlite3 to load (default: the checkout's node_modules)
  --allow-owner-mismatch     Write even when this user does not own the checkout / data folder

Exit codes: 0 ok, 1 unexpected, 2 usage, 3 unsafe data folder, 4 legacy content,
5 refused (server running, owner mismatch, target not empty), 6 verify failed.
`;

const COMMON_FLAGS = {
  repo: 'value',
  'data-dir': 'value',
  json: 'bool',
  'sqlite-module': 'value',
  'allow-owner-mismatch': 'bool',
};
const COMMAND_FLAGS = {
  paths: { check: 'bool' },
  init: {},
  backup: {
    out: 'value',
    'no-env': 'bool',
    'include-cache': 'bool',
    kind: 'value',
    'include-checkout': 'bool',
  },
  restore: { force: 'bool', 'with-env': 'bool', 'include-checkout': 'bool' },
  'legacy-check': {},
  'migrate-checkout': { 'dry-run': 'bool', backup: 'value' },
  verify: {},
};

function usageError(message) {
  return new CliError(EXIT.USAGE, 'usage', message);
}

export function parseArgs(argv) {
  if (argv.length === 0) throw usageError('missing command');
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    return { help: true };
  }
  const [command, ...rest] = argv;
  if (!Object.prototype.hasOwnProperty.call(COMMAND_FLAGS, command)) {
    throw usageError(`unknown command: ${command}`);
  }
  const allowed = { ...COMMON_FLAGS, ...COMMAND_FLAGS[command] };
  const flags = {};
  const positionals = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const kind = allowed[name];
    if (!kind) throw usageError(`unknown option for ${command}: --${name}`);
    if (kind === 'bool') {
      if (eq !== -1) throw usageError(`--${name} takes no value`);
      flags[name] = true;
      continue;
    }
    let value;
    if (eq !== -1) value = arg.slice(eq + 1);
    else {
      i += 1;
      value = rest[i];
    }
    if (value === undefined || value === '') throw usageError(`--${name} needs a value`);
    flags[name] = value;
  }
  const wanted = command === 'restore' ? 1 : 0;
  if (positionals.length !== wanted) {
    throw usageError(
      wanted === 1 ? 'restore takes exactly one archive path' : `${command} takes no arguments`,
    );
  }
  if (flags.kind !== undefined && !BACKUP_KINDS.includes(flags.kind)) {
    throw usageError('--kind must be manual or pre-upgrade');
  }
  return { command, flags, positionals };
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function listLines(items) {
  return items.map((item) => `  - ${item}`).join('\n');
}

/** Run one parsed command → `{ exitCode, data, text }`. */
async function runCommand(command, flags, positionals, options) {
  switch (command) {
    case 'paths': {
      const data = paths(options);
      // `--check` is for scripts: quiet on success, exit 3 + reason on stderr when unsafe.
      if (flags.check) return { exitCode: EXIT.OK, data, text: null };
      const text = [
        `repoRoot             ${data.repoRoot}`,
        `dataDir              ${data.dataDir} (${data.dataDirSource})`,
        `dbPath               ${data.dbPath}`,
        `outboxDir            ${data.outboxDir}`,
        `databaseUrlExplicit  ${data.databaseUrlExplicit}`,
      ].join('\n');
      return { exitCode: EXIT.OK, data, text };
    }
    case 'init': {
      const data = init(options);
      const text = data.created
        ? `Created the family data folder: ${data.dataDir}`
        : `The family data folder is ready: ${data.dataDir}`;
      return { exitCode: EXIT.OK, data: { ok: true, command, ...data }, text };
    }
    case 'backup': {
      const data = await backup({
        ...options,
        out: flags.out,
        noEnv: Boolean(flags['no-env']),
        includeCache: Boolean(flags['include-cache']),
        includeCheckout: Boolean(flags['include-checkout']),
        kind: flags.kind,
      });
      const text = [
        `Backup written: ${data.archive} (${formatSize(data.size)})`,
        'It contains secrets and answer keys: copy it off this machine and keep it private.',
      ].join('\n');
      return {
        exitCode: EXIT.OK,
        data: { ok: true, command, ...data },
        text,
        reminderOnStderr: true,
      };
    }
    case 'restore': {
      const data = await restore({
        ...options,
        archive: positionals[0],
        force: Boolean(flags.force),
        withEnv: Boolean(flags['with-env']),
        includeCheckout: Boolean(flags['include-checkout']),
      });
      const lines = [
        `Restored the database to ${data.dbPath} and ${data.restored.familyFiles} family files to ${data.dataDir}.`,
      ];
      if (data.target.changed) {
        lines.push(
          `That is the family data folder the restored env files name; before the restore this checkout used ${data.target.before.dataDir}.`,
        );
      }
      if (data.movedAside) lines.push(`The previous data was moved aside to ${data.movedAside}.`);
      for (const saved of data.envSaved) lines.push(`Saved the previous env file as ${saved}.`);
      if (data.restored.env.length > 0) lines.push(`Restored ${data.restored.env.join(', ')}.`);
      else if (data.archiveHasEnv)
        lines.push('The archive has env files; pass --with-env to restore them.');
      if (data.restored.checkoutFiles > 0)
        lines.push(`Restored ${data.restored.checkoutFiles} checkout files.`);
      lines.push('Next: pnpm db:migrate, then start (or restart) the server.');
      return { exitCode: EXIT.OK, data: { ok: true, command, ...data }, text: lines.join('\n') };
    }
    case 'legacy-check': {
      const { exitCode, ...result } = legacyCheck(options);
      let text;
      if (!result.checked) text = `Legacy check skipped: ${result.reason}.`;
      else if (!result.legacy) text = 'The checkout holds no family content.';
      else {
        text = [
          'Family content is still inside the checkout:',
          listLines(
            result.items.map(
              (item) => `${item.kind}: ${item.path}${item.reason ? ` (${item.reason})` : ''}`,
            ),
          ),
          'With the server stopped, move it into the family data folder with',
          '`./install.sh --upgrade`, or `node scripts/examify-data.mjs migrate-checkout`',
          '(which backs up the checkout and the data before moving anything).',
        ].join('\n');
      }
      const data = {
        ok: exitCode === EXIT.OK,
        command,
        ...(exitCode === EXIT.OK ? {} : { error: 'legacy_content' }),
        ...result,
      };
      return { exitCode, data, text };
    }
    case 'migrate-checkout': {
      const data = await migrateCheckout({
        ...options,
        dryRun: Boolean(flags['dry-run']),
        backup: flags.backup,
      });
      const lines = [];
      if (data.noop) lines.push('The checkout holds no family content; nothing to migrate.');
      else {
        const verb = data.dryRun ? 'Would move' : 'Moved';
        if (data.backup?.taken) {
          lines.push(
            `Backed up the checkout and the data first: ${data.backup.archive}`,
            'It contains secrets and answer keys: copy it off this machine and keep it private.',
          );
        }
        if (data.subjects.length)
          lines.push(`${verb} subjects: ${data.subjects.map((s) => s.id).join(', ')}`);
        if (data.generated.length)
          lines.push(`${verb} generated questions: ${data.generated.map((g) => g.id).join(', ')}`);
        if (data.sourcePdfFiles)
          lines.push(`${verb} ${data.sourcePdfFiles} source files from content/source-pdfs`);
        if (data.ingestFiles) lines.push(`${verb} ${data.ingestFiles} files from .examify-ingest`);
        if (data.registrars.length)
          lines.push(`${data.dryRun ? 'Would restore' : 'Restored'} ${data.registrars.join(', ')}`);
        if (data.orphans.length)
          lines.push(`Unrecognised files go to migration-conflicts:\n${listLines(data.orphans)}`);
        if (data.incompleteGenerated.length) {
          lines.push(
            `Generated subjects missing a row, questions or keys (their files go to migration-conflicts${data.backup ? `; the backup ${data.backup.archive} has the checkout as it was` : ''}): ${data.incompleteGenerated.map((g) => g.id).join(', ')}`,
          );
        }
        if (data.hiddenCommitted.length) {
          lines.push(
            `Built-in subjects deleted in the checkout come back: ${data.hiddenCommitted.join(', ')}`,
          );
        }
        if (data.removedFolders?.length) {
          lines.push(
            `Removed empty folders left in the checkout: ${data.removedFolders.join(', ')}`,
          );
        }
        if (data.dryRun) {
          lines.push(listLines(data.copies.map((copy) => `${copy.action}: ${copy.path}`)));
          if (data.leftoverDirs?.length) {
            lines.push(`Would remove from the checkout: ${data.leftoverDirs.join(', ')}`);
          }
        } else if (data.conflicts.length) {
          lines.push(
            `Kept the data folder's copy; the checkout's copy is in the data folder at:\n${listLines(data.conflicts)}`,
          );
        }
      }
      return { exitCode: EXIT.OK, data: { ok: true, command, ...data }, text: lines.join('\n') };
    }
    case 'verify': {
      const result = verify(options);
      const text = result.ok
        ? 'Verify passed.'
        : ['Verify failed:', listLines(result.failures.map((f) => `${f.check}: ${f.detail}`))].join(
            '\n',
          );
      return {
        exitCode: result.ok ? EXIT.OK : EXIT.VERIFY_FAILED,
        data: { command, ...(result.ok ? {} : { error: 'verify_failed' }), ...result },
        text,
      };
    }
    default:
      throw usageError(`unknown command: ${command}`);
  }
}

/**
 * CLI entry: returns the exit code. `io` lets tests supply cwd / env /
 * streams and fake `geteuid` or the server probe.
 */
export async function main(argv, io = {}) {
  const stdout = io.stdout ?? ((text) => process.stdout.write(text));
  const stderr = io.stderr ?? ((text) => process.stderr.write(text));
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    stderr(`examify-data: ${error.message}\n\n${USAGE}`);
    return error.exitCode;
  }
  if (parsed.help) {
    stdout(USAGE);
    return EXIT.OK;
  }
  const { command, flags, positionals } = parsed;
  const json = Boolean(flags.json);
  const options = {
    cwd: io.cwd ?? process.cwd(),
    env: io.env ?? process.env,
    geteuid: io.geteuid,
    probe: io.probe,
    repo: flags.repo,
    dataDir: flags['data-dir'],
    sqliteModule: flags['sqlite-module'],
    allowOwnerMismatch: Boolean(flags['allow-owner-mismatch']),
    log: (line) => stderr(`${line}\n`),
  };
  try {
    const { exitCode, data, text, reminderOnStderr } = await runCommand(
      command,
      flags,
      positionals,
      options,
    );
    if (json) {
      stdout(`${JSON.stringify(data)}\n`);
      if (reminderOnStderr) {
        stderr('The backup contains secrets and answer keys: copy it off this machine.\n');
      }
      if (exitCode !== EXIT.OK) stderr(`${text}\n`);
    } else if (exitCode === EXIT.OK) {
      if (text !== null) stdout(`${text}\n`);
    } else {
      stderr(`${text}\n`);
    }
    return exitCode;
  } catch (error) {
    const cli =
      error instanceof CliError
        ? error
        : new CliError(
            EXIT.UNEXPECTED,
            'unexpected',
            error instanceof Error ? error.message : String(error),
          );
    const reason = cli.extra.reason ? `${cli.extra.reason}: ` : '';
    const lists = ['blocking', 'remaining']
      .filter((key) => Array.isArray(cli.extra[key]))
      .map((key) =>
        listLines(
          cli.extra[key].map((item) =>
            typeof item === 'string' ? item : `${item.path} (${item.reason})`,
          ),
        ),
      );
    stderr(
      `examify-data ${command}: ${reason}${cli.message}\n${lists.map((l) => `${l}\n`).join('')}`,
    );
    if (json) {
      stdout(
        `${JSON.stringify({ ok: false, command, error: cli.code, message: cli.message, ...cli.extra })}\n`,
      );
    }
    return cli.exitCode;
  }
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(
        `examify-data: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = EXIT.UNEXPECTED;
    },
  );
}
