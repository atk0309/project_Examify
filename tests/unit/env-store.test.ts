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
  const { setEnvStoreRootForTests } = await import('@/lib/env-store');
  setEnvStoreRootForTests(null);
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

  it('resolves the same repo root as content and ingest from a subdirectory', async () => {
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
    delete process.env.OPENAI_API_KEY;
    try {
      process.chdir(nested);
      expect(getEnvStoreRoot()).toBe(root);
      expect(getOnboardingContentRoot()).toBe(root);
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
    expect(content).toMatch(/from '@\/lib\/repo-root'/);
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
});
