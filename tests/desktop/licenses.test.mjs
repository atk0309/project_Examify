import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { retainRuntimeLicenses } from '../../scripts/desktop/licenses.mjs';

function write(file, value = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-runtime-licenses-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceNodeModules = path.join(root, 'repository/node_modules');
  const app = path.join(root, 'stage');
  fs.mkdirSync(sourceNodeModules, { recursive: true });
  fs.mkdirSync(app);
  function pkg(name, { version = '1.2.3', shipped = true, suffix = '', license = 'MIT' } = {}) {
    const relative = `.pnpm/${name.replace('/', '+')}@${version}${suffix}/node_modules/${name}`;
    const source = path.join(sourceNodeModules, relative);
    const staged = path.join(app, 'node_modules', relative);
    const metadata = JSON.stringify({ name, version, license });
    write(path.join(source, 'package.json'), metadata);
    write(path.join(source, 'index.js'), 'export const value = 1;');
    if (shipped) {
      write(path.join(staged, 'package.json'), metadata);
      write(path.join(staged, 'index.js'), 'export const value = 1;');
    }
    return { source, staged, relative };
  }
  const collect = (bundledInputs = []) =>
    retainRuntimeLicenses(app, { sourceNodeModules, bundledInputs });
  return { root, sourceNodeModules, app, pkg, collect };
}

test('retains exact manifests and omitted notices only for shipped packages', (t) => {
  const f = fixture(t);
  const a = f.pkg('@fixture/runtime', { suffix: '_peer@2.0.0' });
  const unused = f.pkg('build-only', { shipped: false });
  write(path.join(a.source, 'LICENSE.md'), 'Copyright fixture\nMIT license fixture\n');
  write(path.join(a.source, 'legal/NOTICE'), 'Third-party attribution\n');
  write(path.join(a.source, 'COPYING.LESSER'), 'License supplement\n');
  write(path.join(a.source, 'private-untraced.txt'), 'Never retained');
  write(path.join(a.source, '.env'), 'Never retained');
  write(path.join(unused.source, 'LICENSE'), 'Unshipped');
  const inventory = f.collect();
  assert.equal(inventory.packages.length, 1);
  assert.equal(inventory.reviewRequired, false);
  const record = inventory.packages[0];
  assert.equal(record.name, '@fixture/runtime');
  assert.equal(record.version, '1.2.3');
  assert.equal(record.declaredLicense, 'MIT');
  assert.deepEqual(
    record.evidence.map((file) => file.source).sort(),
    ['COPYING.LESSER', 'LICENSE.md', 'legal/NOTICE', 'package.json'].sort(),
  );
  for (const file of record.evidence) {
    const source = fs.readFileSync(path.join(a.source, file.source));
    assert.deepEqual(fs.readFileSync(path.join(f.app, file.path)), source);
    assert.equal(file.sha256, createHash('sha256').update(source).digest('hex'));
  }
  const serialized = fs.readFileSync(path.join(f.app, 'THIRD-PARTY-LICENSES.json'), 'utf8');
  assert.equal(serialized.includes(f.root), false);
  assert.equal(serialized.includes('build-only'), false);
  assert.deepEqual(JSON.parse(serialized), inventory);
  assert.throws(f.collect, /fresh staging destination/);
});

test('bundler inputs retain embedded dependencies without pulling in unused dev tools', (t) => {
  const f = fixture(t);
  const embedded = f.pkg('embedded', { shipped: false });
  f.pkg('unused-development-tool', { shipped: false });
  write(path.join(embedded.source, 'LICENSE'), 'Embedded upstream license');
  const appSource = path.join(f.root, 'repository/src/migrate.ts');
  write(appSource, 'application source');
  const inventory = f.collect([path.join(embedded.source, 'index.js'), appSource]);
  assert.equal(inventory.packages.length, 1);
  assert.deepEqual(inventory.packages[0].shippedPaths, []);
  assert.deepEqual(inventory.packages[0].bundledInputs, ['index.js']);
});

test('Next compiled units retain upstream LEGAL files without inventing versions', (t) => {
  const f = fixture(t);
  const next = f.pkg('next');
  write(path.join(next.source, 'license.md'), 'Next license');
  const shipped = 'dist/compiled/@fixture/embedded';
  write(
    path.join(next.source, shipped, 'package.json'),
    JSON.stringify({ name: '@fixture/embedded', license: 'MIT' }),
  );
  write(path.join(next.source, shipped, 'index.js.LEGAL.txt'), 'Bundled component legal text');
  write(path.join(next.staged, shipped, 'index.js'), 'bundled component code');
  write(
    path.join(next.source, shipped, 'subcomponent/package.json'),
    JSON.stringify({ name: 'nested-component', license: 'ISC' }),
  );
  write(path.join(next.source, 'dist/compiled/unused/LICENSE'), 'Unused compiler license');
  const inventory = f.collect();
  assert.equal(inventory.compiledComponents.length, 1);
  const record = inventory.compiledComponents[0];
  assert.equal(record.name, '@fixture/embedded');
  assert.equal(record.version, null);
  assert.equal(record.parentPackage, inventory.packages[0].sourcePackage);
  assert.deepEqual(
    record.evidence.map((file) => file.source),
    ['index.js.LEGAL.txt', 'package.json', 'subcomponent/package.json'],
  );
  assert.equal(inventory.reviewRequired, false);
  assert.equal(JSON.stringify(inventory).includes('unused'), false);
});

