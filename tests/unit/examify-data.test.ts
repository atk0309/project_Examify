import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import * as tsDataDir from '@/lib/data-dir';
import { parseEnvFile as tsParseEnvFile } from '@/lib/env-file';
import { generatedRevision as tsGeneratedRevision } from '@/lib/exam/generated-revision';
import * as data from '../../scripts/examify-data.mjs';

// Every case runs in a temp fake checkout (package.json `project-examify`,
// its own git repo) with a temp data folder and an explicit env — never the
// real checkout's data or the developer's exported env.

const REPO = process.cwd();
const SCRIPT = path.join(REPO, 'scripts', 'examify-data.mjs');
const SQLITE_MODULE = path.join(REPO, 'node_modules', 'better-sqlite3');
const JOURNAL = 'src/lib/db/migrations/meta/_journal.json';
const JOURNAL_ENTRIES = (
  JSON.parse(fs.readFileSync(path.join(REPO, JOURNAL), 'utf8')) as { entries: unknown[] }
).entries.length;

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function write(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function mode(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      ...['-c', 'user.name=Examify Test', '-c', 'user.email=test@example.com'],
      ...['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'],
      // No detached auto-maintenance (git 2.47+) writing into .git during cleanup.
      ...['-c', 'maintenance.auto=false', '-c', 'gc.auto=0'],
      ...args,
    ],
    { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } },
  );
}

const COMMITTED = [
  'content/subjects/biology/bank.ir.json',
  'content/subjects/demo/subject.json',
  'content/subjects/demo/notes.txt',
  'content/generated/README.md',
  'content/generated/subjects.json',
  'content/generated/questions/biology.json',
  'content/generated/keys/biology.json',
  'src/lib/exam/generated-public.ts',
  'src/lib/exam/generated-keys.server.ts',
  JOURNAL,
  '.gitignore',
];

/** A fake checkout with the committed content fixture, committed on `main`. */
function makeCheckout(): string {
  const root = tempDir('examify-data-repo-');
  write(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'project-examify', version: '9.9.9' }),
  );
  for (const rel of COMMITTED) {
    write(path.join(root, rel), fs.readFileSync(path.join(REPO, rel), 'utf8'));
  }
  write(path.join(root, 'src/lib/exam/data.ts'), 'export const SAMPLE = 1;\n');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixture');
  return root;
}

function head(root: string): string {
  return git(root, 'rev-parse', 'HEAD').trim();
}

/** A migrated-looking SQLite DB in WAL mode with `migrations` drizzle rows. */
function makeDb(file: string, { migrations = JOURNAL_ENTRIES, rows = 3 } = {}): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(
    'create table __drizzle_migrations (id integer primary key autoincrement, hash text not null, created_at numeric)',
  );
  db.exec('create table users (id integer primary key, email text not null)');
  const addMigration = db.prepare(
    'insert into __drizzle_migrations (hash, created_at) values (?, ?)',
  );
  for (let i = 0; i < migrations; i += 1) addMigration.run(`hash-${i}`, i);
  const addUser = db.prepare('insert into users (email) values (?)');
  for (let i = 0; i < rows; i += 1) addUser.run(`user${i}@example.com`);
  db.close();
}

function countUsers(file: string): number {
  const db = new Database(file, { readonly: true });
  try {
    return (db.prepare('select count(*) as n from users').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

function subject(id: string, label: string) {
  return { id, label, icon: 'biology', l: 0.6, c: 0.1, h: 40 };
}

type Env = Record<string, string | undefined>;

function cliEnv(extra: Env = {}): Env {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    EXAMIFY_SQLITE_MODULE: SQLITE_MODULE,
    ...extra,
  };
}

function cli(args: string[], { cwd = REPO, env = cliEnv(), script = SCRIPT } = {}) {
  // An explicit env: the unit setup's DATABASE_URL / NODE_ENV must not leak in.
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    env: env as NodeJS.ProcessEnv,
    encoding: 'utf8',
  });
}

/** In-process `main` with captured streams; the server probe is stubbed unless given. */
async function run(
  argv: string[],
  io: NonNullable<Parameters<typeof data.main>[1]> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await data.main(argv, {
    cwd: REPO,
    env: { EXAMIFY_SQLITE_MODULE: SQLITE_MODULE },
    probe: async () => null,
    ...io,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

function tarList(archive: string): string[] {
  return execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).split('\n').filter(Boolean);
}

function extract(archive: string): string {
  const dir = tempDir('examify-data-extract-');
  execFileSync('tar', ['-xzf', archive, '-C', dir]);
  return dir;
}

type Manifest = {
  format: number;
  kind: string;
  db: { file: string; sha256: string; migrations: number; integrity: string };
  env: { included: boolean };
  checkout: { included: boolean; gitSha?: string };
  files: Array<{ path: string; sha256: string; size: number }>;
};

function readManifest(dir: string): Manifest {
  return JSON.parse(fs.readFileSync(path.join(dir, 'MANIFEST.json'), 'utf8')) as Manifest;
}

/** Family content the wizard would have written into a data folder. */
function seedFamily(dataDir: string): void {
  write(
    path.join(dataDir, 'content/subjects/history/subject.json'),
    JSON.stringify(subject('history', 'History')),
  );
  write(path.join(dataDir, 'content/source-pdfs/history/a.pdf'), '%PDF-1.4 history');
  write(
    path.join(dataDir, 'content/generated/subjects.json'),
    JSON.stringify([subject('history', 'History')]),
  );
  write(path.join(dataDir, 'content/generated/questions/history.json'), '{"easy":[]}');
  write(path.join(dataDir, 'content/generated/keys/history.json'), '{}');
  fs.chmodSync(path.join(dataDir, 'content/generated/keys/history.json'), 0o600);
  write(path.join(dataDir, '.examify-ingest/runs/history.json'), '{"run":1}');
  write(path.join(dataDir, '.examify-ingest/cache/ir/abc.json'), '{"cache":1}');
  write(path.join(dataDir, 'outbox/message.txt'), 'bearer token');
  write(path.join(dataDir, 'backups/old.tar.gz'), 'old archive');
  write(path.join(dataDir, 'migration-conflicts/20260101T000000Z/content/x.txt'), 'conflict');
}

describe('resolver parity with src/lib/data-dir.ts', () => {
  type Outcome = { value: unknown } | { reason: string };
  const outcome = (fn: () => unknown): Outcome => {
    try {
      return { value: fn() };
    } catch (error) {
      const reason = (error as { reason?: string }).reason;
      if (!reason) throw error;
      return { reason };
    }
  };

  it('resolves the same paths (or refuses with the same reason) for every case', () => {
    const root = makeCheckout();
    const outside = tempDir('examify-data-outside-');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    const linkIntoSrc = path.join(outside, 'family');
    fs.symlinkSync(path.join(root, 'src'), linkIntoSrc);
    const cases: Array<Record<string, string>> = [
      {},
      { NODE_ENV: 'production' },
      { EXAMIFY_DATA_DIR: 'data/family' },
      { EXAMIFY_DATA_DIR: outside },
      { EXAMIFY_DATA_DIR: '  ' },
      { EXAMIFY_DATA_DIR: 'tests/.tmp/e2e-data' },
      { EXAMIFY_DATA_DIR: linkIntoSrc },
      { DATABASE_URL: 'file:./data/app.db' },
      { DATABASE_URL: 'file:./app.db' },
      { DATABASE_URL: `file:${path.join(outside, 'app.db')}` },
      { DATABASE_URL: path.join(outside, 'bare.db') },
      { DATABASE_URL: `file:${path.join(path.dirname(root), 'app.db')}` },
      { DATABASE_URL: ':memory:' },
      { DATABASE_URL: 'file::memory:' },
      { DATABASE_URL: 'file:./data/app.db', EXAMIFY_DATA_DIR: 'data/family' },
      { DATABASE_URL: '', EXAMIFY_DATA_DIR: '', MAIL_OUTBOX_DIR: ' ' },
      { MAIL_OUTBOX_DIR: 'tests/.tmp/box' },
      ...['outbox', '.', 'src/box', 'data/outbox', '..', path.join(outside, 'box')].map((dir) => ({
        MAIL_OUTBOX_DIR: dir,
      })),
      { MAIL_OUTBOX_DIR: path.join(linkIntoSrc, 'box') },
      { DATABASE_URL: 'file:./tests/.tmp/unit.db' },
      ...[
        'file:$HOME/app.db',
        'file:~/app.db',
        '$DB',
        'file:./data/a #b.db',
        'file:./data/`x`.db',
      ].map((url) => ({ DATABASE_URL: url })),
      ...['$HOME/box', '~/box', 'data/box #x', "data/it's"].map((dir) => ({
        MAIL_OUTBOX_DIR: dir,
      })),
      { DATABASE_URL: 'file:./src/app.db', EXAMIFY_DATA_DIR: outside },
      { DATABASE_URL: `file:${path.join(linkIntoSrc, 'app.db')}` },
      { RESEND_API_KEY: 'test' },
      { RESEND_API_KEY: 'test', NODE_ENV: 'production' },
      { NODE_ENV: 'test' },
      ...['.', '..', '/', 'src', 'content/family', '.next', 'node_modules'].map((dir) => ({
        EXAMIFY_DATA_DIR: dir,
      })),
      ...['~/examify', 'a\nb', '"quoted"', "it's", 'dir #comment'].map((dir) => ({
        EXAMIFY_DATA_DIR: dir,
      })),
    ];
    for (const env of cases) {
      const expected = outcome(() => tsDataDir.resolveDataPaths({ repoRoot: root, env }));
      const actual = outcome(() => data.resolveDataPaths({ repoRoot: root, env }));
      expect(actual, JSON.stringify(env)).toEqual(expected);
    }
  });

  it('reads the repo env files in the same next-start order', () => {
    const root = makeCheckout();
    const fileSets: Array<Record<string, string>> = [
      { '.env': 'EXAMIFY_DATA_DIR=data/from-env\n' },
      { '.env': 'EXAMIFY_DATA_DIR=data/a\n', '.env.production': 'EXAMIFY_DATA_DIR=data/b\n' },
      { '.env': 'EXAMIFY_DATA_DIR=data/a\n', '.env.local': 'EXAMIFY_DATA_DIR=\n' },
      {
        '.env.local': 'EXAMIFY_DATA_DIR=data/local # comment\n',
        '.env.production.local': 'DATABASE_URL="file:./data/x.db"\n',
      },
      { '.env': "export DATABASE_URL='file:./data/quoted.db'\nMAIL_OUTBOX_DIR=tests/.tmp/o\n" },
    ];
    const hostEnvs = [{}, { EXAMIFY_DATA_DIR: 'data/host' }, { EXAMIFY_DATA_DIR: ' ' }];
    for (const files of fileSets) {
      for (const name of data.PRODUCTION_ENV_FILES)
        fs.rmSync(path.join(root, name), { force: true });
      for (const [name, body] of Object.entries(files)) write(path.join(root, name), body);
      for (const env of hostEnvs) {
        const nested = path.join(root, 'src', 'lib');
        expect(data.resolveCliDataPaths(nested, env)).toEqual(
          tsDataDir.resolveCliDataPaths(nested, env),
        );
      }
    }
  });

  it('parses env files identically', () => {
    const samples = [
      'A=1\nB = two \n# comment\nexport C=3\n',
      'D="quoted # not a comment"\nE=value # comment\nF=a#b\nG=\'single\'\n',
      'H=\nI\n=J\n1K=bad\nL="unterminated\r\nM= spaced  \n',
    ];
    for (const sample of samples) expect(data.parseEnvFile(sample)).toEqual(tsParseEnvFile(sample));
  });
});

describe('paths / init / usage', () => {
  it('prints the resolved paths as one JSON object', () => {
    const root = makeCheckout();
    const outside = tempDir('examify-data-family-');
    write(path.join(root, '.env'), `EXAMIFY_DATA_DIR=${outside}\n`);
    const result = cli(['paths', '--json'], { cwd: path.join(root, 'src') });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      repoRoot: root,
      dataDir: outside,
      dataDirSource: 'EXAMIFY_DATA_DIR',
      dbPath: path.join(outside, 'app.db'),
      outboxDir: path.join(outside, 'outbox'),
      databaseUrlExplicit: false,
    });
  });

  it('paths --check exits 3 with the reason code on stderr for an unsafe folder', async () => {
    const root = makeCheckout();
    const unsafe = await run(['paths', '--check', '--repo', root, '--data-dir', 'src']);
    expect(unsafe.code).toBe(3);
    expect(unsafe.stderr).toContain('inside_checkout');
    expect(unsafe.stderr).not.toContain(root);
    const ok = await run(['paths', '--check', '--repo', root]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toBe('');
  });

  it('paths --check refuses a database or mail outbox inside the checkout (from the env files)', async () => {
    const root = makeCheckout();
    for (const [line, reason] of [
      ['DATABASE_URL=file:./app.db', 'db_inside_checkout'],
      ['MAIL_OUTBOX_DIR=outbox', 'outbox_inside_checkout'],
    ]) {
      write(path.join(root, '.env'), `${line}\n`);
      const result = await run(['paths', '--check', '--repo', root], { env: {} });
      expect(result.code, line).toBe(3);
      expect(result.stderr).toContain(reason);
      expect(result.stderr).not.toContain(root);
      // Nothing that writes runs either.
      expect((await run(['init', '--repo', root], { env: {} })).code).toBe(3);
      expect(fs.existsSync(path.join(root, 'data'))).toBe(false);
    }
  });

  it('init creates a 0700 folder with a .gitignore and a 0600 marker, and reruns cleanly', async () => {
    const root = makeCheckout();
    const dataDir = path.join(tempDir('examify-data-init-'), 'family');
    const first = await run(['init', '--repo', root, '--data-dir', dataDir, '--json']);
    expect(first.code).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ ok: true, dataDir, created: true });
    expect(mode(dataDir)).toBe(0o700);
    expect(fs.readFileSync(path.join(dataDir, '.gitignore'), 'utf8')).toBe('*\n');
    const marker = path.join(dataDir, '.examify-data.json');
    expect(mode(marker)).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(marker, 'utf8'))).toMatchObject({
      layout: 1,
      migrations: [],
    });
    const before = fs.readFileSync(marker, 'utf8');
    fs.chmodSync(dataDir, 0o755);
    const second = await run(['init', '--repo', root, '--data-dir', dataDir, '--json']);
    expect(JSON.parse(second.stdout)).toMatchObject({ created: false });
    expect(fs.readFileSync(marker, 'utf8')).toBe(before);
    expect(mode(dataDir)).toBe(0o700);
  });

  it('init refuses a data folder that is a file (exit 3, unreadable), without naming it', async () => {
    const root = makeCheckout();
    const file = path.join(tempDir('examify-data-file-'), 'secret-family-file');
    write(file, 'not a folder');
    const result = await run(['init', '--repo', root, '--data-dir', file, '--json']);
    expect(result.code).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: 'unsafe_data_dir',
      reason: 'unreadable',
    });
    expect(result.stdout + result.stderr).not.toContain('secret-family-file');
    expect(result.stderr).not.toMatch(/ENOTDIR/);
    expect(fs.readFileSync(file, 'utf8')).toBe('not a folder');
  });

  it('init refuses a shared, unmarked folder without chmodding or writing into it', async () => {
    const root = makeCheckout();
    const shared = tempDir('examify-data-shared-');
    fs.chmodSync(shared, 0o755);
    write(path.join(shared, 'app.db'), '');
    write(path.join(shared, 'dpkg.status'), 'someone else');
    const refused = await run(['init', '--repo', root, '--data-dir', shared, '--json']);
    expect(refused.code).toBe(5);
    expect(JSON.parse(refused.stdout)).toMatchObject({ ok: false, error: 'shared_folder' });
    expect(mode(shared)).toBe(0o755);
    expect(fs.existsSync(path.join(shared, '.examify-data.json'))).toBe(false);
    expect(fs.existsSync(path.join(shared, '.gitignore'))).toBe(false);
  });

  it('exits 2 on usage errors', async () => {
    const root = makeCheckout();
    expect((await run([])).code).toBe(2);
    expect((await run(['nope'])).code).toBe(2);
    expect((await run(['paths', '--repo', root, '--bogus'])).code).toBe(2);
    expect((await run(['restore', '--repo', root])).code).toBe(2);
    expect((await run(['backup', '--repo', root, '--kind', 'weekly'])).code).toBe(2);
    expect((await run(['paths', '--repo', tempDir('examify-data-not-a-repo-')])).code).toBe(2);
    expect((await run(['--help'])).code).toBe(0);
  });
});

