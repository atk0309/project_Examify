import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'examify solo dispatch '));
  roots.push(root);
  writeFileSync(path.join(root, 'install.sh'), readFileSync('install.sh'));
  return root;
}
describe('household installer solo dispatch', () => {
  it('passes arguments to its sibling before any household work', () => {
    const root = fixture();
    writeFileSync(path.join(root, 'install-solo.sh'), '#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n');
    const result = spawnSync(
      'bash',
      [path.join(root, 'install.sh'), '--solo', '--root', '/tmp/study with spaces', '--no-launch'],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('--root\n/tmp/study with spaces\n--no-launch\n');
  });
  it('refuses a missing sibling instead of starting household setup', () => {
    const root = fixture();
    const result = spawnSync('bash', [path.join(root, 'install.sh'), '--solo'], {
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('matching personal-study installer is missing');
  });
});
