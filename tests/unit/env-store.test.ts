import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

  it('refuses the test sentinel, empty values, and newlines', async () => {
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
    expect(process.env.OPENAI_API_KEY).not.toBe('test');
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