describe('ownership', () => {
  it('refuses writing commands when this user does not own the checkout', async () => {
    const root = makeCheckout();
    const dataDir = path.join(tempDir('examify-data-owner-'), 'family');
    const owner = fs.statSync(root).uid;
    const other = () => owner + 1;
    const refused = await run(['init', '--repo', root, '--data-dir', dataDir], { geteuid: other });
    expect(refused.code).toBe(5);
    expect(refused.stderr).toContain('--allow-owner-mismatch');
    expect(fs.existsSync(dataDir)).toBe(false);
    makeDb(path.join(dataDir, 'app.db'));
    const backupRefused = await run(['backup', '--repo', root, '--data-dir', dataDir], {
      geteuid: other,
    });
    expect(backupRefused.code).toBe(5);
    expect(fs.existsSync(path.join(dataDir, 'backups'))).toBe(false);
    const migrateRefused = await run(['migrate-checkout', '--repo', root, '--data-dir', dataDir], {
      geteuid: other,
    });
    expect(migrateRefused.code).toBe(5);
    const allowed = await run(
      ['init', '--repo', root, '--data-dir', dataDir, '--allow-owner-mismatch'],
      { geteuid: other },
    );
    expect(allowed.code).toBe(0);
    // verify opens the live DB (a read-only open still creates -wal / -shm).
    expect(
      (await run(['verify', '--repo', root, '--data-dir', dataDir], { geteuid: other })).code,
    ).toBe(5);
    // Commands that never write do not refuse.
    expect((await run(['paths', '--repo', root], { geteuid: other })).code).toBe(0);
    expect((await run(['legacy-check', '--repo', root], { geteuid: other })).code).toBe(0);
  });
});

