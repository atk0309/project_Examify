import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

  it('falls back to file:./data/app.db on the repo root', () => {
    const root = tempRepo();
    const cfg = resolveMigrateConfig(root, {});
    expect(cfg.databaseUrl).toBe('file:./data/app.db');
    expect(cfg.dbPath).toBe(path.join(root, 'data', 'app.db'));
  });
});
