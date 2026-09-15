#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const tsxLoader = require.resolve('tsx');
const entry = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const result = spawnSync(
  process.execPath,
  ['--import', tsxLoader, entry, ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: process.env,
  },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
