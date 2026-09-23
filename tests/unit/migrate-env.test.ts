import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { DATA_DIR_MARKER, UnsafeDataDirError } from '@/lib/data-dir';
import { parseEnvFile, resolveMigrateConfig } from '@/lib/db/migrate-env';

const temps: string[] = [];

function tempRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'examify-migrate-env-'));
  temps.push(root);
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'project-examify' }));
  return root;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('parseEnvFile', () => {
  it('parses KEY=VALUE, export, quotes, and skips comments', () => {
    expect(
      parseEnvFile(
        [
          '# comment',
          'DATABASE_URL=file:./data/from-env.db',
          'export SITE_URL=https://exam.example.com',
          'QUOTED="file:./data/quoted.db"',
          'EMPTY=',
          '',
        ].join('\n'),
      ),
    ).toEqual({
      DATABASE_URL: 'file:./data/from-env.db',
      SITE_URL: 'https://exam.example.com',
      QUOTED: 'file:./data/quoted.db',
      EMPTY: '',
    });
  });

  it('strips unquoted inline comments the way Next.js / dotenv do', () => {
    expect(parseEnvFile('DATABASE_URL=file:./data/app.db # local\n')).toEqual({
      DATABASE_URL: 'file:./data/app.db',
    });
    expect(parseEnvFile('DATABASE_URL="file:./data/app.db # local"\n')).toEqual({
      DATABASE_URL: 'file:./data/app.db # local',
    });
    expect(parseEnvFile('DATABASE_URL="file:./data/quoted.db" # local\n')).toEqual({
      DATABASE_URL: 'file:./data/quoted.db',
    });
    expect(parseEnvFile('KEEP=bar#baz\n')).toEqual({ KEEP: 'bar#baz' });
    expect(parseEnvFile(`DATABASE_URL=file:./data/app.db${' '.repeat(400)}# local\n`)).toEqual({
      DATABASE_URL: 'file:./data/app.db',
    });
  });
});

describe('resolveMigrateConfig', () => {
  it('reads DATABASE_URL from repo-root .env when process env is unset', () => {
    const root = tempRepo();
    writeFileSync(path.join(root, '.env'), 'DATABASE_URL=file:./data/from-dotenv.db\n');
    const nested = path.join(root, 'src', 'lib');
    mkdirSync(nested, { recursive: true });
    const cfg = resolveMigrateConfig(nested, {});
    expect(cfg.repoRoot).toBe(root);
    expect(cfg.databaseUrl).toBe('file:./data/from-dotenv.db');
    expect(cfg.dbPath).toBe(path.join(root, 'data', 'from-dotenv.db'));
    expect(cfg.migrationsFolder).toBe(path.join(root, 'src', 'lib', 'db', 'migrations'));
  });

  it('lets .env.local win over .env', () => {
    const root = tempRepo();
    writeFileSync(path.join(root, '.env'), 'DATABASE_URL=file:./data/base.db\n');
    writeFileSync(path.join(root, '.env.local'), 'DATABASE_URL=file:./data/local.db\n');
    const cfg = resolveMigrateConfig(root, {});
    expect(cfg.dbPath).toBe(path.join(root, 'data', 'local.db'));
  });

  it('strips an unquoted inline comment on DATABASE_URL so migrate opens the same file as Next.js', () => {
    const root = tempRepo();
    writeFileSync(path.join(root, '.env'), 'DATABASE_URL=file:./data/app.db # local\n');
    const cfg = resolveMigrateConfig(root, {});
    expect(cfg.databaseUrl).toBe('file:./data/app.db');
    expect(cfg.dbPath).toBe(path.join(root, 'data', 'app.db'));
  });

  it('lets a non-empty process DATABASE_URL win over the repo .env', () => {
    const root = tempRepo();
    writeFileSync(path.join(root, '.env'), 'DATABASE_URL=file:./data/from-dotenv.db\n');
    const cfg = resolveMigrateConfig(root, { DATABASE_URL: 'file:/data/host.db' });
    expect(cfg.databaseUrl).toBe('file:/data/host.db');
    expect(cfg.dbPath).toBe('/data/host.db');
  });

  it('treats a blank process DATABASE_URL as unset so the repo .env is used', () => {
    const root = tempRepo();
    writeFileSync(path.join(root, '.env'), 'DATABASE_URL=file:./data/from-dotenv.db\n');
    const cfg = resolveMigrateConfig(root, { DATABASE_URL: '   ' });
    expect(cfg.dbPath).toBe(path.join(root, 'data', 'from-dotenv.db'));
  });

  it('falls back to <checkout>/data/app.db in the default data folder', () => {
    const root = tempRepo();
    const cfg = resolveMigrateConfig(root, {});
    expect(cfg.dataDir).toBe(path.join(root, 'data'));
    expect(cfg.databaseUrl).toBe(`file:${path.join(root, 'data', 'app.db')}`);
    expect(cfg.dbPath).toBe(path.join(root, 'data', 'app.db'));
  });

  it('puts the database in EXAMIFY_DATA_DIR from the repo .env, resolved against the checkout', () => {
    const root = tempRepo();
    writeFileSync(path.join(root, '.env'), 'EXAMIFY_DATA_DIR=data/family\n');
    const nested = path.join(root, 'src');
    mkdirSync(nested, { recursive: true });
    const cfg = resolveMigrateConfig(nested, {});
    expect(cfg.dataDir).toBe(path.join(root, 'data', 'family'));
    expect(cfg.dbPath).toBe(path.join(root, 'data', 'family', 'app.db'));
  });

  it('keeps an explicit DATABASE_URL next to an EXAMIFY_DATA_DIR (existing installs)', () => {
    const root = tempRepo();
    const outside = mkdtempSync(path.join(tmpdir(), 'examify-migrate-family-'));
    temps.push(outside);
    writeFileSync(path.join(root, '.env'), 'DATABASE_URL=file:./data/app.db\n');
    const cfg = resolveMigrateConfig(root, { EXAMIFY_DATA_DIR: outside });
    expect(cfg.dataDir).toBe(outside);
    expect(cfg.dbPath).toBe(path.join(root, 'data', 'app.db'));
  });

  it('refuses a data folder that overlaps the checkout', () => {
    const root = tempRepo();
    expect(() => resolveMigrateConfig(root, { EXAMIFY_DATA_DIR: 'src/family' })).toThrow(
      UnsafeDataDirError,
    );
    expect(() => resolveMigrateConfig(root, { EXAMIFY_DATA_DIR: '.' })).toThrow(UnsafeDataDirError);
  });
});

