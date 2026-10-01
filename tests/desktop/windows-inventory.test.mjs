import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertReleaseInventory,
  copyStandaloneRuntime,
  relativeRuntimePath,
} from '../../scripts/desktop/inventory.mjs';
import { restoreRuntimeLinks } from '../../scripts/desktop/restore-links.mjs';

function write(file, value = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function directoryLink(target, link) {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  // Junctions reproduce pnpm's absolute Windows links without requiring Developer Mode.
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-windows-inventory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceNodeModules = path.join(root, 'repository/node_modules');
  const standalone = path.join(root, 'repository/.next/standalone');
  const destination = path.join(root, 'portable app');
  fs.mkdirSync(sourceNodeModules, { recursive: true });
  fs.mkdirSync(path.join(standalone, '.next'), { recursive: true });
  fs.mkdirSync(path.join(standalone, 'node_modules'), { recursive: true });
  write(path.join(standalone, 'server.js'));
  write(path.join(standalone, 'package.json'), '{}');
  function pkg(name, version = '1.2.3', suffix = '') {
    const relative = `.pnpm/${name.replace('/', '+')}@${version}${suffix}/node_modules/${name}`;
    const source = path.join(sourceNodeModules, relative);
    const traced = path.join(standalone, 'node_modules', relative);
    for (const dir of [source, traced]) {
      write(path.join(dir, 'package.json'), JSON.stringify({ name, version }));
      write(path.join(dir, 'index.js'), "module.exports = 'traced';");
    }
    return { relative, source, traced };
  }
  const copy = () => copyStandaloneRuntime(standalone, destination, { sourceNodeModules });
  return { root, sourceNodeModules, standalone, destination, pkg, copy };
}

test('canonical Windows boundaries accept drive/UNC namespaces and case, but not sibling roots', () => {
  assert.equal(
    relativeRuntimePath(
      'D:\\Build\\Standalone',
      '\\\\?\\d:\\build\\standalone\\node_modules\\pkg',
      path.win32,
    ),
    'node_modules/pkg',
  );
  assert.equal(
    relativeRuntimePath('\\\\?\\D:\\Build\\Standalone', 'd:\\build\\standalone', path.win32),
    '',
  );
  assert.equal(
    relativeRuntimePath(
      '\\\\server\\share\\build',
      '\\\\?\\UNC\\SERVER\\SHARE\\build\\pkg',
      path.win32,
    ),
    'pkg',
  );
  assert.equal(relativeRuntimePath('D:\\build', 'D:\\build-other\\pkg', path.win32), null);
  assert.equal(relativeRuntimePath('D:\\build', 'C:\\build\\pkg', path.win32), null);
  assert.equal(relativeRuntimePath('/build/Runtime', '/build/runtime/pkg', path.posix), null);
});

test('absolute checkout junctions rebase to traced pnpm modules without copying checkout content', (t) => {
  const f = fixture(t);
  const parent = f.pkg('parent', '1.2.3', '_peer@2.0.0');
  const child = f.pkg('@fixture/child', '2.0.0');
  write(path.join(parent.traced, 'index.js'), "module.exports = require('@fixture/child');");
  write(path.join(parent.source, 'index.js'), "module.exports = 'wrong-checkout-copy';");
  for (const name of ['.env', '.git/config', 'private.db', 'private-untraced.txt'])
    write(path.join(parent.source, name), 'must not enter release');
  directoryLink(parent.source, path.join(f.standalone, 'node_modules/parent'));
  directoryLink(child.source, path.join(parent.traced, '../@fixture/child'));
  directoryLink(parent.source, path.join(child.traced, '../../parent'));
  directoryLink(child.source, path.join(f.standalone, '.next/node_modules/child-traced-hash'));

  f.copy();
  const files = assertReleaseInventory(f.destination);
  assert.equal(
    files.some((file) => file.includes('private-') || file.endsWith('.env')),
    false,
  );
  const links = JSON.parse(fs.readFileSync(path.join(f.destination, 'runtime-links.json'), 'utf8'));
  assert.equal(links.length, 4);
  for (const link of links) {
    assert.match(link.target, /^node_modules\/\.pnpm\//);
    assert.equal(path.isAbsolute(link.target), false);
    assert.equal(link.target.includes('..'), false);
  }
  // A relocated archive must work after the entire build checkout disappears.
  fs.rmSync(path.join(f.root, 'repository'), { recursive: true, force: true });
  restoreRuntimeLinks(f.destination);
  restoreRuntimeLinks(f.destination);
  const require = createRequire(path.join(f.destination, 'package.json'));
  assert.equal(require('parent'), 'traced');
  assert.equal(require('./.next/node_modules/child-traced-hash'), 'traced');
});

test('external junctions require the explicit source node_modules root and hide external paths', (t) => {
  const f = fixture(t);
  const pkg = f.pkg('dependency');
  const link = path.join(f.standalone, 'node_modules/dependency');
  directoryLink(pkg.source, link);
  assert.throws(
    () => copyStandaloneRuntime(f.standalone, f.destination),
    /target is not a trusted pnpm package/,
  );
  fs.unlinkSync(link);
  const outside = path.join(f.root, 'private-location/node_modules', pkg.relative);
  write(path.join(outside, 'index.js'), 'private fixture content');
  directoryLink(outside, link);
  assert.throws(f.copy, (error) => {
    assert.match(error.message, /node_modules\/dependency/);
    assert.match(error.message, /target is not a trusted pnpm package/);
    assert.equal(error.message.includes('private-location'), false);
    assert.equal(error.message.includes(f.root), false);
    return true;
  });
});

test('a missing traced counterpart is never filled from the original package', (t) => {
  const f = fixture(t);
  const pkg = f.pkg('dependency');
  fs.rmSync(pkg.traced, { recursive: true });
  directoryLink(pkg.source, path.join(f.standalone, 'node_modules/dependency'));
  assert.throws(f.copy, /traced package counterpart is missing or unsafe/);
  assert.equal(fs.existsSync(path.join(f.destination, 'runtime-links.json')), false);
});

test('rebasing rejects mismatched or unpinned package identities', (t) => {
  for (const metadata of [
    { name: 'other', version: '1.2.3' },
    { name: 'dependency', version: '1.2.4' },
    { name: 'dependency', version: '^1.2.3' },
  ]) {
    const f = fixture(t);
    const pkg = f.pkg('dependency');
    write(path.join(pkg.traced, 'package.json'), JSON.stringify(metadata));
    directoryLink(pkg.source, path.join(f.standalone, 'node_modules/dependency'));
    assert.throws(f.copy, /identity does not match its pinned pnpm locator/);
  }
});

test('rebasing never follows a traced counterpart junction back into the checkout', (t) => {
  const f = fixture(t);
  const pkg = f.pkg('dependency');
  fs.rmSync(pkg.traced, { recursive: true });
  directoryLink(pkg.source, pkg.traced);
  directoryLink(pkg.source, path.join(f.standalone, 'node_modules/dependency'));
  assert.throws(f.copy, /traced package counterpart is missing or unsafe/);
});

test('rebasing refuses a linked ancestor even when it points to another in-tree package', (t) => {
  const f = fixture(t);
  const pkg = f.pkg('dependency');
  const aliased = path.join(f.standalone, 'node_modules/aliased-package');
  fs.renameSync(path.dirname(pkg.traced), aliased);
  directoryLink(aliased, path.dirname(pkg.traced));
  directoryLink(pkg.source, path.join(f.standalone, 'node_modules/dependency'));
  assert.throws(f.copy, /traced package counterpart is missing or unsafe/);
});

test('directory links to checkout data and staged non-module files remain forbidden', (t) => {
  for (const name of ['data', '.git', '.ssh', 'config']) {
    const f = fixture(t);
    const privateDir = path.join(f.root, 'repository', name);
    write(path.join(privateDir, 'private.txt'), 'must not copy');
    directoryLink(privateDir, path.join(f.standalone, 'node_modules/escape'));
    assert.throws(f.copy, /target is not a trusted pnpm package/);
  }
  const f = fixture(t);
  write(path.join(f.standalone, 'data/private.txt'), 'must not copy');
  directoryLink(path.join(f.standalone, 'data'), path.join(f.standalone, 'node_modules/escape'));
  assert.throws(f.copy, /directory links must stay in packaged runtime modules/);
});

test('forbidden traced entries fail before their bytes are copied', (t) => {
  for (const name of [
    '.env.local',
    '.git/config',
    'private.sqlite',
    'secrets.json',
    '.Env.Local',
    '.GIT/config',
    'Secrets.json',
  ]) {
    const f = fixture(t);
    const pkg = f.pkg('dependency');
    write(path.join(pkg.traced, name), 'secret fixture');
    assert.throws(f.copy, /Forbidden release entry/);
    assert.equal(
      fs.existsSync(path.join(f.destination, 'node_modules', pkg.relative, name)),
      false,
    );
  }
});
