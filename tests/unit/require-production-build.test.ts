import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { productionBuildReady, requireProductionBuild } from '../e2e/require-production-build';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-build-'));
  dirs.push(dir);
  return dir;
}

describe('requireProductionBuild', () => {
  it('rejects a tree with no .next/BUILD_ID', () => {
    const cwd = tmp();
    expect(productionBuildReady(cwd)).toBe(false);
    expect(() => requireProductionBuild(cwd)).toThrow(/pnpm build/);
  });

  it('accepts a tree that already has a production build id', () => {
    const cwd = tmp();
    fs.mkdirSync(path.join(cwd, '.next'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.next', 'BUILD_ID'), 'test');
    expect(productionBuildReady(cwd)).toBe(true);
    expect(() => requireProductionBuild(cwd)).not.toThrow();
  });
});
