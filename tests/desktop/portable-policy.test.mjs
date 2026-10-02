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
import { digest } from '../../scripts/desktop/distribution.mjs';
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
    compiledComponents: [],
    warnings: [],
  };
  for (const record of licenses.packages) {
    const base = `node_modules/.pnpm/${record.name.replace('/', '+')}@${record.version}/node_modules/${record.name}`;
    const manifest = JSON.stringify({ name: record.name, version: record.version });
    const retained = `licenses/${record.name.replace('/', '-')}/package.json`;
    put(`${base}/package.json`, manifest);
    put(retained, manifest);
    record.shippedPaths = [base];
    record.bundledInputs = [];
    record.evidence = [
      {
        kind: 'manifest',
        source: 'package.json',
        path: retained,
        sha256: digest(path.join(app, retained)),
      },
    ];
    const notice = `licenses/${record.name.replace('/', '-')}/LICENSE`;
    put(notice, 'retained license fixture');
    record.evidence.push({
      kind: 'notice',
      source: 'LICENSE',
      path: notice,
      sha256: digest(path.join(app, notice)),
    });
  }
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

test('embedded helper packages retain verified identity without invented runtime paths', (t) => {
  const { app, put, licenses } = fixture(t);
  const record = {
    name: 'embedded-helper',
    version: '1.0.0',
    shippedPaths: [],
    bundledInputs: ['index.js'],
    evidence: [],
  };
  const retained = 'licenses/embedded-helper/package.json';
  put(retained, JSON.stringify({ name: record.name, version: record.version }));
  record.evidence.push({
    kind: 'manifest',
    source: 'package.json',
    path: retained,
    sha256: digest(path.join(app, retained)),
  });
  licenses.packages.push(record);
  assert.doesNotThrow(() => createRuntimePolicy(app, identity, licenses));
  record.bundledInputs = [];
  assert.throws(
    () => createRuntimePolicy(app, identity, licenses),
    /no shipped or bundled provenance/,
  );
});

test('compiled evidence paths must identify contained regular files with matching hashes', (t) => {
  const { app, put, licenses } = fixture(t);
  const file = 'licenses/compiled/LICENSE';
  put(file, 'compiled notice');
  const evidence = { path: file, sha256: digest(path.join(app, file)) };
  licenses.compiledComponents.push({ evidence: [evidence] });
  assert.doesNotThrow(() => createRuntimePolicy(app, identity, licenses));
  for (const invalid of ['../LICENSE', '/LICENSE', 'licenses/compiled', 'licenses/missing']) {
    evidence.path = invalid;
    assert.throws(() => createRuntimePolicy(app, identity, licenses), /license evidence/);
  }
  evidence.path = file;
  put(file, 'altered compiled notice');
  assert.throws(() => createRuntimePolicy(app, identity, licenses), /license evidence/);
});

test('actual shipped manifests cannot be omitted from the inventory or duplicated', (t) => {
  const { app, put, licenses } = fixture(t);
  put(
    'node_modules/undeclared/package.json',
    JSON.stringify({ name: 'undeclared', version: '1.0.0' }),
  );
  assert.throws(
    () => createRuntimePolicy(app, identity, licenses),
    /missing from license inventory/,
  );
  fs.rmSync(path.join(app, 'node_modules/undeclared'), { recursive: true });
  licenses.packages.push(licenses.packages[0]);
  assert.throws(() => createRuntimePolicy(app, identity, licenses), /Duplicate shipped/);
});