test('missing notices are explicitly unresolved, never fabricated from SPDX metadata', (t) => {
  const f = fixture(t);
  f.pkg('missing-notice', { license: 'Apache-2.0' });
  const inventory = f.collect();
  assert.equal(inventory.reviewRequired, true);
  assert.equal(inventory.warnings.length, 1);
  assert.match(inventory.warnings[0].reason, /not a substitute/);
  assert.deepEqual(
    inventory.packages[0].evidence.map((file) => file.kind),
    ['manifest'],
  );
  assert.match(inventory.scope, /Not a complete SBOM or a legal compliance certification/);
});

test('native library evidence retains the SQLite source notice', (t) => {
  const f = fixture(t);
  const sqlite = f.pkg('better-sqlite3');
  write(path.join(sqlite.source, 'LICENSE'), 'MIT upstream notice');
  write(path.join(sqlite.source, 'deps/sqlite3/sqlite3.h'), '/* SQLite public domain header */\n');
  const inventory = f.collect();
  const sqliteRecord = inventory.packages.find((pkg) => pkg.name === 'better-sqlite3');
  assert.equal(
    sqliteRecord.evidence.some((file) => file.kind === 'native-source-notice'),
    true,
  );
  assert.equal(inventory.reviewRequired, false);
});

test('mismatched source identity fails before emitting a partial notice set', (t) => {
  const f = fixture(t);
  const dep = f.pkg('dependency');
  write(
    path.join(dep.source, 'package.json'),
    JSON.stringify({ name: 'dependency', version: '9.9.9' }),
  );
  assert.throws(f.collect, /identity does not match/);
  assert.equal(fs.existsSync(path.join(f.app, 'licenses')), false);
  assert.equal(fs.existsSync(path.join(f.app, 'THIRD-PARTY-LICENSES.json')), false);
});

test('empty notice placeholders do not satisfy license evidence', (t) => {
  const f = fixture(t);
  const dep = f.pkg('empty-notice');
  write(path.join(dep.source, 'LICENSE'), '\n  \n');
  const inventory = f.collect();
  assert.equal(inventory.reviewRequired, true);
  assert.deepEqual(inventory.packages[0].evidence.map((file) => file.kind).sort(), [
    'empty-notice',
    'manifest',
  ]);
  assert.match(inventory.warnings[0].reason, /No standalone upstream license/);
});

test('a bundled input cannot escape through an external file link', (t) => {
  const f = fixture(t);
  const dep = f.pkg('embedded', { shipped: false });
  const outside = path.join(f.root, 'private-secret.js');
  write(outside, 'Must never read');
  const linked = path.join(dep.source, 'linked.js');
  try {
    fs.symlinkSync(outside, linked, 'file');
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM')
      return t.skip('File symlinks require Windows Developer Mode.');
    throw error;
  }
  assert.throws(() => f.collect([linked]), /Bundled input escapes/);
  assert.equal(fs.existsSync(path.join(f.app, 'licenses')), false);
});

test('external package links are refused without exposing the external target', (t) => {
  const f = fixture(t);
  const dep = f.pkg('dependency');
  const outside = path.join(f.root, 'private-secrets');
  fs.renameSync(dep.source, outside);
  fs.symlinkSync(outside, dep.source, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(f.collect, (error) => {
    assert.match(error.message, /exact in-tree pnpm package/);
    assert.equal(error.message.includes('private-secrets'), false);
    return true;
  });
  assert.equal(fs.existsSync(path.join(f.app, 'licenses')), false);
});

test('linked notice files and directories cannot read outside the installation', (t) => {
  for (const directory of [false, true]) {
    const f = fixture(t);
    const dep = f.pkg('dependency');
    const outside = path.join(f.root, 'private-secret');
    if (directory) {
      write(path.join(outside, 'LICENSE'), 'Must never read');
      fs.symlinkSync(
        outside,
        path.join(dep.source, 'legal'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } else {
      write(outside, 'Must never read');
      try {
        fs.symlinkSync(outside, path.join(dep.source, 'LICENSE'), 'file');
      } catch (error) {
        if (process.platform === 'win32' && error.code === 'EPERM') continue;
        throw error;
      }
    }
    assert.throws(f.collect, /Linked license/);
    assert.equal(fs.existsSync(path.join(f.app, 'licenses')), false);
  }
});

test('staging links and preexisting output are rejected before writing through them', (t) => {
  const f = fixture(t);
  const dep = f.pkg('dependency');
  fs.rmSync(dep.staged, { recursive: true });
  fs.symlinkSync(dep.source, dep.staged, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(f.collect, /link-free staged runtime/);
  const g = fixture(t);
  const outside = path.join(g.root, 'external-output');
  fs.mkdirSync(outside);
  fs.symlinkSync(
    outside,
    path.join(g.app, 'licenses'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.throws(g.collect, /fresh staging destination/);
  assert.deepEqual(fs.readdirSync(outside), []);
});