describe('backup', () => {
  it('snapshots a live WAL database without copying -wal / -shm', () => {
    const root = makeCheckout();
    const dataDir = tempDir('examify-data-wal-');
    const dbPath = path.join(dataDir, 'app.db');
    makeDb(dbPath, { rows: 0 });
    const writer = new Database(dbPath);
    try {
      writer.pragma('journal_mode = WAL');
      writer.pragma('wal_autocheckpoint = 0');
      const insert = writer.prepare('insert into users (email) values (?)');
      for (let i = 0; i < 50; i += 1) insert.run(`kid${i}@example.com`);
      expect(fs.statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);

      const out = tempDir('examify-data-out-');
      const result = cli(['backup', '--repo', root, '--out', out, '--json'], {
        env: cliEnv({ EXAMIFY_DATA_DIR: dataDir }),
      });
      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout) as { archive: string };
      expect(result.stderr).toContain('secrets and answer keys');
      expect(path.dirname(report.archive)).toBe(out);
      expect(path.basename(report.archive)).toMatch(
        /^examify-backup-\d{8}T\d{6}Z-[0-9a-f]{4}\.tar\.gz$/,
      );
      expect(mode(report.archive)).toBe(0o600);
      const members = tarList(report.archive);
      expect(members.some((name) => /-(wal|shm)$/.test(name))).toBe(false);
      const dir = extract(report.archive);
      const snapshot = path.join(dir, 'db', 'app.db');
      expect(countUsers(snapshot)).toBe(50);
      const check = new Database(snapshot, { readonly: true });
      expect(check.pragma('integrity_check', { simple: true })).toBe('ok');
      check.close();
      expect(readManifest(dir).db).toMatchObject({
        file: 'db/app.db',
        sha256: sha256(snapshot),
        migrations: JOURNAL_ENTRIES,
        integrity: 'ok',
      });
      // The live database was only read: the writer's frames are still un-checkpointed.
      expect(fs.statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);
    } finally {
      writer.close();
    }
  });

  it('archives family files with MANIFEST hashes, skipping outbox, backups and the cache', async () => {
    const root = makeCheckout();
    const dataDir = tempDir('examify-data-family-');
    makeDb(path.join(dataDir, 'app.db'));
    seedFamily(dataDir);
    data.initDataFolder({ dataDir });
    write(path.join(root, '.env'), 'AUTH_SECRET=top-secret-value\n');
    const env = { EXAMIFY_DATA_DIR: dataDir };

    const full = await data.backup({ repo: root, env, sqliteModule: SQLITE_MODULE });
    expect(path.dirname(full.archive)).toBe(path.join(dataDir, 'backups'));
    expect(mode(path.join(dataDir, 'backups'))).toBe(0o700);
    expect(mode(full.archive)).toBe(0o600);
    const dir = extract(full.archive);
    const manifest = readManifest(dir);
    const listed = manifest.files.map((file) => file.path);
    expect(listed).toEqual(
      expect.arrayContaining([
        'db/app.db',
        'env/.env',
        'family/.examify-data.json',
        'family/content/subjects/history/subject.json',
        'family/content/source-pdfs/history/a.pdf',
        'family/content/generated/subjects.json',
        'family/content/generated/keys/history.json',
        'family/.examify-ingest/runs/history.json',
        'family/migration-conflicts/20260101T000000Z/content/x.txt',
      ]),
    );
    expect(listed.some((rel) => rel.includes('outbox'))).toBe(false);
    expect(listed.some((rel) => rel.includes('backups'))).toBe(false);
    expect(listed.some((rel) => rel.includes('.examify-ingest/cache'))).toBe(false);
    for (const file of manifest.files) {
      expect(sha256(path.join(dir, file.path)), file.path).toBe(file.sha256);
      expect(fs.statSync(path.join(dir, file.path)).size).toBe(file.size);
    }
    expect(manifest).toMatchObject({ format: 1, kind: 'manual', env: { included: true } });
    expect(fs.readdirSync(path.join(dataDir, 'backups')).sort()).toEqual(
      [path.basename(full.archive), 'old.tar.gz'].sort(),
    );

    const lean = await data.backup({
      repo: root,
      env,
      sqliteModule: SQLITE_MODULE,
      noEnv: true,
      includeCache: true,
    });
    const leanFiles = readManifest(extract(lean.archive)).files.map((file) => file.path);
    expect(leanFiles.some((rel) => rel.startsWith('env/'))).toBe(false);
    expect(leanFiles).toContain('family/.examify-ingest/cache/ir/abc.json');
  });

  it('adds the checkout for a pre-upgrade backup and names the archive after HEAD', async () => {
    const root = makeCheckout();
    const dataDir = tempDir('examify-data-pre-');
    makeDb(path.join(dataDir, 'app.db'));
    write(path.join(root, 'content/source-pdfs/history/a.pdf'), '%PDF-1.4');
    write(path.join(root, 'content/subjects/history/notes.md'), '# notes');
    write(path.join(root, 'content/subjects/demo/.DS_Store'), 'junk');
    write(path.join(root, '.examify-ingest/runs/r.json'), '{}');
    write(path.join(root, '.examify-ingest/cache/pages/p.png'), 'png');
    const result = await data.backup({
      repo: root,
      env: { EXAMIFY_DATA_DIR: dataDir },
      sqliteModule: SQLITE_MODULE,
      kind: 'pre-upgrade',
      includeCheckout: true,
    });
    const sha = head(root);
    expect(path.basename(result.archive)).toContain(`-pre-upgrade-${sha.slice(0, 7)}.tar.gz`);
    // install.sh --rollback reads the manifest straight out of the archive.
    const manifest = JSON.parse(
      execFileSync('tar', ['-xOzf', result.archive, 'MANIFEST.json'], { encoding: 'utf8' }),
    ) as Manifest;
    expect(manifest.kind).toBe('pre-upgrade');
    expect(manifest.checkout).toEqual({ included: true, gitSha: sha });
    const listed = manifest.files.map((file) => file.path);
    expect(listed).toEqual(
      expect.arrayContaining([
        'checkout/content/source-pdfs/history/a.pdf',
        'checkout/content/subjects/history/notes.md',
        'checkout/content/subjects/biology/bank.ir.json',
        'checkout/content/generated/keys/biology.json',
        'checkout/src/lib/exam/generated-public.ts',
        'checkout/src/lib/exam/generated-keys.server.ts',
        'checkout/.examify-ingest/runs/r.json',
      ]),
    );
    expect(listed.some((rel) => rel.endsWith('.DS_Store'))).toBe(false);
    expect(listed.some((rel) => rel.includes('cache/pages'))).toBe(false);
  });

  it('leaves no final-named archive when tar fails mid-way', () => {
    const root = makeCheckout();
    const dataDir = tempDir('examify-data-fail-');
    makeDb(path.join(dataDir, 'app.db'));
    const bin = tempDir('examify-data-bin-');
    const fakeTar = path.join(bin, 'tar');
    write(
      fakeTar,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "tar (fake) 1"; exit 0; fi\nprintf "partial archive bytes"\nexit 2\n',
    );
    fs.chmodSync(fakeTar, 0o755);
    const out = tempDir('examify-data-out-');
    const result = cli(['backup', '--repo', root, '--out', out], {
      env: cliEnv({ EXAMIFY_DATA_DIR: dataDir, PATH: `${bin}:${process.env.PATH}` }),
    });
    expect(result.status).toBe(1);
    expect(fs.readdirSync(out)).toEqual([]);
  });

  it('fails with a hint when tar is missing', () => {
    const root = makeCheckout();
    const dataDir = tempDir('examify-data-notar-');
    makeDb(path.join(dataDir, 'app.db'));
    const result = cli(['backup', '--repo', root], {
      env: cliEnv({ EXAMIFY_DATA_DIR: dataDir, PATH: tempDir('examify-data-empty-path-') }),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('tar was not found');
    expect(fs.existsSync(path.join(dataDir, 'backups'))).toBe(false);
  });

  it('refuses an --out inside the checkout and a missing database', async () => {
    const root = makeCheckout();
    const dataDir = tempDir('examify-data-out-in-');
    const missing = await run(['backup', '--repo', root, '--data-dir', dataDir]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('database file does not exist');
    makeDb(path.join(dataDir, 'app.db'));
    const inside = await run([
      'backup',
      '--repo',
      root,
      '--data-dir',
      dataDir,
      '--out',
      path.join(root, 'backups'),
    ]);
    expect(inside.code).toBe(2);
    expect(fs.existsSync(path.join(root, 'backups'))).toBe(false);
  });
});

describe('restore', () => {
  async function makeBackup(opts: { migrations?: number } = {}) {
    const source = makeCheckout();
    const sourceData = tempDir('examify-data-src-');
    makeDb(path.join(sourceData, 'app.db'), { rows: 7, ...opts });
    seedFamily(sourceData);
    write(path.join(source, '.env'), 'AUTH_SECRET=from-backup\n');
    const result = await data.backup({
      repo: source,
      env: { EXAMIFY_DATA_DIR: sourceData },
      sqliteModule: SQLITE_MODULE,
      out: tempDir('examify-data-archives-'),
    });
    return result.archive;
  }

  it('restores the database and family files into an empty data folder', async () => {
    const archive = await makeBackup();
    const target = makeCheckout();
    const dataDir = path.join(tempDir('examify-data-target-'), 'family');
    const result = await run([
      'restore',
      archive,
      '--repo',
      target,
      '--data-dir',
      dataDir,
      '--json',
    ]);
    expect(result.code, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as {
      movedAside: string | null;
      archiveHasEnv: boolean;
    };
    expect(report.movedAside).toBeNull();
    expect(report.archiveHasEnv).toBe(true);
    expect(countUsers(path.join(dataDir, 'app.db'))).toBe(7);
    expect(mode(path.join(dataDir, 'app.db'))).toBe(0o600);
    expect(fs.readFileSync(path.join(dataDir, 'content/source-pdfs/history/a.pdf'), 'utf8')).toBe(
      '%PDF-1.4 history',
    );
    expect(mode(path.join(dataDir, 'content/generated/keys/history.json'))).toBe(0o600);
    expect(mode(dataDir)).toBe(0o700);
    expect(fs.existsSync(path.join(dataDir, '.examify-data.json'))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'outbox'))).toBe(false);
    expect(fs.readdirSync(dataDir).some((name) => name.startsWith('.restore-staging'))).toBe(false);
    // .env only with --with-env.
    expect(fs.existsSync(path.join(target, '.env'))).toBe(false);
  });

  it('refuses a non-empty target without --force and moves it aside inside the data folder with it', async () => {
    const archive = await makeBackup();
    const target = makeCheckout();
    const dataDir = tempDir('examify-data-busy-');
    makeDb(path.join(dataDir, 'app.db'), { rows: 1 });
    const currentDb = sha256(path.join(dataDir, 'app.db'));
    write(path.join(dataDir, 'app.db-wal'), 'stale wal');
    write(path.join(dataDir, 'content/subjects/mine/subject.json'), '{"mine":true}');
    write(path.join(dataDir, 'backups/keep.tar.gz'), 'keep');
    const argv = ['restore', archive, '--repo', target, '--data-dir', dataDir];

    const refused = await run([...argv, '--json']);
    expect(refused.code).toBe(5);
    expect(JSON.parse(refused.stdout)).toMatchObject({ ok: false, error: 'target_not_empty' });
    expect(sha256(path.join(dataDir, 'app.db'))).toBe(currentDb);
    expect(fs.readFileSync(path.join(dataDir, 'app.db-wal'), 'utf8')).toBe('stale wal');

    const forced = await run([...argv, '--force', '--json']);
    expect(forced.code, forced.stderr).toBe(0);
    const { movedAside } = JSON.parse(forced.stdout) as { movedAside: string };
    expect(path.dirname(movedAside)).toBe(dataDir);
    expect(path.basename(movedAside)).toMatch(/^before-restore-\d{8}T\d{6}Z/);
    // The DB moves together with its -wal, so nothing committed is left behind.
    expect(fs.readFileSync(path.join(movedAside, 'db', 'app.db-wal'), 'utf8')).toBe('stale wal');
    expect(sha256(path.join(movedAside, 'db', 'app.db'))).toBe(currentDb);
    expect(fs.existsSync(path.join(movedAside, 'content/subjects/mine/subject.json'))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'app.db-wal'))).toBe(false);
    expect(countUsers(path.join(dataDir, 'app.db'))).toBe(7);
    expect(fs.existsSync(path.join(dataDir, 'content/subjects/mine'))).toBe(false);
    expect(fs.readFileSync(path.join(dataDir, 'backups/keep.tar.gz'), 'utf8')).toBe('keep');
  });

  it('restores .env only with --with-env and keeps the current one as a gitignored 0600 copy', async () => {
    const archive = await makeBackup();
    const target = makeCheckout();
    write(path.join(target, '.env'), 'AUTH_SECRET=current\n');
    const dataDir = tempDir('examify-data-env-');
    const result = await run([
      'restore',
      archive,
      '--repo',
      target,
      '--data-dir',
      dataDir,
      '--with-env',
      '--json',
    ]);
    expect(result.code, result.stderr).toBe(0);
    const { envSaved } = JSON.parse(result.stdout) as { envSaved: string[] };
    expect(envSaved).toHaveLength(1);
    expect(fs.readFileSync(envSaved[0]!, 'utf8')).toBe('AUTH_SECRET=current\n');
    expect(mode(envSaved[0]!)).toBe(0o600);
    expect(fs.readFileSync(path.join(target, '.env'), 'utf8')).toBe('AUTH_SECRET=from-backup\n');
    expect(mode(path.join(target, '.env'))).toBe(0o600);
    expect(git(target, 'status', '--porcelain')).toBe('');
    expect(result.stdout).not.toContain('from-backup');
  });

  describe('--with-env places the data where the restored env files point', () => {
    /** A backup whose archived env files name `archivedDir` (the source itself used another folder). */
    async function backupNaming(archivedDir: string, envLocal?: string) {
      const source = makeCheckout();
      const sourceData = tempDir('examify-data-src-');
      makeDb(path.join(sourceData, 'app.db'), { rows: 5 });
      seedFamily(sourceData);
      write(
        path.join(source, '.env'),
        `AUTH_SECRET=from-backup\nEXAMIFY_DATA_DIR=${archivedDir}\n`,
      );
      if (envLocal !== undefined) write(path.join(source, '.env.local'), envLocal);
      const result = await data.backup({
        repo: source,
        env: { EXAMIFY_DATA_DIR: sourceData },
        sqliteModule: SQLITE_MODULE,
        out: tempDir('examify-data-archives-'),
      });
      return result.archive;
    }

    /** A folder that does not exist yet (a new machine has not made it). */
    function freshFolder(): string {
      return path.join(tempDir('examify-data-machine-'), 'family-data');
    }

    type Report = data.RestoreResult & { ok: boolean };

    it('on a fresh clone, restores into the folder the archived .env names', async () => {
      const archivedDir = freshFolder();
      const archive = await backupNaming(archivedDir);
      const target = makeCheckout();
      const result = await run(['restore', archive, '--repo', target, '--with-env', '--json']);
      expect(result.code, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout) as Report;
      expect(report.target).toEqual({
        source: 'restored-env',
        before: { dataDir: path.join(target, 'data'), dbPath: path.join(target, 'data', 'app.db') },
        after: { dataDir: archivedDir, dbPath: path.join(archivedDir, 'app.db') },
        changed: true,
      });
      expect(report.dataDir).toBe(archivedDir);
      expect(countUsers(path.join(archivedDir, 'app.db'))).toBe(5);
      expect(
        fs.readFileSync(path.join(archivedDir, 'content/source-pdfs/history/a.pdf'), 'utf8'),
      ).toBe('%PDF-1.4 history');
      expect(mode(path.join(archivedDir, 'content/generated/keys/history.json'))).toBe(0o600);
      expect(fs.existsSync(path.join(archivedDir, '.examify-data.json'))).toBe(true);
      expect(mode(archivedDir)).toBe(0o700);
      // The app now resolves exactly the folder the data went to.
      expect(data.resolveRepoDataPaths(target, {}).dbPath).toBe(path.join(archivedDir, 'app.db'));
      // ./data was only staging: gone again, and the checkout is clean.
      expect(fs.existsSync(path.join(target, 'data'))).toBe(false);
      expect(git(target, 'status', '--porcelain', '--ignored')).toBe('!! .env\n');
      expect(result.stderr).toBe('');
    });

    it('an explicit --data-dir still wins over the archived .env', async () => {
      const archivedDir = freshFolder();
      const archive = await backupNaming(archivedDir);
      const target = makeCheckout();
      const dataDir = tempDir('examify-data-flag-');
      const argv = ['restore', archive, '--repo', target, '--data-dir', dataDir, '--with-env'];
      const result = await run([...argv, '--json']);
      expect(result.code, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout) as Report;
      expect(report.target).toMatchObject({ source: 'data-dir', changed: false });
      expect(countUsers(path.join(dataDir, 'app.db'))).toBe(5);
      expect(fs.existsSync(archivedDir)).toBe(false);
      expect(fs.readFileSync(path.join(target, '.env'), 'utf8')).toContain(archivedDir);
    });

    it('without --with-env the checkout’s own env files decide', async () => {
      const archivedDir = freshFolder();
      const archive = await backupNaming(archivedDir);
      const target = makeCheckout();
      const mine = tempDir('examify-data-mine-');
      write(path.join(target, '.env'), `EXAMIFY_DATA_DIR=${mine}\n`);
      const result = await run(['restore', archive, '--repo', target, '--json']);
      expect(result.code, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout) as Report;
      expect(report.target).toMatchObject({ source: 'env', changed: false });
      expect(report.dataDir).toBe(mine);
      expect(countUsers(path.join(mine, 'app.db'))).toBe(5);
      expect(fs.existsSync(archivedDir)).toBe(false);
      expect(fs.readFileSync(path.join(target, '.env'), 'utf8')).toBe(`EXAMIFY_DATA_DIR=${mine}\n`);
    });

    it('resolves in next start order across the archived and current env files', async () => {
      const inEnv = freshFolder();
      const inEnvLocal = freshFolder();
      const archive = await backupNaming(inEnv, `EXAMIFY_DATA_DIR=${inEnvLocal}\n`);
      const productionLocal = freshFolder();
      const host = tempDir('examify-data-host-');
      const cases: Array<{ files: Record<string, string>; env: Env; want: string }> = [
        // The archived .env.local beats the archived .env and a current .env.production.
        {
          files: { '.env.production': `EXAMIFY_DATA_DIR=${freshFolder()}\n` },
          env: {},
          want: inEnvLocal,
        },
        // A current .env.production.local beats every archived file.
        {
          files: { '.env.production.local': `EXAMIFY_DATA_DIR=${productionLocal}\n` },
          env: {},
          want: productionLocal,
        },
        // Non-blank process env beats every file.
        { files: {}, env: { EXAMIFY_DATA_DIR: host }, want: host },
      ];
      for (const { files, env: extra, want } of cases) {
        const target = makeCheckout();
        for (const [name, body] of Object.entries(files)) write(path.join(target, name), body);
        const env = { EXAMIFY_SQLITE_MODULE: SQLITE_MODULE, ...extra };
        const argv = ['restore', archive, '--repo', target, '--with-env', '--json'];
        const result = await run(argv, { env });
        expect(result.code, result.stderr).toBe(0);
        expect((JSON.parse(result.stdout) as Report).dataDir).toBe(want);
        expect(countUsers(path.join(want, 'app.db'))).toBe(5);
        expect(data.resolveRepoDataPaths(target, env).dataDir).toBe(want);
      }
      expect(fs.existsSync(inEnv)).toBe(false);
    });

    it('refuses an archived .env that names an unsafe folder, changing nothing', async () => {
      const archive = await backupNaming('content/family');
      const target = makeCheckout();
      const result = await run(['restore', archive, '--repo', target, '--with-env', '--json']);
      expect(result.code).toBe(3);
      expect(JSON.parse(result.stdout)).toMatchObject({
        error: 'unsafe_data_dir',
        reason: 'inside_checkout',
      });
      expect(fs.existsSync(path.join(target, 'data'))).toBe(false);
      expect(fs.existsSync(path.join(target, '.env'))).toBe(false);
      expect(git(target, 'status', '--porcelain', '--ignored')).toBe('');
    });

    it('refuses to move the data into a folder shared with other files', async () => {
      const archivedDir = tempDir('examify-data-shared-');
      write(path.join(archivedDir, 'someone-else.txt'), 'not examify');
      const archive = await backupNaming(archivedDir);
      const target = makeCheckout();
      const result = await run(['restore', archive, '--repo', target, '--with-env', '--json']);
      expect(result.code).toBe(5);
      expect(JSON.parse(result.stdout)).toMatchObject({ error: 'shared_folder' });
      expect(fs.readdirSync(archivedDir)).toEqual(['someone-else.txt']);
      expect(fs.existsSync(path.join(target, 'data'))).toBe(false);
    });
  });

  it('refuses a snapshot with more migrations than the checkout ships', async () => {
    const archive = await makeBackup({ migrations: JOURNAL_ENTRIES + 1 });
    const target = makeCheckout();
    const dataDir = tempDir('examify-data-newer-');
    const result = await run([
      'restore',
      archive,
      '--repo',
      target,
      '--data-dir',
      dataDir,
      '--json',
    ]);
    expect(result.code).toBe(5);
    expect(JSON.parse(result.stdout)).toMatchObject({ error: 'newer_snapshot' });
    expect(fs.existsSync(path.join(dataDir, 'app.db'))).toBe(false);
  });

  it('refuses while the app answers /api/health', async () => {
    const archive = await makeBackup();
    const target = makeCheckout();
    const server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const dataDir = tempDir('examify-data-running-');
      const result = await run(['restore', archive, '--repo', target, '--data-dir', dataDir], {
        env: { EXAMIFY_SQLITE_MODULE: SQLITE_MODULE, PORT: String(port) },
        probe: undefined,
      });
      expect(result.code).toBe(5);
      expect(result.stderr).toContain('stop the server');
      expect(fs.existsSync(path.join(dataDir, 'app.db'))).toBe(false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  describe('rejects unsafe archives before touching the target', () => {
    /** An archive whose MANIFEST lists `db/app.db`, plus whatever `build` adds. */
    function craft(build: (staging: string) => string[]): string {
      const staging = tempDir('examify-data-craft-');
      makeDb(path.join(staging, 'db', 'app.db'));
      const dbFile = path.join(staging, 'db', 'app.db');
      for (const suffix of ['-wal', '-shm']) fs.rmSync(`${dbFile}${suffix}`, { force: true });
      const manifest = {
        format: 1,
        files: [{ path: 'db/app.db', sha256: sha256(dbFile), size: fs.statSync(dbFile).size }],
      };
      write(path.join(staging, 'MANIFEST.json'), JSON.stringify(manifest));
      const archive = path.join(tempDir('examify-data-crafted-'), 'bad.tar.gz');
      execFileSync('tar', [
        '-czPf',
        archive,
        '-C',
        staging,
        'MANIFEST.json',
        'db',
        ...build(staging),
      ]);
      return archive;
    }

    async function expectRejected(archive: string, why: RegExp) {
      const target = makeCheckout();
      const dataDir = tempDir('examify-data-victim-');
      const result = await run([
        'restore',
        archive,
        '--repo',
        target,
        '--data-dir',
        dataDir,
        '--force',
        '--json',
      ]);
      expect(result.code).toBe(1);
      const report = JSON.parse(result.stdout) as { error: string; message: string };
      expect(report.error).toBe('archive_invalid');
      expect(report.message).toMatch(why);
      expect(fs.existsSync(path.join(dataDir, 'app.db'))).toBe(false);
      expect(fs.readdirSync(dataDir)).toEqual([]);
    }

    it('a symlink member', async () => {
      await expectRejected(
        craft((staging) => {
          fs.mkdirSync(path.join(staging, 'family'));
          fs.symlinkSync('/etc/passwd', path.join(staging, 'family', 'link'));
          return ['family'];
        }),
        /link or special file/,
      );
    });

    it('a hardlink member', async () => {
      await expectRejected(
        craft((staging) => {
          write(path.join(staging, 'family/content/subjects/x/a.txt'), 'a');
          fs.linkSync(
            path.join(staging, 'family/content/subjects/x/a.txt'),
            path.join(staging, 'family/content/subjects/x/b.txt'),
          );
          return ['family'];
        }),
        /link or special file/,
      );
    });

    it('a .. member', async () => {
      await expectRejected(
        craft((staging) => {
          write(path.join(staging, 'evil.txt'), 'evil');
          return ['--transform', 's,^evil.txt$,../evil.txt,', 'evil.txt'];
        }),
        /path with \.\./,
      );
    });

    it('an absolute member', async () => {
      const outside = tempDir('examify-data-abs-');
      const evil = path.join(outside, 'evil.txt');
      write(evil, 'evil');
      await expectRejected(
        craft(() => [evil]),
        /absolute path/,
      );
    });

    it('a file that does not match its MANIFEST hash', async () => {
      const archive = await makeBackup();
      const dir = extract(archive);
      write(path.join(dir, 'family/content/generated/keys/history.json'), '{"tampered":true}');
      const tampered = path.join(tempDir('examify-data-tampered-'), 'tampered.tar.gz');
      execFileSync('tar', ['-czf', tampered, '-C', dir, 'MANIFEST.json', 'db', 'family', 'env']);
      await expectRejected(tampered, /does not match its MANIFEST.json hash/);
    });
  });
});

describe('legacy-check', () => {
  it('passes a clean checkout and ignores OS junk', async () => {
    const root = makeCheckout();
    write(path.join(root, 'content/subjects/demo/.DS_Store'), 'junk');
    write(path.join(root, 'content/subjects/biology/Thumbs.db'), 'junk');
    const result = await run(['legacy-check', '--repo', root, '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      checked: true,
      legacy: false,
      items: [],
    });
  });

  it('exits 4 with the list when family content is still in the checkout', async () => {
    const root = makeCheckout();
    write(
      path.join(root, 'content/subjects/history/subject.json'),
      JSON.stringify(subject('history', 'History')),
    );
    write(path.join(root, 'content/source-pdfs/history/a.pdf'), '%PDF');
    fs.appendFileSync(path.join(root, 'src/lib/exam/generated-public.ts'), '// edited\n');
    const result = await run(['legacy-check', '--repo', root, '--json']);
    expect(result.code).toBe(4);
    const report = JSON.parse(result.stdout) as {
      error: string;
      items: Array<{ kind: string; path: string }>;
    };
    expect(report.error).toBe('legacy_content');
    expect(report.items).toEqual(
      expect.arrayContaining([
        { kind: 'subject', path: 'content/subjects/history' },
        expect.objectContaining({ kind: 'source-pdfs', path: 'content/source-pdfs' }),
        { kind: 'registrar', path: 'src/lib/exam/generated-public.ts' },
      ]),
    );
    expect(data.detectLegacyCheckoutContent(root)).toMatchObject({ checked: true, legacy: true });
  });

  it('reports checked:false outside a git checkout', () => {
    const root = tempDir('examify-data-nogit-');
    write(path.join(root, 'package.json'), JSON.stringify({ name: 'project-examify' }));
    expect(data.detectLegacyCheckoutContent(root)).toEqual({
      checked: false,
      reason: 'not_a_git_checkout',
      legacy: false,
      items: [],
    });
  });
});

describe('migrate-checkout', () => {
  const IR = (id: string, label: string, extra = '') =>
    `${JSON.stringify({ version: 1, subject: subject(id, label), difficulties: { easy: [], medium: [], hard: [] }, extra }, null, 2)}\n`;

  /** The old runtime's leftovers: every kind of family content mixed into the checkout. */
  function dirtyCheckout(): string {
    const root = makeCheckout();
    const at = (rel: string) => path.join(root, rel);
    write(
      at('content/subjects/history/subject.json'),
      JSON.stringify(subject('history', 'History')),
    );
    write(at('content/subjects/history/bank.ir.json'), IR('history', 'History'));
    write(at('content/subjects/history/notes.md'), '# the romans');
    fs.appendFileSync(at('content/subjects/biology/bank.ir.json'), '\n');
    write(at('content/subjects/demo/bank.ir.json'), IR('demo', 'Generate demo'));
    write(at('content/source-pdfs/history/a.pdf'), '%PDF-1.4 history');
    write(at('content/source-pdfs/demo/b.pdf'), '%PDF-1.4 demo');
    const committed = JSON.parse(
      fs.readFileSync(at('content/generated/subjects.json'), 'utf8'),
    ) as unknown[];
    write(
      at('content/generated/subjects.json'),
      JSON.stringify(
        [...committed, subject('history', 'History'), subject('demo', 'Generate demo')],
        null,
        2,
      ),
    );
    for (const id of ['history', 'demo']) {
      write(at(`content/generated/questions/${id}.json`), `{"easy":[{"id":"${id}-1"}]}`);
      write(at(`content/generated/keys/${id}.json`), `{"${id}-1":{"answer":0}}`);
    }
    fs.appendFileSync(at('content/generated/questions/biology.json'), '\n');
    fs.appendFileSync(at('content/generated/keys/biology.json'), '\n');
    fs.appendFileSync(
      at('src/lib/exam/generated-public.ts'),
      "import h from '../../../content/generated/questions/history.json';\n",
    );
    write(at('.examify-ingest/runs/history.json'), '{"run":1}');
    write(at('.examify-ingest/cache/ir/abc.json'), '{"cache":1}');
    write(at('content/subjects/demo/.DS_Store'), 'junk');
    write(at('content/source-pdfs/.DS_Store'), 'junk');
    write(at('content/subjects/biology/Thumbs.db'), 'junk');
    return root;
  }

  /** A data folder with a database: migrate-checkout backs it up before moving anything. */
  function familyFolder(prefix: string): string {
    const dir = tempDir(prefix);
    makeDb(path.join(dir, 'app.db'));
    return dir;
  }

  function nonJunkStatus(root: string): string[] {
    return git(
      root,
      'status',
      '--porcelain',
      '--ignored=traditional',
      '--untracked-files=all',
      '--',
      'content',
      '.examify-ingest',
      'src',
    )
      .split('\n')
      .filter(Boolean)
      .filter((line) => !data.isJunkName(path.basename(line.slice(3))));
  }

  it('copies everything, verifies it, cleans the checkout, and is a no-op the second time', async () => {
    const root = dirtyCheckout();
    const dataDir = familyFolder('examify-data-migrate-');
    const snapshots = new Map(
      [
        'content/subjects/history/bank.ir.json',
        'content/subjects/biology/bank.ir.json',
        'content/subjects/demo/bank.ir.json',
        'content/generated/questions/history.json',
        'content/generated/keys/demo.json',
        'content/generated/questions/biology.json',
      ].map((rel) => [rel, fs.readFileSync(path.join(root, rel), 'utf8')]),
    );
    const sha = head(root);

    const result = await run(['migrate-checkout', '--repo', root, '--data-dir', dataDir, '--json']);
    expect(result.code, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as data.MigrateResult;
    // It backed up the checkout as it was first (a --rollback / restore point).
    expect(report.backup).toMatchObject({ taken: true });
    expect(path.dirname(report.backup!.archive)).toBe(path.join(dataDir, 'backups'));
    expect(report.subjects.map((s) => s.id).sort()).toEqual(['biology', 'demo', 'history']);
    expect(report.registrars).toEqual(['src/lib/exam/generated-public.ts']);
    expect(report.conflicts).toEqual([]);

    const inData = (rel: string) => path.join(dataDir, rel);
    for (const [rel, body] of snapshots)
      expect(fs.readFileSync(inData(rel), 'utf8'), rel).toBe(body);
    for (const rel of [
      'content/subjects/history/notes.md',
      'content/subjects/history/subject.json',
      'content/subjects/demo/notes.txt',
      'content/subjects/demo/subject.json',
      'content/source-pdfs/history/a.pdf',
      'content/source-pdfs/demo/b.pdf',
      '.examify-ingest/runs/history.json',
      '.examify-ingest/cache/ir/abc.json',
    ]) {
      expect(fs.existsSync(inData(rel)), rel).toBe(true);
    }
    expect(fs.existsSync(inData('content/subjects/demo/.DS_Store'))).toBe(false);
    const catalog = JSON.parse(
      fs.readFileSync(inData('content/generated/subjects.json'), 'utf8'),
    ) as Array<{ id: string }>;
    expect(catalog.map((row) => row.id)).toEqual(['biology', 'history', 'demo']);
    for (const id of ['biology', 'history', 'demo']) {
      expect(mode(inData(`content/generated/keys/${id}.json`))).toBe(0o600);
      expect(fs.existsSync(inData(`content/generated/questions/${id}.json`))).toBe(true);
    }
    const marker = JSON.parse(fs.readFileSync(inData('.examify-data.json'), 'utf8')) as {
      migrations: Array<Record<string, unknown>>;
    };
    expect(marker.migrations).toEqual([
      expect.objectContaining({
        id: 'checkout-content-v1',
        fromSha: sha,
        conflicts: [],
        hiddenCommitted: [],
      }),
    ]);
    expect(fs.existsSync(inData('.migrate-journal.json'))).toBe(false);

    // The checkout is back to HEAD; only OS junk is left.
    expect(nonJunkStatus(root)).toEqual([]);
    expect(fs.existsSync(path.join(root, 'content/subjects/history'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'content/source-pdfs'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.examify-ingest'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'content/subjects/biology/bank.ir.json'), 'utf8')).toBe(
      fs.readFileSync(path.join(REPO, 'content/subjects/biology/bank.ir.json'), 'utf8'),
    );

    const again = await run(['migrate-checkout', '--repo', root, '--data-dir', dataDir, '--json']);
    expect(again.code).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({ noop: true });
    const markerAgain = JSON.parse(fs.readFileSync(inData('.examify-data.json'), 'utf8')) as {
      migrations: unknown[];
    };
    expect(markerAgain.migrations).toHaveLength(1);
    expect((await run(['legacy-check', '--repo', root])).code).toBe(0);

    const verified = await run(['verify', '--repo', root, '--data-dir', dataDir, '--json']);
    expect(verified.code, verified.stdout).toBe(0);
  });

  it('--dry-run prints the plan and writes nothing', async () => {
    const root = dirtyCheckout();
    const dataDir = path.join(tempDir('examify-data-dry-'), 'family');
    const before = git(
      root,
      'status',
      '--porcelain',
      '--ignored=traditional',
      '--untracked-files=all',
    );
    const result = await run([
      'migrate-checkout',
      '--repo',
      root,
      '--data-dir',
      dataDir,
      '--dry-run',
      '--json',
    ]);
    expect(result.code, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as data.MigrateResult;
    expect(report.dryRun).toBe(true);
    expect(report.copies).toContainEqual({
      path: 'content/subjects/history/notes.md',
      action: 'copy',
    });
    expect(fs.existsSync(dataDir)).toBe(false);
    expect(
      git(root, 'status', '--porcelain', '--ignored=traditional', '--untracked-files=all'),
    ).toBe(before);
  });

  it('never overwrites a differing destination: the checkout copy goes to migration-conflicts', async () => {
    const root = dirtyCheckout();
    const dataDir = familyFolder('examify-data-conflict-');
    write(path.join(dataDir, 'content/subjects/history/notes.md'), '# newer notes');
    // A differing family catalog row makes the whole generated subject a conflict.
    write(
      path.join(dataDir, 'content/generated/subjects.json'),
      JSON.stringify([subject('history', 'Newer History')]),
    );
    write(path.join(dataDir, 'content/generated/questions/history.json'), '{"newer":true}');
    const result = await run(['migrate-checkout', '--repo', root, '--data-dir', dataDir, '--json']);
    expect(result.code, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as data.MigrateResult;
    const conflictRoot = path.dirname(
      path.dirname(
        path.dirname(path.dirname(report.conflicts!.find((rel) => rel.endsWith('notes.md'))!)),
      ),
    );
    expect(conflictRoot).toMatch(/^migration-conflicts\/\d{8}T\d{6}Z$/);
    expect(fs.readFileSync(path.join(dataDir, 'content/subjects/history/notes.md'), 'utf8')).toBe(
      '# newer notes',
    );
    expect(
      fs.readFileSync(
        path.join(dataDir, conflictRoot, 'content/subjects/history/notes.md'),
        'utf8',
      ),
    ).toBe('# the romans');
    expect(
      fs.readFileSync(path.join(dataDir, 'content/generated/questions/history.json'), 'utf8'),
    ).toBe('{"newer":true}');
    expect(fs.existsSync(path.join(dataDir, 'content/generated/keys/history.json'))).toBe(false);
    for (const rel of ['questions/history.json', 'keys/history.json', 'subjects.json']) {
      expect(fs.existsSync(path.join(dataDir, conflictRoot, 'content/generated', rel)), rel).toBe(
        true,
      );
    }
    expect(mode(path.join(dataDir, conflictRoot, 'content/generated/keys/history.json'))).toBe(
      0o600,
    );
    const catalog = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'content/generated/subjects.json'), 'utf8'),
    ) as Array<{ id: string; label: string }>;
    expect(catalog).toEqual([
      expect.objectContaining({ id: 'history', label: 'Newer History' }),
      expect.objectContaining({ id: 'biology' }),
      expect.objectContaining({ id: 'demo' }),
    ]);
    expect(nonJunkStatus(root)).toEqual([]);
  });

  it('overwrites what an unfinished earlier run wrote (journal), not someone else’s file', async () => {
    const root = dirtyCheckout();
    const dataDir = familyFolder('examify-data-journal-');
    const rel = 'content/subjects/history/notes.md';
    write(path.join(dataDir, rel), '# copied by the first run');
    write(
      path.join(dataDir, '.migrate-journal.json'),
      JSON.stringify({
        id: 'checkout-content-v1',
        written: { [rel]: sha256(path.join(dataDir, rel)) },
      }),
    );
    const result = await run(['migrate-checkout', '--repo', root, '--data-dir', dataDir, '--json']);
    expect(result.code, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as data.MigrateResult;
    expect(report.overwritten).toBe(1);
    expect(report.conflicts).toEqual([]);
    expect(fs.readFileSync(path.join(dataDir, rel), 'utf8')).toBe('# the romans');
    expect(fs.existsSync(path.join(dataDir, '.migrate-journal.json'))).toBe(false);
  });

  it('leaves the checkout untouched when a copy fails', async () => {
    const root = dirtyCheckout();
    const dataDir = familyFolder('examify-data-copyfail-');
    write(path.join(dataDir, 'content/source-pdfs'), 'a file where a folder must go');
    const before = git(
      root,
      'status',
      '--porcelain',
      '--ignored=traditional',
      '--untracked-files=all',
    );
    const result = await run(['migrate-checkout', '--repo', root, '--data-dir', dataDir]);
    expect(result.code).toBe(1);
    expect(
      git(root, 'status', '--porcelain', '--ignored=traditional', '--untracked-files=all'),
    ).toBe(before);
    const marker = JSON.parse(
      fs.readFileSync(path.join(dataDir, '.examify-data.json'), 'utf8'),
    ) as { migrations: unknown[] };
    expect(marker.migrations).toEqual([]);
  });

  it('copies through symlinks and removes only the links, never their targets', async () => {
    const root = makeCheckout();
    const nas = tempDir('examify-data-nas-');
    write(path.join(nas, 'history/a.pdf'), '%PDF nas');
    write(path.join(nas, 'single.pdf'), '%PDF single');
    fs.mkdirSync(path.join(root, 'content/source-pdfs'), { recursive: true });
    fs.symlinkSync(path.join(nas, 'history'), path.join(root, 'content/source-pdfs/history'));
    fs.symlinkSync(path.join(nas, 'single.pdf'), path.join(root, 'content/source-pdfs/demo.pdf'));
    const dataDir = familyFolder('examify-data-links-');
    const result = await run(['migrate-checkout', '--repo', root, '--data-dir', dataDir, '--json']);
    expect(result.code, result.stderr).toBe(0);
    const copied = path.join(dataDir, 'content/source-pdfs/history/a.pdf');
    expect(fs.lstatSync(copied).isFile()).toBe(true);
    expect(fs.readFileSync(copied, 'utf8')).toBe('%PDF nas');
    expect(fs.readFileSync(path.join(dataDir, 'content/source-pdfs/demo.pdf'), 'utf8')).toBe(
      '%PDF single',
    );
    expect(fs.existsSync(path.join(root, 'content/source-pdfs'))).toBe(false);
    expect(fs.readFileSync(path.join(nas, 'history/a.pdf'), 'utf8')).toBe('%PDF nas');
    expect(fs.readFileSync(path.join(nas, 'single.pdf'), 'utf8')).toBe('%PDF single');
    // A committed subject with family PDFs keeps its tracked folder in the data folder.
    expect(JSON.parse(result.stdout)).toMatchObject({
      subjects: [{ id: 'demo', reason: 'has-family-content' }],
    });
    expect(fs.existsSync(path.join(dataDir, 'content/subjects/demo/subject.json'))).toBe(true);
  });

  it('reports a deleted built-in subject and restores it', async () => {
    const root = makeCheckout();
    fs.rmSync(path.join(root, 'content/subjects/demo'), { recursive: true });
    const dataDir = familyFolder('examify-data-hidden-');
    const result = await run(['migrate-checkout', '--repo', root, '--data-dir', dataDir, '--json']);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ hiddenCommitted: ['demo'] });
    expect(fs.existsSync(path.join(root, 'content/subjects/demo/notes.txt'))).toBe(true);
    const marker = JSON.parse(
      fs.readFileSync(path.join(dataDir, '.examify-data.json'), 'utf8'),
    ) as {
      migrations: Array<{ hiddenCommitted: string[] }>;
    };
    expect(marker.migrations[0]?.hiddenCommitted).toEqual(['demo']);
  });

  it('rebuilds a missing catalog row from the subject IR', async () => {
    const root = makeCheckout();
    write(path.join(root, 'content/subjects/history/bank.ir.json'), IR('history', 'History'));
    write(path.join(root, 'content/generated/questions/history.json'), '{}');
    write(path.join(root, 'content/generated/keys/history.json'), '{}');
    const dataDir = familyFolder('examify-data-rebuild-');
    const result = await run(['migrate-checkout', '--repo', root, '--data-dir', dataDir, '--json']);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      generated: [{ id: 'history', rowSource: 'bank.ir.json' }],
    });
    const catalog = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'content/generated/subjects.json'), 'utf8'),
    ) as unknown[];
    expect(catalog).toEqual([
      { ...subject('history', 'History'), rev: data.generatedRevision('{}', '{}') },
    ]);
  });

  it('gives each migrated family row the rev of the files it copied, so a half Apply is caught', async () => {
    const root = makeCheckout();
    const questions = '{"easy":[{"id":"history-easy-1"}]}\n';
    const keys = '{"history-easy-1":{"type":"mcq","answer":0}}\n';
    write(
      path.join(root, 'content/generated/subjects.json'),
      JSON.stringify([subject('history', 'History')]),
    );
    write(path.join(root, 'content/generated/questions/history.json'), questions);
    write(path.join(root, 'content/generated/keys/history.json'), keys);
    const dataDir = familyFolder('examify-data-migrated-rev-');
    const result = await run(['migrate-checkout', '--repo', root, '--data-dir', dataDir, '--json']);
    expect(result.code, result.stderr).toBe(0);
    const generated = path.join(dataDir, 'content/generated');
    const catalog = JSON.parse(fs.readFileSync(path.join(generated, 'subjects.json'), 'utf8'));
    expect(catalog).toEqual([
      { ...subject('history', 'History'), rev: data.generatedRevision(questions, keys) },
    ]);
    const env = { EXAMIFY_DATA_DIR: dataDir, EXAMIFY_SQLITE_MODULE: SQLITE_MODULE };
    expect((await run(['verify', '--repo', root], { env })).code).toBe(0);
    // The next Apply's questions are written before its keys and catalog: that
    // half-written state is visible (the live bank serves the old revision).
    write(path.join(generated, 'questions/history.json'), '{"easy":[]}\n');
    const half = await run(['verify', '--repo', root, '--json'], { env });
    expect(half.code).toBe(6);
    expect(JSON.parse(half.stdout)).toMatchObject({
      failures: expect.arrayContaining([{ check: 'revision', detail: 'history' }]),
    });
  });

  it('refuses (changing nothing) when src/lib/exam has uncommitted hand edits', async () => {
    const root = dirtyCheckout();
    fs.appendFileSync(path.join(root, 'src/lib/exam/data.ts'), 'export const LOCAL = 2;\n');
    const dataDir = tempDir('examify-data-blocked-');
    const result = await run(['migrate-checkout', '--repo', root, '--data-dir', dataDir, '--json']);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ error: 'blocked' });
    expect(result.stderr).toContain('src/lib/exam/data.ts');
    expect(fs.readdirSync(dataDir)).toEqual([]);
    expect(fs.existsSync(path.join(root, 'content/subjects/history/notes.md'))).toBe(true);
  });

  it('rolls back: a pre-upgrade archive restores the checkout, the DB and .env as they were', async () => {
    const root = dirtyCheckout();
    const dataDir = tempDir('examify-data-rollback-');
    makeDb(path.join(dataDir, 'app.db'), { rows: 4 });
    write(path.join(root, '.env'), 'AUTH_SECRET=before-upgrade\n');
    const statusBefore = git(root, 'status', '--porcelain', '--untracked-files=all');
    const registrarBefore = fs.readFileSync(
      path.join(root, 'src/lib/exam/generated-public.ts'),
      'utf8',
    );
    const env = { EXAMIFY_DATA_DIR: dataDir, EXAMIFY_SQLITE_MODULE: SQLITE_MODULE };
    const pre = await data.backup({ repo: root, env, kind: 'pre-upgrade', includeCheckout: true });
    expect((await run(['migrate-checkout', '--repo', root], { env })).code).toBe(0);
    write(path.join(root, '.env'), 'AUTH_SECRET=after-upgrade\n');

    const result = await run(
      [
        'restore',
        pre.archive,
        '--repo',
        root,
        '--force',
        '--with-env',
        '--include-checkout',
        '--json',
      ],
      { env },
    );
    expect(result.code, result.stderr).toBe(0);
    expect(git(root, 'status', '--porcelain', '--untracked-files=all')).toBe(statusBefore);
    expect(fs.readFileSync(path.join(root, 'src/lib/exam/generated-public.ts'), 'utf8')).toBe(
      registrarBefore,
    );
    expect(fs.readFileSync(path.join(root, 'content/source-pdfs/history/a.pdf'), 'utf8')).toBe(
      '%PDF-1.4 history',
    );
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe('AUTH_SECRET=before-upgrade\n');
    expect(countUsers(path.join(dataDir, 'app.db'))).toBe(4);
    // The migrated content and its marker entry are aside, so a later upgrade migrates again.
    const { movedAside } = JSON.parse(result.stdout) as { movedAside: string };
    expect(fs.existsSync(path.join(movedAside, 'content/subjects/history/notes.md'))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'content'))).toBe(false);
    const marker = JSON.parse(
      fs.readFileSync(path.join(dataDir, '.examify-data.json'), 'utf8'),
    ) as { migrations: unknown[] };
    expect(marker.migrations).toEqual([]);
    expect(data.detectLegacyCheckoutContent(root)).toMatchObject({ legacy: true });
  });

  it('refuses to restore checkout files through a symlinked folder, before moving anything', async () => {
    const root = dirtyCheckout();
    const dataDir = tempDir('examify-data-restore-link-');
    makeDb(path.join(dataDir, 'app.db'));
    const env = { EXAMIFY_DATA_DIR: dataDir, EXAMIFY_SQLITE_MODULE: SQLITE_MODULE };
    const pre = await data.backup({ repo: root, env, kind: 'pre-upgrade', includeCheckout: true });
    fs.rmSync(path.join(root, 'content/source-pdfs'), { recursive: true });
    const elsewhere = tempDir('examify-data-elsewhere-');
    fs.symlinkSync(elsewhere, path.join(root, 'content/source-pdfs'));
    const dbBefore = sha256(path.join(dataDir, 'app.db'));
    const result = await run(
      ['restore', pre.archive, '--repo', root, '--force', '--include-checkout', '--json'],
      { env },
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ error: 'symlink_in_checkout' });
    expect(sha256(path.join(dataDir, 'app.db'))).toBe(dbBefore);
    expect(fs.readdirSync(dataDir).some((name) => name.startsWith('before-restore'))).toBe(false);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it('does not count hand edits in src/lib/exam as legacy content', async () => {
    const root = makeCheckout();
    fs.appendFileSync(path.join(root, 'src/lib/exam/data.ts'), 'export const LOCAL = 2;\n');
    expect(data.detectLegacyCheckoutContent(root)).toMatchObject({ legacy: false });
    const dataDir = tempDir('examify-data-hand-edits-');
    const result = await run(['migrate-checkout', '--repo', root, '--data-dir', dataDir, '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ noop: true });
  });
});

describe('verify', () => {
  function verifiedSetup() {
    const root = makeCheckout();
    const dataDir = tempDir('examify-data-verify-');
    makeDb(path.join(dataDir, 'app.db'));
    seedFamily(dataDir);
    return { root, dataDir, argv: ['verify', '--repo', root, '--data-dir', dataDir, '--json'] };
  }

  it('passes a healthy install', async () => {
    const { argv } = verifiedSetup();
    const result = await run(argv);
    expect(result.code, result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, failures: [] });
  });

  it('exits 6 with the list of failures', async () => {
    const { root, dataDir, argv } = verifiedSetup();
    fs.chmodSync(path.join(dataDir, 'content/generated/keys/history.json'), 0o644);
    fs.rmSync(path.join(dataDir, 'content/generated/questions/history.json'));
    write(path.join(root, 'content/source-pdfs/x/a.pdf'), '%PDF');
    fs.appendFileSync(path.join(root, 'src/lib/exam/generated-keys.server.ts'), '// edited\n');
    const result = await run(argv);
    expect(result.code).toBe(6);
    const report = JSON.parse(result.stdout) as data.VerifyResult;
    expect(report.failures.map((failure) => failure.check).sort()).toEqual([
      'checkout',
      'checkout',
      'family catalog',
      'keys permissions',
    ]);
  });

  it('fails when the database is missing', async () => {
    const { dataDir, argv } = verifiedSetup();
    fs.rmSync(path.join(dataDir, 'app.db'));
    const result = await run(argv);
    expect(result.code).toBe(6);
    expect(result.stderr).toContain('database');
  });
});

