import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEnvStoreRoot, setEnvStoreRootForTests } from '@/lib/env-store';

const roots: string[] = [];
afterEach(() => {
  setEnvStoreRootForTests(null);
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const parent = path.join(process.cwd(), 'tests', '.tmp');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'env-root-'));
  roots.push(root);
  return root;
}

describe('browser settings fixture env-store confinement', () => {
  it('uses only the disposable root with the explicit stub gate', () => {
    const root = fixture();
    vi.stubEnv('GRADING_STUB', '1');
    vi.stubEnv('EXAMIFY_TEST_ENV_STORE_DIR', path.join(root, 'env-store'));
    expect(getEnvStoreRoot()).toBe(path.join(root, 'env-store'));
  });
  it('refuses an override without the gate rather than writing the real store', () => {
    vi.stubEnv('GRADING_STUB', '');
    vi.stubEnv('EXAMIFY_TEST_ENV_STORE_DIR', fixture());
    expect(() => getEnvStoreRoot()).toThrow('test_env_store_disabled');
  });
  it.each(['.', 'tests/.tmp', '/tmp/outside', 'tests/.tmp/../../data'])(
    'refuses %s outside the fixture subtree',
    (root) => {
      vi.stubEnv('GRADING_STUB', '1');
      vi.stubEnv('EXAMIFY_TEST_ENV_STORE_DIR', root);
      expect(() => getEnvStoreRoot()).toThrow('unsafe_test_env_store');
    },
  );
  it('refuses a symlink within the fixture subtree', () => {
    const root = fixture();
    symlinkSync(process.cwd(), path.join(root, 'link'), 'dir');
    vi.stubEnv('GRADING_STUB', '1');
    vi.stubEnv('EXAMIFY_TEST_ENV_STORE_DIR', path.join(root, 'link', 'env-store'));
    expect(() => getEnvStoreRoot()).toThrow('unsafe_test_env_store');
  });
});
