import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getDataPaths,
  resolveCliDataPaths,
  resolveDataPaths,
  setDataDirForTests,
  UnsafeDataDirError,
} from '@/lib/data-dir';
import { envFileValue, parseEnvFile } from '@/lib/env-file';

const temps: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function tempRepo(): string {
  const root = tempDir('examify-data-dir-');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'project-examify' }));
  return root;
}

function unsafeReason(run: () => unknown): string | null {
  try {
    run();
  } catch (error) {
    if (error instanceof UnsafeDataDirError) return error.reason;
    throw error;
  }
  return null;
}

afterEach(() => {
  setDataDirForTests(null);
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('resolveDataPaths', () => {
  it('defaults to <checkout>/data with the DB, outbox and family content inside it', () => {
    const root = tempRepo();
    const paths = resolveDataPaths({ repoRoot: root, env: { NODE_ENV: 'production' } });
    expect(paths.dataDir).toBe(path.join(root, 'data'));
    expect(paths.dataDirSource).toBe('default');
    expect(paths.familyRoot).toBe(paths.dataDir);
    expect(paths.databaseUrl).toBe(`file:${path.join(root, 'data', 'app.db')}`);
    expect(paths.databaseUrlExplicit).toBe(false);
    expect(paths.dbPath).toBe(path.join(root, 'data', 'app.db'));
    expect(paths.outboxDir).toBe(path.join(root, 'data', 'outbox'));
  });

  it('resolves a relative EXAMIFY_DATA_DIR against the checkout, never cwd', () => {
    const root = tempRepo();
    const paths = resolveDataPaths({ repoRoot: root, env: { EXAMIFY_DATA_DIR: 'data/family' } });
    expect(paths.dataDir).toBe(path.join(root, 'data', 'family'));
    expect(paths.dbPath).toBe(path.join(root, 'data', 'family', 'app.db'));
  });

  it('takes an absolute EXAMIFY_DATA_DIR outside the checkout', () => {
    const root = tempRepo();
    const outside = tempDir('examify-family-');
    const paths = resolveDataPaths({ repoRoot: root, env: { EXAMIFY_DATA_DIR: outside } });
    expect(paths.dataDir).toBe(outside);
    expect(paths.dataDirSource).toBe('EXAMIFY_DATA_DIR');
  });

  it('keeps an explicit DATABASE_URL (existing installs) and resolves it against the checkout', () => {
    const root = tempRepo();
    const paths = resolveDataPaths({
      repoRoot: root,
      env: { DATABASE_URL: 'file:./data/app.db', EXAMIFY_DATA_DIR: 'data/family' },
    });
    expect(paths.databaseUrlExplicit).toBe(true);
    expect(paths.dbPath).toBe(path.join(root, 'data', 'app.db'));
    expect(paths.dataDir).toBe(path.join(root, 'data', 'family'));
  });

  it('puts family content next to a volume DATABASE_URL outside the checkout', () => {
    const root = tempRepo();
    const volume = tempDir('examify-volume-');
    const paths = resolveDataPaths({
      repoRoot: root,
      env: { DATABASE_URL: `file:${path.join(volume, 'app.db')}` },
    });
    expect(paths.dataDir).toBe(volume);
    expect(paths.dataDirSource).toBe('DATABASE_URL');
  });

  it('refuses a DATABASE_URL inside the checkout outside ./data and tests/.tmp', () => {
    const root = tempRepo();
    mkdirSync(path.join(root, 'src'));
    const link = path.join(tempDir('examify-db-link-'), 'db');
    symlinkSync(path.join(root, 'src'), link);
    const reason = (url: string, extra: Record<string, string> = {}) =>
      unsafeReason(() =>
        resolveDataPaths({ repoRoot: root, env: { DATABASE_URL: url, ...extra } }),
      );
    for (const url of ['file:./app.db', 'file:./src/app.db', `file:${path.join(link, 'x.db')}`]) {
      expect(reason(url), url).toBe('db_inside_checkout');
    }
    // Even with the family content elsewhere: the database is what is written inside.
    const outside = tempDir('examify-db-family-');
    expect(reason('file:./app.db', { EXAMIFY_DATA_DIR: outside })).toBe('db_inside_checkout');
    for (const url of ['file:./data/app.db', 'file:./tests/.tmp/unit.db', ':memory:']) {
      expect(reason(url), url).toBeNull();
    }
    try {
      resolveDataPaths({ repoRoot: root, env: { DATABASE_URL: 'file:./secret-name.db' } });
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as Error).message).toContain('DATABASE_URL points inside the checkout');
      expect((error as Error).message).not.toContain('secret-name');
      expect((error as Error).message).not.toContain(root);
    }
  });

  it('uses ./data when the explicit DATABASE_URL folder contains the checkout', () => {
    const root = tempRepo();
    const paths = resolveDataPaths({
      repoRoot: root,
      env: { DATABASE_URL: `file:${path.join(path.dirname(root), 'app.db')}` },
    });
    expect(paths.dataDir).toBe(path.join(root, 'data'));
    expect(paths.dataDirSource).toBe('default');
  });

  it('treats blank values as unset', () => {
    const root = tempRepo();
    const paths = resolveDataPaths({
      repoRoot: root,
      env: { EXAMIFY_DATA_DIR: '  ', DATABASE_URL: '', MAIL_OUTBOX_DIR: ' ' },
    });
    expect(paths.dataDir).toBe(path.join(root, 'data'));
    expect(paths.databaseUrlExplicit).toBe(false);
  });

  it('resolves MAIL_OUTBOX_DIR against the checkout', () => {
    const root = tempRepo();
    const paths = resolveDataPaths({ repoRoot: root, env: { MAIL_OUTBOX_DIR: 'tests/.tmp/box' } });
    expect(paths.outboxDir).toBe(path.join(root, 'tests', '.tmp', 'box'));
  });

  it('refuses a MAIL_OUTBOX_DIR inside the checkout outside ./data and tests/.tmp', () => {
    const root = tempRepo();
    const reason = (dir: string) =>
      unsafeReason(() => resolveDataPaths({ repoRoot: root, env: { MAIL_OUTBOX_DIR: dir } }));
    for (const dir of ['outbox', '.', 'src/outbox', 'public/box']) {
      expect(reason(dir), dir).toBe('outbox_inside_checkout');
    }
    const outside = tempDir('examify-outbox-');
    for (const dir of ['data/outbox', 'tests/.tmp/box', outside, '..']) {
      expect(reason(dir), dir).toBeNull();
    }
    try {
      resolveDataPaths({ repoRoot: root, env: { MAIL_OUTBOX_DIR: 'secret-box' } });
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as Error).message).toContain('MAIL_OUTBOX_DIR points inside the checkout');
      expect((error as Error).message).not.toContain('secret-box');
      expect((error as Error).message).not.toContain(root);
    }
  });

  it('uses the tests/.tmp outbox sentinel outside production only', () => {
    const root = tempRepo();
    const dev = resolveDataPaths({ repoRoot: root, env: { RESEND_API_KEY: 'test' } });
    expect(dev.outboxDir).toBe(path.join(root, 'tests', '.tmp', 'outbox'));
    const prod = resolveDataPaths({
      repoRoot: root,
      env: { RESEND_API_KEY: 'test', NODE_ENV: 'production' },
    });
    expect(prod.outboxDir).toBe(path.join(root, 'data', 'outbox'));
  });

  it('refuses the checkout itself, an ancestor, and tracked folders', () => {
    const root = tempRepo();
    const reason = (value: string) =>
      unsafeReason(() => resolveDataPaths({ repoRoot: root, env: { EXAMIFY_DATA_DIR: value } }));
    expect(reason('.')).toBe('checkout_root');
    expect(reason('..')).toBe('checkout_root');
    expect(reason('/')).toBe('checkout_root');
    for (const inside of ['src', 'public', 'content', 'content/family', '.next', 'node_modules']) {
      expect(reason(inside)).toBe('inside_checkout');
    }
    expect(reason('data')).toBeNull();
    expect(reason('data/family')).toBeNull();
    expect(reason('tests/.tmp/e2e-data')).toBeNull();
  });

  it('refuses a symlink that routes into the checkout', () => {
    const root = tempRepo();
    mkdirSync(path.join(root, 'src'));
    const outside = tempDir('examify-link-');
    const link = path.join(outside, 'family');
    symlinkSync(path.join(root, 'src'), link);
    expect(
      unsafeReason(() => resolveDataPaths({ repoRoot: root, env: { EXAMIFY_DATA_DIR: link } })),
    ).toBe('inside_checkout');
  });

  it('refuses values .env cannot carry or the shell would expand', () => {
    const root = tempRepo();
    for (const value of ['~/examify', 'a\nb', '"quoted"', "it's", 'dir #comment', '$HOME/fam']) {
      expect(
        unsafeReason(() => resolveDataPaths({ repoRoot: root, env: { EXAMIFY_DATA_DIR: value } })),
      ).toBe('bad_value');
    }
  });

  it('applies the same value rules to DATABASE_URL and MAIL_OUTBOX_DIR, naming the variable', () => {
    const root = tempRepo();
    const refusal = (env: Record<string, string>) => {
      try {
        resolveDataPaths({ repoRoot: root, env });
      } catch (error) {
        if (error instanceof UnsafeDataDirError) return error;
        throw error;
      }
      return null;
    };
    const cases: Array<[Record<string, string>, string]> = [
      [{ DATABASE_URL: 'file:$HOME/examify.db' }, 'DATABASE_URL'],
      [{ DATABASE_URL: '${DATA}/app.db' }, 'DATABASE_URL'],
      [{ DATABASE_URL: 'file:~/app.db' }, 'DATABASE_URL'],
      [{ DATABASE_URL: 'file:./data/app.db #old' }, 'DATABASE_URL'],
      [{ DATABASE_URL: 'file:./data/`name`.db' }, 'DATABASE_URL'],
      [{ MAIL_OUTBOX_DIR: '$HOME/outbox' }, 'MAIL_OUTBOX_DIR'],
      [{ MAIL_OUTBOX_DIR: '~/outbox' }, 'MAIL_OUTBOX_DIR'],
      [{ MAIL_OUTBOX_DIR: 'data/"box"' }, 'MAIL_OUTBOX_DIR'],
      [{ MAIL_OUTBOX_DIR: 'data/box\nx' }, 'MAIL_OUTBOX_DIR'],
    ];
    for (const [env, name] of cases) {
      const error = refusal(env);
      expect(error?.reason, JSON.stringify(env)).toBe('bad_value');
      expect(error?.message).toContain(name);
      expect(error?.message).not.toContain(Object.values(env)[0]!.replace(/^file:/, ''));
    }
    const allowed: Array<Record<string, string>> = [
      { DATABASE_URL: 'file:./data/app.db' },
      { DATABASE_URL: ':memory:' },
      { MAIL_OUTBOX_DIR: 'data/outbox' },
    ];
    for (const env of allowed) {
      expect(refusal(env)).toBeNull();
    }
  });

  it('never puts the path in the error message', () => {
    const root = tempRepo();
    try {
      resolveDataPaths({ repoRoot: root, env: { EXAMIFY_DATA_DIR: 'src/secret-name' } });
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as Error).message).not.toContain('secret-name');
      expect((error as Error).message).not.toContain(root);
    }
  });
});

