import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import {
  createRuntimePolicy,
  validateRuntimePolicy,
} from '../../scripts/desktop/distribution-policy.mjs';
import { loadSupplementalNotices } from '../../scripts/desktop/supplemental-licenses.mjs';
const repo = path.resolve(import.meta.dirname, '../..');
const identity = { version: '0.1.0', platform: 'linux-x64', sourceCommit: 'a'.repeat(40) };
function fixture(t) {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-portable-policy-'));
  t.after(() => fs.rmSync(app, { recursive: true, force: true }));
  const put = (name, content) => {
    const file = path.join(app, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  const licenses = {
    packages: [
      { name: 'better-sqlite3', version: '13.0.3' },
      { name: '@next/env', version: '16.3.6' },
    ],
    warnings: [],
  };
  put('server.js', 'const nextConfig = {"images":{"unoptimized":true}}\n');
  put('runtime-links.json', '[]');
  put('LICENSE', 'application fixture');
  put('runtime/LICENSE', 'runtime fixture');
  put('THIRD-PARTY-LICENSES.json', JSON.stringify(licenses));
  put(
    'node_modules/.pnpm/better-sqlite3@13.0.3/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
    'native fixture',
  );
  for (const file of loadSupplementalNotices(licenses.packages).files)
    put(file.destination, file.bytes);
  return { app, put, licenses };
}
test('portable policy verifies actual serialized mode, native inventory and exact notice bytes', (t) => {
  const { app, licenses } = fixture(t);
  const policy = createRuntimePolicy(app, identity, licenses);
  assert.equal(policy.imageOptimization, 'disabled');
  assert.equal(policy.supplementalDocuments.length, 2);
  assert.doesNotThrow(() => validateRuntimePolicy(policy, identity));
  for (const patch of [
    { imageOptimization: 'enabled' },
    { sourceCommit: 'b'.repeat(40) },
    { packages: [...policy.packages, { name: 'sharp', version: '0.35.4' }] },
    { nativeBinaries: ['node_modules/libvips.so'] },
    { supplementalDocuments: [] },
  ])
    assert.throws(() => validateRuntimePolicy({ ...policy, ...patch }, identity));
});
test('metadata labels cannot hide a real optimizer or retained native package', (t) => {
  const { app, put, licenses } = fixture(t);
  put('server.js', 'const nextConfig = {"images":{"unoptimized":false}}\n');
  assert.throws(() => createRuntimePolicy(app, identity, licenses), /actual standalone/);
  put('server.js', 'const nextConfig = {"images":{"unoptimized":true}}\n');
  put('node_modules/@img/sharp-linux-x64/package.json', '{}');
  assert.throws(() => createRuntimePolicy(app, identity, licenses), /image packages remain/);
});
test('stale module links, unreviewed native libraries and altered notices are blocked', (t) => {
  const { app, put, licenses } = fixture(t);
  put(
    'runtime-links.json',
    JSON.stringify([
      { path: 'node_modules/sharp', target: 'node_modules/.pnpm/sharp@0.35.4/node_modules/sharp' },
    ]),
  );
  assert.throws(() => createRuntimePolicy(app, identity, licenses), /links still reference/);
  put('runtime-links.json', '[]');
  put('runtime/unreviewed.so', 'fixture');
  assert.throws(() => createRuntimePolicy(app, identity, licenses), /Unreviewed bundled/);
  fs.unlinkSync(path.join(app, 'runtime/unreviewed.so'));
  const notice = loadSupplementalNotices(licenses.packages).documents[0];
  put(notice.path, 'changed');
  assert.throws(() => createRuntimePolicy(app, identity, licenses), /notice is missing or changed/);
});
test('default and hosted configuration are unchanged; portable tracing covers server and routes', () => {
  const config = (value) => {
    const env = { ...process.env };
    delete env.EXAMIFY_PORTABLE_BUILD;
    if (value !== undefined) env.EXAMIFY_PORTABLE_BUILD = value;
    return JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          "import config from './next.config.mjs'; console.log(JSON.stringify(config))",
        ],
        { cwd: repo, env, encoding: 'utf8' },
      ),
    );
  };
  const original = config(),
    disabled = config('0'),
    portable = config('1');
  assert.deepEqual(original, disabled);
  assert.equal(original.images, undefined);
  assert.equal(original.outputFileTracingExcludes, undefined);
  assert.equal(portable.images.unoptimized, true);
  const { images: _images, outputFileTracingExcludes: exclusions, ...rest } = portable;
  assert.deepEqual(rest, original);
  const require = createRequire(import.meta.url),
    picomatch = require('next/dist/compiled/picomatch');
  for (const entry of ['next-server', '/api/health', '/'])
    assert.ok(
      Object.keys(exclusions).some((pattern) => picomatch(pattern)(entry)),
      `Exclusion applies to ${entry}`,
    );
  for (const file of [
    'node_modules/sharp/lib/index.js',
    'node_modules/@img/sharp-linux-x64/lib/sharp.node',
    'node_modules/.pnpm/sharp@0.35.4/node_modules/sharp/package.json',
    'node_modules/.pnpm/@img+sharp-libvips-linux-x64@1.3.3/node_modules/@img/sharp-libvips-linux-x64/lib/libvips.so',
  ])
    assert.ok(
      Object.values(exclusions)
        .flat()
        .some((pattern) => picomatch(pattern, { dot: true })(file)),
      file,
    );
});
