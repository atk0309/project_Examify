import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveEnvStoreRoot } from '@/lib/config-root';
import {
  clearEnvStoreSecret,
  envStoreSecretHostManaged,
  getEnvStoreRoot,
  setEnvStoreRootForTests,
  setEnvStoreSecret,
  setInitialEnvironForTests,
} from '@/lib/env-store';
import { mergeRepoEnvFiles } from '../../tools/examify-ingest/src/repo-env';

const roots: string[] = [];

function installation() {
  const root = mkdtempSync(path.join(tmpdir(), 'examify-solo-config-'));
  roots.push(root);
  const app = path.join(root, 'versions', 'one', 'app');
  const config = path.join(root, 'config');
  mkdirSync(app, { recursive: true });
  mkdirSync(config, { mode: 0o700 });
  writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'project-examify' }));
  const env = { EXAMIFY_MODE: 'solo', EXAMIFY_CONFIG_DIR: config };
  return { root, app, config, env };
}

function privateFile(file: string, contents: string): void {
  writeFileSync(file, contents, { mode: 0o600 });
}

afterEach(() => {
  setEnvStoreRootForTests(null);
  setInitialEnvironForTests(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('solo provider settings root', () => {
  it('selects private config outside versioned app; household ignores the solo override', () => {
    const { app, config, env } = installation();
    expect(resolveEnvStoreRoot(app, env)).toBe(config);
    expect(resolveEnvStoreRoot(app, { EXAMIFY_CONFIG_DIR: config })).toBe(app);
    expect(resolveEnvStoreRoot(app, { ...env, EXAMIFY_MODE: 'household' })).toBe(app);
  });

  it('refuses missing, relative, uncreated and overlapping directories without creating them', () => {
    const { root, app, env } = installation();
    const missing = path.join(root, 'not-created');
    for (const configured of [
      undefined,
      '',
      'config',
      missing,
      app,
      root,
      path.join(app, 'config'),
    ]) {
      expect(() => resolveEnvStoreRoot(app, { ...env, EXAMIFY_CONFIG_DIR: configured })).toThrow(
        'unsafe_config_dir',
      );
    }
    expect(existsSync(missing)).toBe(false);
    expect(existsSync(path.join(app, '.env'))).toBe(false);
  });

  it('refuses config files, linked roots, and linked parent components', () => {
    const { root, app, config, env } = installation();
    const regular = path.join(root, 'regular');
    privateFile(regular, 'fixture');
    const linked = path.join(root, 'linked');
    symlinkSync(config, linked, process.platform === 'win32' ? 'junction' : 'dir');
    const linkedParent = path.join(root, 'linked-parent');
    const external = mkdtempSync(path.join(tmpdir(), 'examify-solo-parent-'));
    roots.push(external);
    mkdirSync(path.join(external, 'private'), { mode: 0o700 });
    symlinkSync(external, linkedParent, process.platform === 'win32' ? 'junction' : 'dir');
    for (const configured of [regular, linked, path.join(linkedParent, 'private')]) {
      expect(() => resolveEnvStoreRoot(app, { ...env, EXAMIFY_CONFIG_DIR: configured })).toThrow(
        'unsafe_config_dir',
      );
    }
  });

  it('refuses any checkout ancestor, including another Examify release', () => {
    const { root, app, env } = installation();
    const other = path.join(root, 'another-checkout');
    const config = path.join(other, 'config');
    mkdirSync(config, { recursive: true, mode: 0o700 });
    privateFile(path.join(other, 'package.json'), JSON.stringify({ name: 'project-examify' }));
    expect(() => resolveEnvStoreRoot(app, { ...env, EXAMIFY_CONFIG_DIR: config })).toThrow(
      'unsafe_config_dir',
    );
    rmSync(path.join(other, 'package.json'));
    privateFile(path.join(other, '.git'), 'gitdir: fixture');
    expect(() => resolveEnvStoreRoot(app, { ...env, EXAMIFY_CONFIG_DIR: config })).toThrow(
      'unsafe_config_dir',
    );
  });

  it.skipIf(process.platform === 'win32')(
    'refuses readable-by-others directories and settings',
    () => {
      const { app, config, env } = installation();
      chmodSync(config, 0o755);
      expect(() => resolveEnvStoreRoot(app, env)).toThrow('unsafe_config_dir');
      chmodSync(config, 0o700);
      const file = path.join(config, '.env');
      privateFile(file, 'OPENAI_API_KEY=fixture\n');
      chmodSync(file, 0o644);
      expect(() => resolveEnvStoreRoot(app, env)).toThrow('unsafe_config_dir');
      expect(statSync(file).mode & 0o777).toBe(0o644);
    },
  );

  it.skipIf(typeof process.getuid !== 'function')(
    'refuses a config directory owned by another uid',
    () => {
      const { app, config, env } = installation();
      vi.spyOn(process, 'getuid').mockReturnValue(statSync(config).uid + 1);
      expect(() => resolveEnvStoreRoot(app, env)).toThrow('unsafe_config_dir');
    },
  );

  it.each(['.env', '.env.local'])(
    'refuses linked or non-file %s before reads or writes',
    (name) => {
      const { root, app, config, env } = installation();
      const file = path.join(config, name);
      const external = path.join(root, 'external-secret');
      privateFile(external, 'OPENAI_API_KEY=fixture\n');
      symlinkSync(external, file);
      expect(() => resolveEnvStoreRoot(app, env)).toThrow('unsafe_config_dir');
      rmSync(file);
      linkSync(external, file);
      expect(() => resolveEnvStoreRoot(app, env)).toThrow('unsafe_config_dir');
      rmSync(file);
      mkdirSync(file, { mode: 0o700 });
      expect(() => resolveEnvStoreRoot(app, env)).toThrow('unsafe_config_dir');
      expect(readFileSync(external, 'utf8')).toBe('OPENAI_API_KEY=fixture\n');
    },
  );
});

describe('solo settings persistence and generator parity', () => {
  it('fails before updating either settings file when the local override is unsafe', () => {
    const { root, app, config, env } = installation();
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    vi.stubEnv('OPENAI_API_KEY', 'fixture-existing');
    vi.stubEnv('EXAMIFY_TEST_ENV_STORE_DIR', undefined);
    vi.spyOn(process, 'cwd').mockReturnValue(app);
    setInitialEnvironForTests({});
    privateFile(path.join(config, '.env'), 'OPENAI_API_KEY=fixture-existing\n');
    const target = path.join(root, 'unrelated');
    privateFile(target, 'OPENAI_API_KEY=fixture-external\n');
    symlinkSync(target, path.join(config, '.env.local'));
    expect(() => setEnvStoreSecret('OPENAI_API_KEY', 'fixture-new')).toThrow('unsafe_config_dir');
    expect(() => clearEnvStoreSecret('OPENAI_API_KEY')).toThrow('unsafe_config_dir');
    expect(readFileSync(path.join(config, '.env'), 'utf8')).toBe(
      'OPENAI_API_KEY=fixture-existing\n',
    );
    expect(readFileSync(target, 'utf8')).toBe('OPENAI_API_KEY=fixture-external\n');
    expect(process.env.OPENAI_API_KEY).toBe('fixture-existing');
  });

  it('saves, reloads, rotates and clears keys across app versions without checkout writes', () => {
    const { root, app, config, env } = installation();
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    vi.stubEnv('OPENAI_API_KEY', undefined);
    vi.stubEnv('EXAMIFY_TEST_ENV_STORE_DIR', undefined);
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(app);
    setInitialEnvironForTests({});
    const first = 'sk-fixture-first-not-real';
    const rotated = 'sk-fixture-rotated-not-real';
    expect(getEnvStoreRoot()).toBe(config);
    expect(setEnvStoreSecret('OPENAI_API_KEY', first)).toEqual({ ok: true });
    expect(envStoreSecretHostManaged('OPENAI_API_KEY')).toBe(false);
    expect(mergeRepoEnvFiles(app, env).OPENAI_API_KEY).toBe(first);
    privateFile(path.join(config, '.env.local'), `OPENAI_API_KEY=${first}\n`);

    const nextApp = path.join(root, 'versions', 'two', 'app');
    mkdirSync(nextApp, { recursive: true });
    privateFile(path.join(nextApp, 'package.json'), JSON.stringify({ name: 'project-examify' }));
    cwd.mockReturnValue(nextApp);
    expect(getEnvStoreRoot()).toBe(config);
    expect(setEnvStoreSecret('OPENAI_API_KEY', rotated)).toEqual({ ok: true });
    expect(mergeRepoEnvFiles(nextApp, env).OPENAI_API_KEY).toBe(rotated);
    expect(readFileSync(path.join(config, '.env.local'), 'utf8')).toBe(
      `OPENAI_API_KEY=${rotated}\n`,
    );
    expect(clearEnvStoreSecret('OPENAI_API_KEY')).toEqual({ ok: true });
    expect(mergeRepoEnvFiles(nextApp, env).OPENAI_API_KEY).toBeUndefined();
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    for (const release of [app, nextApp])
      expect(existsSync(path.join(release, '.env'))).toBe(false);
    expect(existsSync(path.join(config, 'runtime.env'))).toBe(false);
    if (process.platform !== 'win32') {
      expect(statSync(path.join(config, '.env')).mode & 0o777).toBe(0o600);
    }
  });

  it('loads config local overrides, preserves explicit host values, and ignores app/runtime env files', () => {
    const { app, config, env } = installation();
    privateFile(path.join(app, '.env'), 'OPENAI_API_KEY=wrong-release\n');
    privateFile(
      path.join(config, '.env'),
      'OPENAI_API_KEY=fixture-key\nEXAMIFY_OPENAI_MODEL=base\n',
    );
    privateFile(
      path.join(config, '.env.local'),
      'EXAMIFY_OPENAI_MODEL=local\nAUTH_SECRET=ignore-runtime\nEXAMIFY_INGEST_LOCAL_CMD=ignore-command\n',
    );
    privateFile(path.join(config, 'runtime.env'), 'OPENAI_API_KEY=wrong-runtime\n');
    expect(mergeRepoEnvFiles(app, env)).toMatchObject({
      OPENAI_API_KEY: 'fixture-key',
      EXAMIFY_OPENAI_MODEL: 'local',
    });
    expect(mergeRepoEnvFiles(app, env).AUTH_SECRET).toBeUndefined();
    expect(mergeRepoEnvFiles(app, env).EXAMIFY_INGEST_LOCAL_CMD).toBeUndefined();
    expect(mergeRepoEnvFiles(app, { ...env, OPENAI_API_KEY: '' }).OPENAI_API_KEY).toBe('');
    expect(
      mergeRepoEnvFiles(
        app,
        { examify_mode: 'solo', Examify_Config_Dir: config, openai_api_key: 'fixture-host' },
        'win32',
      ),
    ).toMatchObject({ OPENAI_API_KEY: 'fixture-host', EXAMIFY_OPENAI_MODEL: 'local' });
  });

  it('keeps truly host-injected credentials locked even when the solo file matches', () => {
    const { app, config, env } = installation();
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    vi.stubEnv('OPENAI_API_KEY', 'fixture-host');
    vi.stubEnv('EXAMIFY_TEST_ENV_STORE_DIR', undefined);
    vi.spyOn(process, 'cwd').mockReturnValue(app);
    privateFile(path.join(config, '.env'), 'OPENAI_API_KEY=fixture-host\n');
    setInitialEnvironForTests({ OPENAI_API_KEY: 'fixture-host' });
    expect(envStoreSecretHostManaged('OPENAI_API_KEY')).toBe(true);
    expect(setEnvStoreSecret('OPENAI_API_KEY', 'fixture-replacement')).toEqual({
      ok: false,
      reason: 'host_managed',
    });
    expect(clearEnvStoreSecret('OPENAI_API_KEY')).toEqual({ ok: false, reason: 'host_managed' });
    expect(readFileSync(path.join(config, '.env'), 'utf8')).toBe('OPENAI_API_KEY=fixture-host\n');
  });
});