describe('resolveCliDataPaths', () => {
  it('reads the env files in next start precedence', () => {
    const root = tempRepo();
    writeFileSync(path.join(root, '.env'), 'EXAMIFY_DATA_DIR=data/from-env\n');
    writeFileSync(path.join(root, '.env.production'), 'EXAMIFY_DATA_DIR=data/from-production\n');
    expect(resolveCliDataPaths(root, {}).dataDir).toBe(path.join(root, 'data', 'from-production'));
    writeFileSync(path.join(root, '.env.local'), 'EXAMIFY_DATA_DIR=data/from-local\n');
    expect(resolveCliDataPaths(root, {}).dataDir).toBe(path.join(root, 'data', 'from-local'));
    writeFileSync(
      path.join(root, '.env.production.local'),
      'EXAMIFY_DATA_DIR=data/from-production-local\n',
    );
    expect(resolveCliDataPaths(root, {}).dataDir).toBe(
      path.join(root, 'data', 'from-production-local'),
    );
  });

  it('lets an empty higher-precedence file value hide a lower one, like Next', () => {
    const root = tempRepo();
    writeFileSync(path.join(root, '.env'), 'EXAMIFY_DATA_DIR=data/from-env\n');
    writeFileSync(path.join(root, '.env.local'), 'EXAMIFY_DATA_DIR=\n');
    expect(resolveCliDataPaths(root, {}).dataDir).toBe(path.join(root, 'data'));
  });

  it('lets a non-blank process env value win over the files', () => {
    const root = tempRepo();
    writeFileSync(path.join(root, '.env'), 'EXAMIFY_DATA_DIR=data/from-env\n');
    expect(resolveCliDataPaths(root, { EXAMIFY_DATA_DIR: 'data/host' }).dataDir).toBe(
      path.join(root, 'data', 'host'),
    );
    expect(resolveCliDataPaths(root, { EXAMIFY_DATA_DIR: '  ' }).dataDir).toBe(
      path.join(root, 'data', 'from-env'),
    );
  });

  it('finds the checkout from a nested cwd', () => {
    const root = tempRepo();
    const nested = path.join(root, 'src', 'lib');
    mkdirSync(nested, { recursive: true });
    expect(resolveCliDataPaths(nested, {}).repoRoot).toBe(root);
  });
});

describe('getDataPaths', () => {
  it('follows the test override and restores env resolution', () => {
    const dir = tempDir('examify-override-');
    setDataDirForTests(dir);
    expect(getDataPaths().dataDir).toBe(dir);
    expect(getDataPaths().familyRoot).toBe(dir);
    setDataDirForTests(null);
    expect(getDataPaths().dataDir).not.toBe(dir);
  });
});

describe('envFileValue', () => {
  it('returns the first file that defines the key, even empty', () => {
    expect(envFileValue([parseEnvFile('A=\n'), parseEnvFile('A=x\n')], 'A')).toBe('');
    expect(envFileValue([parseEnvFile('B=1\n'), parseEnvFile('A=x\n')], 'A')).toBe('x');
    expect(envFileValue([parseEnvFile('B=1\n')], 'A')).toBeUndefined();
  });
});
