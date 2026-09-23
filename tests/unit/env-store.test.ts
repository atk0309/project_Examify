import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'examify-env-store-'));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'project-examify' }));
  return root;
}

const SECRET = 'sk-openai-unit-test-key-never-echo';

afterEach(async () => {
  const { setEnvStoreRootForTests, setInitialEnvironForTests } = await import('@/lib/env-store');
  setEnvStoreRootForTests(null);
  setInitialEnvironForTests(null);
});

describe('env-store', () => {
  it('upserts OPENAI_API_KEY in .env, updates process.env, and never echoes the value', async () => {
    const { setEnvStoreRootForTests, setEnvStoreSecret, envStoreSecretConfigured } =
      await import('@/lib/env-store');
    const root = tempRoot();
    writeFileSync(
      path.join(root, '.env'),
      'SITE_URL=http://localhost:3000\nANTHROPIC_API_KEY=test\n',
    );
    setEnvStoreRootForTests(root);
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const result = setEnvStoreSecret('OPENAI_API_KEY', `  ${SECRET}  `, root);
      expect(result).toEqual({ ok: true });
      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(envStoreSecretConfigured('OPENAI_API_KEY')).toBe(true);
      expect(process.env.OPENAI_API_KEY).toBe(SECRET);
      const envFile = readFileSync(path.join(root, '.env'), 'utf8');
      expect(envFile).toContain(`OPENAI_API_KEY=${SECRET}`);
      expect(envFile).toContain('SITE_URL=http://localhost:3000');
      expect(statSync(path.join(root, '.env')).mode & 0o777).toBe(0o600);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it('rotates an existing key and updates a leftover .env.local override', async () => {
    const { setEnvStoreSecret } = await import('@/lib/env-store');
    const root = tempRoot();
    const rotated = 'sk-openai-rotated-key-never-echo';
    writeFileSync(path.join(root, '.env'), `OPENAI_API_KEY=${SECRET}\nOTHER=keep\n`);
    writeFileSync(path.join(root, '.env.local'), `OPENAI_API_KEY=stale-local\nKEEP=1\n`);
    const previous = process.env.OPENAI_API_KEY;
    try {
      expect(setEnvStoreSecret('OPENAI_API_KEY', rotated, root)).toEqual({ ok: true });
      expect(readFileSync(path.join(root, '.env'), 'utf8')).toContain(`OPENAI_API_KEY=${rotated}`);
      expect(readFileSync(path.join(root, '.env.local'), 'utf8')).toContain(
        `OPENAI_API_KEY=${rotated}`,
      );
      expect(readFileSync(path.join(root, '.env.local'), 'utf8')).toContain('KEEP=1');
      expect(process.env.OPENAI_API_KEY).toBe(rotated);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it('clears the key from files and process.env', async () => {
    const { clearEnvStoreSecret, envStoreSecretConfigured } = await import('@/lib/env-store');
    const root = tempRoot();
    writeFileSync(path.join(root, '.env'), `OPENAI_API_KEY=${SECRET}\nOTHER=keep\n`);
    writeFileSync(path.join(root, '.env.local'), `OPENAI_API_KEY=${SECRET}\n`);
    process.env.OPENAI_API_KEY = SECRET;
    const previous = SECRET;
    try {
      expect(clearEnvStoreSecret('OPENAI_API_KEY', root)).toEqual({ ok: true });
      expect(envStoreSecretConfigured('OPENAI_API_KEY')).toBe(false);
      expect(process.env.OPENAI_API_KEY).toBeUndefined();
      expect(readFileSync(path.join(root, '.env'), 'utf8')).not.toMatch(/OPENAI_API_KEY=/);
      expect(readFileSync(path.join(root, '.env'), 'utf8')).toContain('OTHER=keep');
      expect(readFileSync(path.join(root, '.env.local'), 'utf8')).not.toMatch(/OPENAI_API_KEY=/);
    } finally {
      if (previous) {
        // leftover for other suites — always leave unset after this spec
        delete process.env.OPENAI_API_KEY;
      }
    }
  });

  it('refuses the test sentinel, empty values, newlines, and null bytes', async () => {
    const { setEnvStoreSecret } = await import('@/lib/env-store');
    const root = tempRoot();
    expect(setEnvStoreSecret('OPENAI_API_KEY', 'test', root)).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(setEnvStoreSecret('OPENAI_API_KEY', '   ', root)).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(setEnvStoreSecret('OPENAI_API_KEY', 'sk-ok\nsk-bad', root)).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(setEnvStoreSecret('OPENAI_API_KEY', `sk-ok${'\0'}sk-bad`, root)).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(process.env.OPENAI_API_KEY).not.toBe('test');
  });

  it('resolves the same repo root as ingest from a subdirectory; content lives in the data folder', async () => {
    const { getEnvStoreRoot, setEnvStoreSecret } = await import('@/lib/env-store');
    const { getOnboardingContentRoot } = await import('@/lib/content-root');
    const { findRepoRoot } = await import('@/lib/repo-root');
    const ingest = await import('examify-ingest');
    const { mergeRepoEnvFiles } = await import('examify-ingest/generate');
    const root = tempRoot();
    const nested = path.join(root, 'src', 'lib');
    mkdirSync(nested, { recursive: true });
    const previousCwd = process.cwd();
    const previousKey = process.env.OPENAI_API_KEY;
    const previousDataDir = process.env.EXAMIFY_DATA_DIR;
    const previousDbUrl = process.env.DATABASE_URL;
    delete process.env.OPENAI_API_KEY;
    try {
      process.chdir(nested);
      expect(getEnvStoreRoot()).toBe(root);
      // Family content is the data folder (default <checkout>/data; relative
      // values resolve against the checkout, not cwd) — never the checkout.
      delete process.env.EXAMIFY_DATA_DIR;
      delete process.env.DATABASE_URL;
      expect(getOnboardingContentRoot()).toBe(path.join(root, 'data'));
      process.env.EXAMIFY_DATA_DIR = 'data/family';
      expect(getOnboardingContentRoot()).toBe(path.join(root, 'data', 'family'));
      process.env.EXAMIFY_DATA_DIR = previousDataDir!;
      expect(getOnboardingContentRoot()).toBe(previousDataDir);
      expect(getOnboardingContentRoot()).not.toBe(getEnvStoreRoot());
      expect(findRepoRoot(process.cwd())).toBe(root);
      expect(ingest.findRepoRoot(process.cwd())).toBe(root);
      expect(getEnvStoreRoot()).toBe(ingest.findRepoRoot(nested));

      expect(setEnvStoreSecret('OPENAI_API_KEY', SECRET)).toEqual({ ok: true });
      expect(readFileSync(path.join(root, '.env'), 'utf8')).toContain(`OPENAI_API_KEY=${SECRET}`);
      expect(() => readFileSync(path.join(nested, '.env'), 'utf8')).toThrow();
      const loaded = mergeRepoEnvFiles(ingest.findRepoRoot(process.cwd()), {});
      expect(loaded.OPENAI_API_KEY).toBe(SECRET);
      expect(JSON.stringify(loaded)).not.toMatch(/NEXT_PUBLIC_/);
    } finally {
      process.chdir(previousCwd);
      for (const [key, value] of [
        ['EXAMIFY_DATA_DIR', previousDataDir],
        ['DATABASE_URL', previousDbUrl],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousKey;
    }
  });

  it('keeps env-store off the examify-ingest import graph', async () => {
    const raw = readFileSync(path.join(process.cwd(), 'src/lib/env-store.ts'), 'utf8');
    expect(raw).not.toMatch(/from ['"]examify-ingest/);
    expect(raw).toMatch(/from '@\/lib\/repo-root'/);
    const content = readFileSync(path.join(process.cwd(), 'src/lib/content-root.ts'), 'utf8');
    expect(content).not.toMatch(/from ['"]examify-ingest/);
  });

  it('returns disk when the env file cannot be written', async () => {
    const { setEnvStoreSecret } = await import('@/lib/env-store');
    const root = tempRoot();
    const notADir = path.join(root, 'not-a-directory');
    writeFileSync(notADir, 'blocked\n');
    const result = setEnvStoreSecret('OPENAI_API_KEY', SECRET, notADir);
    expect(result).toEqual({ ok: false, reason: 'disk' });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('treats a live process.env value that differs from the file store as host-managed', async () => {
    const {
      envStoreSecretHostManaged,
      setEnvStoreRootForTests,
      setEnvStoreSecret,
      clearEnvStoreSecret,
    } = await import('@/lib/env-store');
    const root = tempRoot();
    setEnvStoreRootForTests(root);
    const injected = 'sk-host-injected-never-echo';
    const attempted = 'sk-wizard-would-not-persist';
    writeFileSync(path.join(root, '.env'), `OPENAI_API_KEY=${SECRET}\nOTHER=keep\n`);
    writeFileSync(path.join(root, '.env.local'), `OPENAI_API_KEY=${SECRET}\n`);
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = injected;
    try {
      expect(envStoreSecretHostManaged('OPENAI_API_KEY', root)).toBe(true);
      expect(envStoreSecretHostManaged('OPENAI_API_KEY', root, { OPENAI_API_KEY: injected })).toBe(
        true,
      );
      expect(envStoreSecretHostManaged('OPENAI_API_KEY', root, { OPENAI_API_KEY: SECRET })).toBe(
        false,
      );
      expect(envStoreSecretHostManaged('OPENAI_API_KEY', root, {})).toBe(false);
      expect(envStoreSecretHostManaged('OPENAI_API_KEY', root, { OPENAI_API_KEY: 'test' })).toBe(
        false,
      );

      const set = setEnvStoreSecret('OPENAI_API_KEY', attempted, root);
      expect(set).toEqual({ ok: false, reason: 'host_managed' });
      expect(JSON.stringify(set)).not.toContain(injected);
      expect(JSON.stringify(set)).not.toContain(attempted);
      expect(JSON.stringify(set)).not.toContain(SECRET);

      const cleared = clearEnvStoreSecret('OPENAI_API_KEY', root);
      expect(cleared).toEqual({ ok: false, reason: 'host_managed' });
      expect(JSON.stringify(cleared)).not.toContain(injected);
      expect(JSON.stringify(cleared)).not.toContain(SECRET);

      expect(readFileSync(path.join(root, '.env'), 'utf8')).toBe(
        `OPENAI_API_KEY=${SECRET}\nOTHER=keep\n`,
      );
      expect(readFileSync(path.join(root, '.env.local'), 'utf8')).toBe(
        `OPENAI_API_KEY=${SECRET}\n`,
      );
      expect(process.env.OPENAI_API_KEY).toBe(injected);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it('is host-managed when the exec environ has the key even if .env matches', async () => {
    const {
      envStoreSecretHostManaged,
      setEnvStoreRootForTests,
      setInitialEnvironForTests,
      setEnvStoreSecret,
      clearEnvStoreSecret,
    } = await import('@/lib/env-store');
    const root = tempRoot();
    setEnvStoreRootForTests(root);
    setInitialEnvironForTests({ OPENAI_API_KEY: SECRET });
    writeFileSync(path.join(root, '.env'), `OPENAI_API_KEY=${SECRET}\nOTHER=keep\n`);
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = SECRET;
    const attempted = 'sk-wizard-matching-would-not-persist';
    try {
      expect(envStoreSecretHostManaged('OPENAI_API_KEY', root)).toBe(true);
      expect(
        envStoreSecretHostManaged(
          'OPENAI_API_KEY',
          root,
          { OPENAI_API_KEY: SECRET },
          {
            OPENAI_API_KEY: SECRET,
          },
        ),
      ).toBe(true);

      const set = setEnvStoreSecret('OPENAI_API_KEY', attempted, root);
      expect(set).toEqual({ ok: false, reason: 'host_managed' });
      expect(JSON.stringify(set)).not.toContain(SECRET);
      expect(JSON.stringify(set)).not.toContain(attempted);

      const cleared = clearEnvStoreSecret('OPENAI_API_KEY', root);
      expect(cleared).toEqual({ ok: false, reason: 'host_managed' });
      expect(JSON.stringify(cleared)).not.toContain(SECRET);

      expect(readFileSync(path.join(root, '.env'), 'utf8')).toBe(
        `OPENAI_API_KEY=${SECRET}\nOTHER=keep\n`,
      );
      expect(process.env.OPENAI_API_KEY).toBe(SECRET);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it('is host-managed when exec environ assigns the key as empty or test', async () => {
    const {
      envStoreSecretHostManaged,
      envStoreSecretWriteBlocked,
      setEnvStoreRootForTests,
      setInitialEnvironForTests,
      setEnvStoreSecret,
      clearEnvStoreSecret,
    } = await import('@/lib/env-store');
    const root = tempRoot();
    setEnvStoreRootForTests(root);
    writeFileSync(path.join(root, '.env'), 'OTHER=keep\n');
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const attempted = 'sk-wizard-empty-inject-would-not-persist';
    try {
      setInitialEnvironForTests({ OPENAI_API_KEY: '' });
      expect(envStoreSecretHostManaged('OPENAI_API_KEY', root)).toBe(true);
      expect(envStoreSecretHostManaged('OPENAI_API_KEY', root, {}, { OPENAI_API_KEY: '' })).toBe(
        true,
      );
      expect(envStoreSecretWriteBlocked('OPENAI_API_KEY', root)).toBe(true);

      const set = setEnvStoreSecret('OPENAI_API_KEY', attempted, root);
      expect(set).toEqual({ ok: false, reason: 'host_managed' });
      expect(JSON.stringify(set)).not.toContain(attempted);

      const cleared = clearEnvStoreSecret('OPENAI_API_KEY', root);
      expect(cleared).toEqual({ ok: false, reason: 'host_managed' });
      expect(readFileSync(path.join(root, '.env'), 'utf8')).toBe('OTHER=keep\n');
      expect(process.env.OPENAI_API_KEY).toBeUndefined();

      setInitialEnvironForTests({ OPENAI_API_KEY: 'test' });
      expect(envStoreSecretHostManaged('OPENAI_API_KEY', root)).toBe(true);
      expect(envStoreSecretWriteBlocked('OPENAI_API_KEY', root)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it('is not host-managed when the live value matches the file store and exec environ is empty', async () => {
    const { envStoreSecretHostManaged, setEnvStoreRootForTests, setEnvStoreSecret } =
      await import('@/lib/env-store');
    const root = tempRoot();
    setEnvStoreRootForTests(root);
    const rotated = 'sk-openai-file-matched-rotate';
    writeFileSync(path.join(root, '.env'), `OPENAI_API_KEY=${SECRET}\n`);
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = SECRET;
    try {
      expect(envStoreSecretHostManaged('OPENAI_API_KEY', root)).toBe(false);
      expect(setEnvStoreSecret('OPENAI_API_KEY', rotated, root)).toEqual({ ok: true });
      expect(readFileSync(path.join(root, '.env'), 'utf8')).toContain(`OPENAI_API_KEY=${rotated}`);
      expect(process.env.OPENAI_API_KEY).toBe(rotated);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it('upserts, rotates, and clears ANTHROPIC_API_KEY without echoing the value', async () => {
    const {
      setEnvStoreRootForTests,
      setEnvStoreSecret,
      clearEnvStoreSecret,
      envStoreSecretConfigured,
    } = await import('@/lib/env-store');
    const root = tempRoot();
    writeFileSync(path.join(root, '.env'), 'SITE_URL=http://localhost:3000\nOPENAI_API_KEY=keep\n');
    setEnvStoreRootForTests(root);
    const secret = 'sk-anthropic-unit-test-key-never-echo';
    const rotated = 'sk-anthropic-rotated-key-never-echo';
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const written = setEnvStoreSecret('ANTHROPIC_API_KEY', `  ${secret}  `, root);
      expect(written).toEqual({ ok: true });
      expect(JSON.stringify(written)).not.toContain(secret);
      expect(envStoreSecretConfigured('ANTHROPIC_API_KEY')).toBe(true);
      expect(process.env.ANTHROPIC_API_KEY).toBe(secret);
      expect(readFileSync(path.join(root, '.env'), 'utf8')).toContain(
        `ANTHROPIC_API_KEY=${secret}`,
      );
      expect(readFileSync(path.join(root, '.env'), 'utf8')).toContain('OPENAI_API_KEY=keep');
      expect(statSync(path.join(root, '.env')).mode & 0o777).toBe(0o600);

      expect(setEnvStoreSecret('ANTHROPIC_API_KEY', rotated, root)).toEqual({ ok: true });
      expect(readFileSync(path.join(root, '.env'), 'utf8')).toContain(
        `ANTHROPIC_API_KEY=${rotated}`,
      );
      expect(readFileSync(path.join(root, '.env'), 'utf8')).not.toContain(secret);
      expect(process.env.ANTHROPIC_API_KEY).toBe(rotated);

      const cleared = clearEnvStoreSecret('ANTHROPIC_API_KEY', root);
      expect(cleared).toEqual({ ok: true });
      expect(envStoreSecretConfigured('ANTHROPIC_API_KEY')).toBe(false);
      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(readFileSync(path.join(root, '.env'), 'utf8')).not.toMatch(/ANTHROPIC_API_KEY=/);
      expect(readFileSync(path.join(root, '.env'), 'utf8')).toContain('OPENAI_API_KEY=keep');
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it('refuses Anthropic test sentinel, empty values, newlines, and null bytes', async () => {
    const { setEnvStoreSecret } = await import('@/lib/env-store');
    const root = tempRoot();
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(setEnvStoreSecret('ANTHROPIC_API_KEY', 'test', root)).toEqual({
        ok: false,
        reason: 'invalid',
      });
      expect(setEnvStoreSecret('ANTHROPIC_API_KEY', '   ', root)).toEqual({
        ok: false,
        reason: 'invalid',
      });
      expect(setEnvStoreSecret('ANTHROPIC_API_KEY', 'sk-ok\nsk-bad', root)).toEqual({
        ok: false,
        reason: 'invalid',
      });
      expect(setEnvStoreSecret('ANTHROPIC_API_KEY', `sk-ok${'\0'}sk-bad`, root)).toEqual({
        ok: false,
        reason: 'invalid',
      });
      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it('refuses Anthropic writes when exec environ assigns a usable or empty key', async () => {
    const {
      setEnvStoreRootForTests,
      setInitialEnvironForTests,
      setEnvStoreSecret,
      clearEnvStoreSecret,
    } = await import('@/lib/env-store');
    const root = tempRoot();
    setEnvStoreRootForTests(root);
    writeFileSync(path.join(root, '.env'), 'OPENAI_API_KEY=keep\n');
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const attempted = 'sk-anthropic-host-managed-attempt-never-echo';
    try {
      setInitialEnvironForTests({ ANTHROPIC_API_KEY: '' });
      expect(setEnvStoreSecret('ANTHROPIC_API_KEY', attempted, root)).toEqual({
        ok: false,
        reason: 'host_managed',
      });
      expect(clearEnvStoreSecret('ANTHROPIC_API_KEY', root)).toEqual({
        ok: false,
        reason: 'host_managed',
      });
      expect(readFileSync(path.join(root, '.env'), 'utf8')).toBe('OPENAI_API_KEY=keep\n');
      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();

      setInitialEnvironForTests({ ANTHROPIC_API_KEY: 'sk-anth-real-host-key' });
      process.env.ANTHROPIC_API_KEY = 'sk-anth-real-host-key';
      expect(setEnvStoreSecret('ANTHROPIC_API_KEY', attempted, root)).toEqual({
        ok: false,
        reason: 'host_managed',
      });
      expect(clearEnvStoreSecret('ANTHROPIC_API_KEY', root)).toEqual({
        ok: false,
        reason: 'host_managed',
      });
      expect(process.env.ANTHROPIC_API_KEY).toBe('sk-anth-real-host-key');
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it('lets the admin clear a boot test sentinel without saving a dummy key', async () => {
    const {
      clearEnvStoreSecret,
      envStoreSecretConfigured,
      envStoreSecretLiveTest,
      envStoreSecretPresent,
      setEnvStoreRootForTests,
      setInitialEnvironForTests,
    } = await import('@/lib/env-store');
    const root = tempRoot();
    writeFileSync(path.join(root, '.env'), 'ANTHROPIC_API_KEY=test\nOTHER=keep\n');
    setEnvStoreRootForTests(root);
    setInitialEnvironForTests({ ANTHROPIC_API_KEY: 'test' });
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test';
    try {
      expect(envStoreSecretConfigured('ANTHROPIC_API_KEY')).toBe(false);
      expect(envStoreSecretPresent('ANTHROPIC_API_KEY')).toBe(true);
      expect(envStoreSecretLiveTest('ANTHROPIC_API_KEY')).toBe(true);
      const cleared = clearEnvStoreSecret('ANTHROPIC_API_KEY', root);
      expect(cleared).toEqual({ ok: true });
      expect(JSON.stringify(cleared)).not.toContain('test');
      expect(envStoreSecretConfigured('ANTHROPIC_API_KEY')).toBe(false);
      expect(envStoreSecretPresent('ANTHROPIC_API_KEY')).toBe(false);
      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(readFileSync(path.join(root, '.env'), 'utf8')).not.toMatch(/ANTHROPIC_API_KEY=/);
      expect(readFileSync(path.join(root, '.env'), 'utf8')).toContain('OTHER=keep');
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it('keeps writes allowed after replacing a boot test sentinel', async () => {
    const {
      clearEnvStoreSecret,
      envStoreSecretConfigured,
      envStoreSecretHostManaged,
      envStoreSecretLiveTest,
      envStoreSecretWriteBlocked,
      setEnvStoreRootForTests,
      setEnvStoreSecret,
      setInitialEnvironForTests,
    } = await import('@/lib/env-store');
    const root = tempRoot();
    writeFileSync(path.join(root, '.env'), 'ANTHROPIC_API_KEY=test\nOTHER=keep\n');
    setEnvStoreRootForTests(root);
    setInitialEnvironForTests({ ANTHROPIC_API_KEY: 'test' });
    const secret = 'sk-anthropic-after-sentinel-never-echo';
    const rotated = 'sk-anthropic-after-sentinel-rotated-never-echo';
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test';
    try {
      expect(envStoreSecretWriteBlocked('ANTHROPIC_API_KEY', root)).toBe(false);
      expect(setEnvStoreSecret('ANTHROPIC_API_KEY', secret, root)).toEqual({ ok: true });
      expect(process.env.ANTHROPIC_API_KEY).toBe(secret);
      expect(envStoreSecretConfigured('ANTHROPIC_API_KEY')).toBe(true);
      expect(envStoreSecretLiveTest('ANTHROPIC_API_KEY')).toBe(false);
      expect(envStoreSecretHostManaged('ANTHROPIC_API_KEY', root)).toBe(true);
      expect(envStoreSecretWriteBlocked('ANTHROPIC_API_KEY', root)).toBe(false);

      const second = setEnvStoreSecret('ANTHROPIC_API_KEY', rotated, root);
      expect(second).toEqual({ ok: true });
      expect(JSON.stringify(second)).not.toContain(rotated);
      expect(process.env.ANTHROPIC_API_KEY).toBe(rotated);

      const cleared = clearEnvStoreSecret('ANTHROPIC_API_KEY', root);
      expect(cleared).toEqual({ ok: true });
      expect(envStoreSecretConfigured('ANTHROPIC_API_KEY')).toBe(false);
      expect(envStoreSecretWriteBlocked('ANTHROPIC_API_KEY', root)).toBe(false);
      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(readFileSync(path.join(root, '.env'), 'utf8')).not.toMatch(/ANTHROPIC_API_KEY=/);
      expect(readFileSync(path.join(root, '.env'), 'utf8')).toContain('OTHER=keep');
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });
});