describe('pnpm db:migrate', () => {
  const checkout = process.cwd();
  const tsx = path.join(checkout, 'node_modules', '.bin', 'tsx');
  const script = path.join(checkout, 'src', 'lib', 'db', 'migrate.ts');

  function migrateRepo(): string {
    const root = tempRepo();
    cpSync(
      path.join(checkout, 'src', 'lib', 'db', 'migrations'),
      path.join(root, 'src', 'lib', 'db', 'migrations'),
      { recursive: true },
    );
    return root;
  }

  function runMigrate(root: string, env: Record<string, string> = {}) {
    return spawnSync(tsx, [script], {
      cwd: root,
      encoding: 'utf8',
      // Only what the script needs — never the unit suite's data folder / DB.
      env: {
        NODE_ENV: 'production',
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? root,
        ...env,
      },
    });
  }

  it('initialises the data folder (0700, .gitignore, marker) and migrates the database in it', () => {
    const root = migrateRepo();
    const first = runMigrate(root);
    expect(first.status, first.stderr).toBe(0);
    const dataDir = path.join(root, 'data');
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(readFileSync(path.join(dataDir, '.gitignore'), 'utf8')).toBe('*\n');
    const marker = readFileSync(path.join(dataDir, DATA_DIR_MARKER), 'utf8');
    expect(JSON.parse(marker)).toMatchObject({ layout: 1, migrations: [] });
    expect(statSync(path.join(dataDir, DATA_DIR_MARKER)).mode & 0o777).toBe(0o600);
    const sqlite = new Database(path.join(dataDir, 'app.db'), { readonly: true });
    try {
      const users = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
        .all();
      expect(users).toHaveLength(1);
    } finally {
      sqlite.close();
    }

    const again = runMigrate(root);
    expect(again.status, again.stderr).toBe(0);
    expect(readFileSync(path.join(dataDir, DATA_DIR_MARKER), 'utf8')).toBe(marker);
  });

  it('refuses a database or mail outbox inside the checkout without creating anything', () => {
    const root = migrateRepo();
    for (const [env, message] of [
      [{ DATABASE_URL: 'file:./app.db' }, 'db:migrate: DATABASE_URL points inside the checkout'],
      [{ MAIL_OUTBOX_DIR: 'outbox' }, 'db:migrate: MAIL_OUTBOX_DIR points inside the checkout'],
    ] as const) {
      const result = runMigrate(root, env);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(message);
      expect(result.stderr).not.toContain(root);
      expect(existsSync(path.join(root, 'app.db'))).toBe(false);
      expect(existsSync(path.join(root, 'data'))).toBe(false);
    }
  });

  it('refuses an unsafe data folder without creating it or printing the path', () => {
    const root = migrateRepo();
    const result = runMigrate(root, { EXAMIFY_DATA_DIR: 'src/family' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('db:migrate: inside the checkout the family data folder');
    expect(result.stderr).not.toContain(root);
    expect(existsSync(path.join(root, 'src', 'family'))).toBe(false);
    expect(existsSync(path.join(root, 'data'))).toBe(false);
  });

  function git(root: string, ...args: string[]) {
    const result = spawnSync(
      'git',
      [
        '-c',
        'user.email=t@example.com',
        '-c',
        'user.name=t',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
  }

  it('refuses while family content is still in the checkout, unless told to ignore it', () => {
    const root = migrateRepo();
    mkdirSync(path.join(root, 'content', 'subjects', 'demo'), { recursive: true });
    writeFileSync(
      path.join(root, 'content', 'subjects', 'demo', 'subject.json'),
      '{"id":"demo","label":"Demo"}\n',
    );
    git(root, 'init', '-q');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'fixture');
    const clean = runMigrate(root);
    expect(clean.status, clean.stderr).toBe(0);

    mkdirSync(path.join(root, 'content', 'subjects', 'history'), { recursive: true });
    writeFileSync(
      path.join(root, 'content', 'subjects', 'history', 'subject.json'),
      '{"id":"history","label":"History"}\n',
    );
    const refused = runMigrate(root);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('family content is still inside the checkout');
    expect(refused.stderr).toContain('content/subjects/history');
    expect(refused.stderr).toContain('./install.sh --upgrade');

    const ignored = runMigrate(root, { EXAMIFY_IGNORE_LEGACY_CONTENT: '1' });
    expect(ignored.status, ignored.stderr).toBe(0);

    // Following the hint moves the content, after a backup that holds the checkout.
    cpSync(path.join(checkout, 'scripts'), path.join(root, 'scripts'), { recursive: true });
    const hinted = refused.stderr
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('node scripts/examify-data.mjs'));
    expect(hinted.length).toBeGreaterThan(0);
    for (const command of hinted) {
      const followed = spawnSync('bash', ['-c', command], {
        cwd: root,
        encoding: 'utf8',
        env: {
          NODE_ENV: 'production',
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? root,
          EXAMIFY_SQLITE_MODULE: path.join(checkout, 'node_modules', 'better-sqlite3'),
        },
      });
      expect(followed.status, followed.stderr).toBe(0);
    }
    const archives = readdirSync(path.join(root, 'data', 'backups'));
    expect(archives).toHaveLength(1);
    const manifest = spawnSync(
      'tar',
      ['-xOzf', path.join(root, 'data', 'backups', archives[0]!), 'MANIFEST.json'],
      { encoding: 'utf8' },
    );
    expect(manifest.stdout).toContain('checkout/content/subjects/history/subject.json');
    const migrated = runMigrate(root);
    expect(migrated.status, migrated.stderr).toBe(0);
  });

  it('refuses a database folder shared with other software', () => {
    const root = migrateRepo();
    const shared = mkdtempSync(path.join(tmpdir(), 'examify-shared-'));
    temps.push(shared);
    writeFileSync(path.join(shared, 'someone-else.conf'), 'x');
    const result = runMigrate(root, { DATABASE_URL: `file:${path.join(shared, 'app.db')}` });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('db:migrate: the family data folder already holds files');
    expect(result.stderr).not.toContain(shared);
    expect(existsSync(path.join(shared, 'app.db'))).toBe(false);
    expect(existsSync(path.join(shared, DATA_DIR_MARKER))).toBe(false);
  });
});
