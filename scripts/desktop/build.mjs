#!/usr/bin/env node
// Release builds must start and finish from committed, clean source.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
if (git('status', '--porcelain'))
  throw new Error('Release builds require a clean committed checkout.');
const commit = git('rev-parse', 'HEAD');
fs.rmSync(path.join(root, '.next'), { recursive: true, force: true });
execFileSync(process.execPath, [require.resolve('next/dist/bin/next'), 'build'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
});
if (git('status', '--porcelain') || git('rev-parse', 'HEAD') !== commit)
  throw new Error('Source changed during the build.');
fs.writeFileSync(
  path.join(root, '.next/desktop-build.json'),
  JSON.stringify({ commit, clean: true }),
);