describe('the upstream copy', () => {
  it('runs from outside the checkout against it with --repo and --sqlite-module', () => {
    const root = makeCheckout();
    const dataDir = tempDir('examify-data-upstream-');
    makeDb(path.join(dataDir, 'app.db'));
    const copy = path.join(tempDir('examify-data-tmp-'), 'examify-data.mjs');
    fs.copyFileSync(SCRIPT, copy);
    const result = cli(
      [
        'backup',
        '--repo',
        root,
        '--kind',
        'pre-upgrade',
        '--include-checkout',
        '--sqlite-module',
        SQLITE_MODULE,
        '--json',
      ],
      {
        cwd: os.tmpdir(),
        env: { PATH: process.env.PATH ?? '', EXAMIFY_DATA_DIR: dataDir },
        script: copy,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, kind: 'pre-upgrade' });
  });
});

describe('review regressions', () => {
  /** A data folder with a database (migrate-checkout backs it up first). */
  function familyFolder(prefix: string): string {
    const dir = tempDir(prefix);
    makeDb(path.join(dir, 'app.db'));
    return dir;
  }

  function fullStatus(root: string): string {
    return git(
      root,
      'status',
      '--porcelain',
      '--ignored=traditional',
      '--untracked-files=all',
      '--',
      'content',
      '.examify-ingest',
      'src',
    );
  }

  function manifestOf(archive: string): Manifest {
    return JSON.parse(
      execFileSync('tar', ['-xOzf', archive, 'MANIFEST.json'], { encoding: 'utf8' }),
    ) as Manifest;
  }

  it('removes nested empty and junk-only folders, so the next legacy-check passes', async () => {
    const root = makeCheckout();
    const dataDir = familyFolder('examify-data-nested-');
    write(path.join(root, 'content/subjects/history/subject.json'), '{"id":"history"}');
    fs.mkdirSync(path.join(root, 'content/subjects/history/images/2024'), { recursive: true });
    write(path.join(root, 'content/source-pdfs/history/a.pdf'), '%PDF-1.4 history');
    // A detached upload leaves its subject folder behind; the cache leaves ir/.
    fs.mkdirSync(path.join(root, 'content/source-pdfs/geography'), { recursive: true });
    write(path.join(root, 'content/source-pdfs/maths/.DS_Store'), 'junk');
    fs.mkdirSync(path.join(root, '.examify-ingest/cache/ir'), { recursive: true });
    // A linked folder is removed as a link; what it points at is left alone.
    const elsewhere = tempDir('examify-data-linked-');
    fs.symlinkSync(elsewhere, path.join(root, 'content/source-pdfs/linked'));

    const result = await run(['migrate-checkout', '--repo', root, '--data-dir', dataDir, '--json']);
    expect(result.code, result.stderr).toBe(0);
    for (const rel of ['content/source-pdfs', '.examify-ingest', 'content/subjects/history']) {
      expect(fs.existsSync(path.join(root, rel)), rel).toBe(false);
    }
    expect(fs.existsSync(elsewhere)).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'content/source-pdfs/history/a.pdf'))).toBe(true);
    expect((await run(['legacy-check', '--repo', root])).code).toBe(0);
    expect(fullStatus(root)).toBe('');
  });

  it('a checkout holding only empty leftover folders is cleaned without a backup', async () => {
    const root = makeCheckout();
    const dataDir = familyFolder('examify-data-empty-only-');
    fs.mkdirSync(path.join(root, 'content/source-pdfs/geography'), { recursive: true });
    fs.mkdirSync(path.join(root, '.examify-ingest/cache/ir'), { recursive: true });
    expect((await run(['legacy-check', '--repo', root])).code).toBe(4);

    const result = await run(['migrate-checkout', '--repo', root, '--data-dir', dataDir]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      'Removed empty folders left in the checkout: content/source-pdfs, .examify-ingest',
    );
    expect(fs.existsSync(path.join(root, 'content/source-pdfs'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.examify-ingest'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'backups'))).toBe(false);
    expect((await run(['legacy-check', '--repo', root])).code).toBe(0);
  });

  describe('a standalone migrate-checkout backs up what it reverts', () => {
    /** Tracked edits only a checkout backup holds: a registrar line, a catalog row with a bad id. */
    function editedCheckout(): string {
      const root = makeCheckout();
      write(path.join(root, 'content/subjects/history/subject.json'), '{"id":"history"}');
      fs.appendFileSync(
        path.join(root, 'src/lib/exam/generated-public.ts'),
        '// registered by hand\n',
      );
      const catalog = path.join(root, 'content/generated/subjects.json');
      const rows = JSON.parse(fs.readFileSync(catalog, 'utf8')) as unknown[];
      write(catalog, JSON.stringify([...rows, subject('Not An Id', 'Broken')], null, 2));
      return root;
    }

    it('takes a pre-upgrade backup with the checkout before anything moves', async () => {
      const root = editedCheckout();
      const dataDir = familyFolder('examify-data-own-backup-');
      const edited = ['src/lib/exam/generated-public.ts', 'content/generated/subjects.json'].map(
        (rel) => [rel, sha256(path.join(root, rel))] as const,
      );
      const result = await run([
        'migrate-checkout',
        '--repo',
        root,
        '--data-dir',
        dataDir,
        '--json',
      ]);
      expect(result.code, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout) as data.MigrateResult;
      expect(report.backup).toMatchObject({ taken: true });
      const manifest = manifestOf(report.backup!.archive);
      expect(manifest).toMatchObject({ kind: 'pre-upgrade', checkout: { gitSha: head(root) } });
      for (const [rel, sum] of edited) {
        expect(manifest.files.find((file) => file.path === `checkout/${rel}`)?.sha256, rel).toBe(
          sum,
        );
      }
      // M4 reverted them; the backup brings them back.
      expect(fullStatus(root)).toBe('');
      const restored = await run([
        'restore',
        report.backup!.archive,
        '--repo',
        root,
        '--data-dir',
        dataDir,
        '--force',
        '--include-checkout',
      ]);
      expect(restored.code, restored.stderr).toBe(0);
      for (const [rel, sum] of edited) expect(sha256(path.join(root, rel)), rel).toBe(sum);
    });

    it('--backup refuses an archive that does not hold the files its MANIFEST lists', async () => {
      const root = editedCheckout();
      const dataDir = familyFolder('examify-data-repacked-backup-');
      const env = { EXAMIFY_DATA_DIR: dataDir, EXAMIFY_SQLITE_MODULE: SQLITE_MODULE };
      const current = await data.backup({
        repo: root,
        env,
        kind: 'pre-upgrade',
        includeCheckout: true,
      });
      const unpacked = tempDir('examify-data-repack-');
      execFileSync('tar', ['-xzf', current.archive, '-C', unpacked]);
      const out = tempDir('examify-data-repacked-');
      // A truncated copy: its MANIFEST alone.
      const manifestOnly = path.join(out, 'manifest-only.tar.gz');
      execFileSync('tar', ['-czf', manifestOnly, '-C', unpacked, 'MANIFEST.json']);
      // Repacked without the checkout copies this migration would revert.
      fs.rmSync(path.join(unpacked, 'checkout'), { recursive: true, force: true });
      const noCheckout = path.join(out, 'no-checkout.tar.gz');
      execFileSync('tar', ['-czf', noCheckout, '-C', unpacked, '.']);
      const statusBefore = fullStatus(root);
      expect(statusBefore).not.toBe('');

      for (const archive of [manifestOnly, noCheckout]) {
        const result = await run(
          ['migrate-checkout', '--repo', root, '--backup', archive, '--json'],
          { env },
        );
        expect(result.code, result.stderr).toBe(5);
        expect(JSON.parse(result.stdout)).toMatchObject({ error: 'backup_mismatch' });
        expect(result.stderr).toContain('is not a complete examify-data backup');
        expect(fs.existsSync(path.join(dataDir, 'content'))).toBe(false);
        expect(fullStatus(root)).toBe(statusBefore);
      }
      expect(fs.readdirSync(dataDir).filter((name) => name.startsWith('.restore-'))).toEqual([]);
    });

    it('--backup must hold this checkout at HEAD with the bytes it reverts', async () => {
      const root = editedCheckout();
      const dataDir = familyFolder('examify-data-given-backup-');
      const env = { EXAMIFY_DATA_DIR: dataDir, EXAMIFY_SQLITE_MODULE: SQLITE_MODULE };
      const manual = await data.backup({ repo: root, env });
      const before = await data.backup({
        repo: root,
        env,
        kind: 'pre-upgrade',
        includeCheckout: true,
      });
      const statusBefore = fullStatus(root);
      const argv = (archive: string) => ['migrate-checkout', '--repo', root, '--backup', archive];

      const noCheckout = await run([...argv(manual.archive), '--json'], { env });
      expect(noCheckout.code).toBe(5);
      expect(JSON.parse(noCheckout.stdout)).toMatchObject({ error: 'backup_mismatch' });

      // An edit made after that backup is not in it.
      fs.appendFileSync(path.join(root, 'src/lib/exam/generated-public.ts'), '// later\n');
      const stale = await run(argv(before.archive), { env });
      expect(stale.code).toBe(5);
      expect(stale.stderr).toContain('src/lib/exam/generated-public.ts');
      expect(fs.existsSync(path.join(dataDir, 'content'))).toBe(false);
      expect(fullStatus(root)).not.toBe('');

      const current = await data.backup({
        repo: root,
        env,
        kind: 'pre-upgrade',
        includeCheckout: true,
      });
      const archives = fs.readdirSync(path.join(dataDir, 'backups')).length;
      const ok = await run([...argv(current.archive), '--json'], { env });
      expect(ok.code, ok.stderr).toBe(0);
      expect(JSON.parse(ok.stdout)).toMatchObject({
        backup: { archive: current.archive, taken: false },
      });
      expect(fs.readdirSync(path.join(dataDir, 'backups'))).toHaveLength(archives);
      expect(statusBefore).not.toBe('');
    });
  });

  it('restore finishes when the target held a marker and entries init would call foreign', async () => {
    // A pre-data-folder archive has no marker; `backup --out <data>/archives` is legitimate.
    const source = makeCheckout();
    const sourceData = tempDir('examify-data-unmarked-src-');
    makeDb(path.join(sourceData, 'app.db'), { rows: 2 });
    const { archive } = await data.backup({
      repo: source,
      env: { EXAMIFY_DATA_DIR: sourceData },
      sqliteModule: SQLITE_MODULE,
      out: tempDir('examify-data-unmarked-out-'),
    });
    expect(manifestOf(archive).files.some((file) => file.path.endsWith('.examify-data.json'))).toBe(
      false,
    );
    const target = makeCheckout();
    const dataDir = familyFolder('examify-data-marked-');
    data.initDataFolder({ dataDir });
    write(path.join(dataDir, 'archives/examify-backup-x.tar.gz'), 'an archive');
    const result = await run([
      'restore',
      archive,
      '--repo',
      target,
      '--data-dir',
      dataDir,
      '--force',
      '--json',
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(countUsers(path.join(dataDir, 'app.db'))).toBe(2);
    expect(fs.existsSync(path.join(dataDir, '.examify-data.json'))).toBe(true);
    expect(fs.readFileSync(path.join(dataDir, 'archives/examify-backup-x.tar.gz'), 'utf8')).toBe(
      'an archive',
    );
  });

  it('a restore that fails after moving data aside says where that data is', async () => {
    const source = makeCheckout();
    const sourceData = tempDir('examify-data-aside-src-');
    makeDb(path.join(sourceData, 'app.db'));
    const { archive } = await data.backup({
      repo: source,
      env: { EXAMIFY_DATA_DIR: sourceData },
      sqliteModule: SQLITE_MODULE,
      out: tempDir('examify-data-aside-out-'),
    });
    const target = makeCheckout();
    const dataDir = tempDir('examify-data-aside-');
    write(path.join(dataDir, 'content/subjects/mine/subject.json'), '{"mine":true}');
    // The database can't be placed: its folder is a file.
    const blocker = path.join(tempDir('examify-data-blocker-'), 'blocker');
    write(blocker, 'not a folder');
    const env = {
      EXAMIFY_SQLITE_MODULE: SQLITE_MODULE,
      DATABASE_URL: `file:${path.join(blocker, 'app.db')}`,
    };
    const argv = ['restore', archive, '--repo', target, '--data-dir', dataDir, '--force'];
    const result = await run([...argv, '--json'], { env });
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as { movedAside: string };
    expect(path.dirname(report.movedAside)).toBe(dataDir);
    expect(result.stderr).toContain(report.movedAside);
    expect(fs.existsSync(path.join(report.movedAside, 'content/subjects/mine/subject.json'))).toBe(
      true,
    );
  });

  it('keeps a family file that `git rm --cached` untracked: git checkout brings it back', async () => {
    const root = makeCheckout();
    const dataDir = familyFolder('examify-data-rm-cached-');
    git(root, 'rm', '-q', '--cached', 'content/subjects/demo/notes.txt');
    const result = await run(['migrate-checkout', '--repo', root, '--data-dir', dataDir]);
    expect(result.code, result.stderr).toBe(0);
    expect(fullStatus(root)).toBe('');
    expect(fs.readFileSync(path.join(root, 'content/subjects/demo/notes.txt'), 'utf8')).toBe(
      fs.readFileSync(path.join(REPO, 'content/subjects/demo/notes.txt'), 'utf8'),
    );
    expect(fs.existsSync(path.join(dataDir, 'content/subjects/demo/notes.txt'))).toBe(true);
  });

  it('committed files with no family meaning are not legacy content', async () => {
    const root = makeCheckout();
    write(path.join(root, 'content/subjects/README.md'), '# subjects\n');
    write(path.join(root, 'content/generated/questions/README.md'), '# generated\n');
    write(path.join(root, 'content/subjects/_template/example.json'), '{}\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'docs');
    expect((await run(['legacy-check', '--repo', root])).code).toBe(0);
    const dataDir = familyFolder('examify-data-committed-docs-');
    const migrated = await run([
      'migrate-checkout',
      '--repo',
      root,
      '--data-dir',
      dataDir,
      '--json',
    ]);
    expect(migrated.code, migrated.stderr).toBe(0);
    expect(JSON.parse(migrated.stdout)).toMatchObject({ noop: true });
    // Editing one is still refused: git checkout would throw the edit away.
    fs.appendFileSync(path.join(root, 'content/subjects/README.md'), 'edited\n');
    const edited = await run(['legacy-check', '--repo', root, '--json']);
    expect(edited.code).toBe(4);
    expect(JSON.stringify(JSON.parse(edited.stdout))).toContain('content/subjects/README.md');
  });

  describe('backup reads its archive back', () => {
    const REAL_TAR = execFileSync('bash', ['-c', 'command -v tar'], { encoding: 'utf8' }).trim();

    /** A `tar` on PATH that damages what `tar -czf` writes. */
    function brokenTar(body: string): string {
      const dir = tempDir('examify-data-tar-');
      const shim = path.join(dir, 'tar');
      write(
        shim,
        `#!/usr/bin/env bash\nREAL=${JSON.stringify(REAL_TAR)}\n${body}\nexec "$REAL" "$@"\n`,
      );
      fs.chmodSync(shim, 0o755);
      return dir;
    }

    it.each([
      ['a truncated archive', 'if [ "$1" = "-czf" ]; then "$REAL" "$@" | head -c 64; exit 0; fi'],
      [
        'an archive without its MANIFEST.json',
        'if [ "$1" = "-czf" ]; then staging="$4"; shift 4; args=(); for a in "$@"; do [ "$a" = MANIFEST.json ] || args+=("$a"); done; exec "$REAL" -czf - -C "$staging" "${args[@]}"; fi',
      ],
    ])('refuses %s and leaves no archive behind', (_what, body) => {
      const root = makeCheckout();
      const dataDir = tempDir('examify-data-readback-');
      makeDb(path.join(dataDir, 'app.db'));
      const shimDir = brokenTar(body);
      const result = cli(['backup', '--repo', root, '--json'], {
        env: cliEnv({ EXAMIFY_DATA_DIR: dataDir, PATH: `${shimDir}:${process.env.PATH}` }),
      });
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ error: 'archive_unreadable' });
      expect(fs.readdirSync(path.join(dataDir, 'backups'))).toEqual([]);
    });

    it('reports a backup it read back as verified', async () => {
      const root = makeCheckout();
      const dataDir = tempDir('examify-data-verified-');
      makeDb(path.join(dataDir, 'app.db'));
      const result = await data.backup({
        repo: root,
        env: { EXAMIFY_DATA_DIR: dataDir },
        sqliteModule: SQLITE_MODULE,
      });
      expect(result.verified).toBe(true);
      expect(tarList(result.archive)).toContain('MANIFEST.json');
    });
  });
});

describe('backup placement and consistency', () => {
  it('restore never stages inside a folder shared with other software', async () => {
    const root = makeCheckout();
    // A corrupt archive: refusing the folder first means it is never even copied
    // or read there (otherwise this fails later as archive_invalid, exit 1).
    const archive = path.join(tempDir('examify-data-restore-src-'), 'examify-backup.tar.gz');
    write(archive, 'not a tar archive');
    const shared = tempDir('examify-data-restore-shared-');
    write(path.join(shared, 'someone-else.conf'), 'x');
    const before = fs.readdirSync(shared).sort();
    const result = await run(
      ['restore', archive, '--repo', root, '--data-dir', shared, '--force', '--json'],
      { env: { EXAMIFY_SQLITE_MODULE: SQLITE_MODULE } },
    );
    expect(result.code).toBe(5);
    expect(JSON.parse(result.stdout)).toMatchObject({ error: 'shared_folder' });
    expect(fs.readdirSync(shared).sort()).toEqual(before);
  });

  it('refuses to create backups/ in a folder shared with other software', async () => {
    const root = makeCheckout();
    const shared = tempDir('examify-data-shared-db-');
    makeDb(path.join(shared, 'examify.db'));
    write(path.join(shared, 'someone-else.conf'), 'x');
    const before = fs.readdirSync(shared).sort();
    const env = {
      EXAMIFY_SQLITE_MODULE: SQLITE_MODULE,
      DATABASE_URL: `file:${path.join(shared, 'examify.db')}`,
    };
    const result = await run(['backup', '--repo', root, '--json'], { env });
    expect(result.code).toBe(5);
    expect(JSON.parse(result.stdout)).toMatchObject({ error: 'shared_folder' });
    expect(fs.readdirSync(shared).sort()).toEqual(before);
    // An explicit --out elsewhere puts no backups/ there (SQLite's own -wal / -shm aside).
    const out = tempDir('examify-data-shared-out-');
    expect((await run(['backup', '--repo', root, '--out', out], { env })).code).toBe(0);
    expect(
      fs
        .readdirSync(shared)
        .filter((name) => !/-(wal|shm)$/.test(name))
        .sort(),
    ).toEqual(before);
  });

  describe('an Apply during the backup', () => {
    function setup() {
      const root = makeCheckout();
      const dataDir = tempDir('examify-data-apply-');
      makeDb(path.join(dataDir, 'app.db'));
      seedFamily(dataDir);
      const generated = path.join(dataDir, 'content/generated');
      /** What a wizard Apply writes: questions and keys of one revision. */
      const apply = (rev: number) => {
        write(path.join(generated, 'questions/history.json'), `{"rev":${rev}}`);
        write(path.join(generated, 'keys/history.json'), `{"rev":${rev}}`);
      };
      apply(1);
      return { root, dataDir, apply, out: tempDir('examify-data-apply-out-') };
    }

    // Staging walks keys/ before questions/: an Apply right after the key is
    // copied would pair revision 1 keys with revision 2 questions.
    const KEY = 'family/content/generated/keys/history.json';

    it('stages content/generated again, so questions and keys come from one Apply', async () => {
      const { root, dataDir, apply, out } = setup();
      let applies = 0;
      const result = await data.backup({
        repo: root,
        env: { EXAMIFY_DATA_DIR: dataDir },
        sqliteModule: SQLITE_MODULE,
        out,
        onFileStaged: (rel) => {
          if (rel === KEY && applies === 0) {
            applies += 1;
            apply(2);
          }
        },
      });
      expect(applies).toBe(1);
      const dir = extract(result.archive);
      const read = (rel: string) =>
        fs.readFileSync(path.join(dir, 'family/content/generated', rel), 'utf8');
      expect(read('questions/history.json')).toBe('{"rev":2}');
      expect(read('keys/history.json')).toBe('{"rev":2}');
      const listed = readManifest(dir).files.find((file) => file.path === KEY);
      expect(listed?.sha256).toBe(sha256(path.join(dir, KEY)));
    });

    it('fails with content_changing, and writes no archive, when Applies keep landing', async () => {
      const { root, dataDir, apply, out } = setup();
      let rev = 1;
      await expect(
        data.backup({
          repo: root,
          env: { EXAMIFY_DATA_DIR: dataDir },
          sqliteModule: SQLITE_MODULE,
          out,
          onFileStaged: (rel) => {
            if (rel === KEY) apply((rev += 1));
          },
        }),
      ).rejects.toMatchObject({ exitCode: 1, code: 'content_changing' });
      expect(rev).toBe(4);
      expect(fs.readdirSync(out)).toEqual([]);
    });
  });
});

describe('family catalog rows with rev', () => {
  /** A family folder whose history row names the questions + keys on disk. */
  function revisioned() {
    const root = makeCheckout();
    const dataDir = tempDir('examify-data-rev-');
    makeDb(path.join(dataDir, 'app.db'));
    seedFamily(dataDir);
    const generated = path.join(dataDir, 'content/generated');
    const read = (rel: string) => fs.readFileSync(path.join(generated, rel), 'utf8');
    const rev = data.generatedRevision(read('questions/history.json'), read('keys/history.json'));
    const catalog = path.join(generated, 'subjects.json');
    write(catalog, JSON.stringify([{ ...subject('history', 'History'), rev }]));
    return { root, dataDir, generated, catalog };
  }

  it('hashes like the app (parity with src/lib/exam/generated-revision.ts)', () => {
    for (const [questions, keys] of [
      ['', ''],
      ['{"easy":[]}\n', '{}\n'],
      ['{"q":"Ünïcode — ✓"}', '{"k":"\\n"}'],
    ]) {
      expect(data.generatedRevision(questions!, keys!)).toBe(
        tsGeneratedRevision(questions!, keys!),
      );
    }
  });

  it('verify passes a consistent family and backup copies the catalog verbatim', async () => {
    const { root, dataDir, catalog } = revisioned();
    const verified = await run(['verify', '--repo', root, '--data-dir', dataDir, '--json']);
    expect(verified.code, verified.stdout).toBe(0);
    const backedUp = await run(['backup', '--repo', root, '--data-dir', dataDir, '--json']);
    expect(backedUp.code, backedUp.stderr).toBe(0);
    const { archive, warnings } = JSON.parse(backedUp.stdout) as data.BackupResult;
    expect(warnings).toEqual([]);
    const dir = extract(archive);
    expect(fs.readFileSync(path.join(dir, 'family/content/generated/subjects.json'), 'utf8')).toBe(
      fs.readFileSync(catalog, 'utf8'),
    );
  });

  it('verify fails (exit 6) on an interrupted Apply: new questions, old keys and row', async () => {
    const { root, dataDir, generated } = revisioned();
    write(path.join(generated, 'questions/history.json'), '{"easy":[{"id":"history-easy-9"}]}');
    const result = await run(['verify', '--repo', root, '--data-dir', dataDir, '--json']);
    expect(result.code).toBe(6);
    expect((JSON.parse(result.stdout) as data.VerifyResult).failures).toEqual([
      { check: 'revision', detail: 'history' },
    ]);
  });
});

describe('every env file next start reads is backed up and restored', () => {
  const ENV_FILES = ['.env', '.env.local', '.env.production', '.env.production.local'] as const;

  it('archives all four and restores them with --with-env, keeping current ones aside', async () => {
    const source = makeCheckout();
    const sourceData = tempDir('examify-data-envs-src-');
    makeDb(path.join(sourceData, 'app.db'), { rows: 2 });
    const target = path.join(tempDir('examify-data-envs-machine-'), 'family-data');
    const bodies: Record<string, string> = {
      '.env': 'AUTH_SECRET=from-env\n',
      '.env.local': 'SMTP_FROM=local@example.com\n',
      '.env.production': 'SITE_URL=https://prod.example.com\n',
      // The highest-precedence file names the data folder.
      '.env.production.local': `EXAMIFY_DATA_DIR=${target}\n`,
    };
    for (const name of ENV_FILES) write(path.join(source, name), bodies[name]!);
    const { archive } = await data.backup({
      repo: source,
      env: { EXAMIFY_DATA_DIR: sourceData },
      sqliteModule: SQLITE_MODULE,
      out: tempDir('examify-data-envs-out-'),
    });
    const manifest = JSON.parse(
      execFileSync('tar', ['-xOzf', archive, 'MANIFEST.json'], { encoding: 'utf8' }),
    ) as { env: { files: string[] } };
    expect([...manifest.env.files].sort()).toEqual([...ENV_FILES].sort());

    const checkout = makeCheckout();
    write(path.join(checkout, '.env.production'), 'SITE_URL=https://old.example.com\n');
    const result = await run(['restore', archive, '--repo', checkout, '--with-env', '--json']);
    expect(result.code, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as data.RestoreResult;
    expect(report.dataDir).toBe(target);
    expect([...report.restored.env].sort()).toEqual([...ENV_FILES].sort());
    for (const name of ENV_FILES) {
      expect(fs.readFileSync(path.join(checkout, name), 'utf8'), name).toBe(bodies[name]);
      expect(mode(path.join(checkout, name))).toBe(0o600);
    }
    expect(report.envSaved).toHaveLength(1);
    expect(path.basename(report.envSaved[0]!)).toMatch(
      /^\.env\.production\.before-restore-.*\.local$/,
    );
    expect(fs.readFileSync(report.envSaved[0]!, 'utf8')).toBe('SITE_URL=https://old.example.com\n');
    expect(countUsers(path.join(target, 'app.db'))).toBe(2);
    // Nothing a restore wrote into the checkout is committable.
    expect(git(checkout, 'status', '--porcelain')).toBe('');
  });
});
