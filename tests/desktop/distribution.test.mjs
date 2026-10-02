import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  assetNames,
  committedLockfileSha256,
  assembleReleaseSet,
  digest,
  platforms,
  verifyDistribution,
  writeDistribution,
  policyName,
} from '../../scripts/desktop/distribution.mjs';
const repo = path.resolve(import.meta.dirname, '../..');
function fixture(t, version = '0.1.0') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-assets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const platform of platforms) {
    const dir = path.join(root, platform);
    fs.mkdirSync(dir);
    const archive = assetNames(version, platform).find((name) => /\.(zip|tar.gz)$/.test(name));
    fs.writeFileSync(path.join(dir, archive), `fixture ${platform}`);
    const sha = digest(path.join(dir, archive));
    fs.writeFileSync(path.join(dir, `${archive}.sha256`), `${sha}  ${archive}\n`);
    fs.writeFileSync(path.join(dir, policyName(platform)), '{}\n');
    const installer = platform === 'win32-x64' ? 'install.ps1' : 'install-solo.sh';
    fs.writeFileSync(
      path.join(dir, installer),
      fs
        .readFileSync(path.join(repo, installer), 'utf8')
        .replaceAll('__EXAMIFY_VERSION__', version)
        .replaceAll('__EXAMIFY_SHA256__', sha),
    );
    if (platform === 'win32-x64')
      fs.writeFileSync(
        path.join(dir, 'install.cmd'),
        fs
          .readFileSync(path.join(repo, 'install.cmd'), 'utf8')
          .replaceAll('__EXAMIFY_VERSION__', version)
          .replaceAll('__EXAMIFY_INSTALL_PS_SHA256__', digest(path.join(dir, installer))),
      );
    writeDistribution(dir, {
      version,
      platform,
      upgradeProtocol: 1,
      imageOptimization: 'disabled',
      sourceCommit: 'a'.repeat(40),
      lockfileSha256: 'b'.repeat(64),
      nodeArchiveSha256: 'c'.repeat(64),
      nodeVersion: '22.22.2',
      sourceDirty: false,
      localPreview: false,
    });
  }
  return root;
}
test('complete native set preserves identities/assets and refuses overwriting evidence', (t) => {
  const root = fixture(t);
  const output = path.join(root, 'candidate');
  const result = assembleReleaseSet(root, output);
  assert.equal(result.assets.length, 13);
  assert.equal(result.status, 'candidate-not-approved-for-publication');
  for (const asset of result.assets)
    assert.equal(digest(path.join(output, asset.name)), asset.sha256);
  assert.throws(() => assembleReleaseSet(root, output), /never overwrite/);
});
for (const platform of platforms) {
  test(`${platform}: tampering, missing assets and private extras are refused`, (t) => {
    const root = fixture(t),
      dir = path.join(root, platform),
      name = platform === 'win32-x64' ? 'install.cmd' : 'install-solo.sh';
    const original = fs.readFileSync(path.join(dir, name));
    fs.appendFileSync(path.join(dir, name), 'changed');
    assert.throws(() => verifyDistribution(dir, platform), /checksum mismatch/);
    fs.writeFileSync(path.join(dir, name), original);
    fs.writeFileSync(path.join(dir, 'secrets.json'), '{}');
    assert.throws(() => verifyDistribution(dir, platform), /unexpected files/);
    fs.unlinkSync(path.join(dir, 'secrets.json'));
    fs.unlinkSync(path.join(dir, name));
    assert.throws(() => verifyDistribution(dir, platform), /unexpected files/);
  });
  test(`${platform}: matching comment text and duplicate assignments do not satisfy pins`, (t) => {
    const root = fixture(t),
      dir = path.join(root, platform),
      identity = verifyDistribution(dir, platform),
      file = path.join(dir, platform === 'win32-x64' ? 'install.ps1' : 'install-solo.sh'),
      original = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, original.replace("'0.1.0'", "'9.9.9'") + "\n# '0.1.0'\n");
    assert.throws(() => writeDistribution(dir, identity), /does not pin/);
    fs.writeFileSync(
      file,
      original + (platform === 'win32-x64' ? "\n$Version = '0.1.0'\n" : "\nVERSION='0.1.0'\n"),
    );
    assert.throws(() => writeDistribution(dir, identity), /does not pin/);
  });
}
test('mixed source/version/Node, dirty previews and unordered versions cannot be RC sets', (t) => {
  const root = fixture(t),
    dir = path.join(root, 'linux-x64'),
    identity = verifyDistribution(dir, 'linux-x64');
  for (const patch of [
    { sourceCommit: 'd'.repeat(40) },
    { sourceDirty: true },
    { localPreview: true },
    { nodeVersion: '22.23.0' },
  ]) {
    writeDistribution(dir, { ...identity, ...patch });
    assert.throws(() => assembleReleaseSet(root, path.join(root, 'out')), /one clean source/);
  }
  const preview = fixture(t, 'ci-preview');
  assert.throws(() => assembleReleaseSet(preview, path.join(preview, 'out')), /stable numeric/);
});
test('wrong CMD pins, escaping names and linked assets fail closed', (t) => {
  assert.throws(() => assetNames('../escape', 'linux-x64'));
  const root = fixture(t),
    dir = path.join(root, 'win32-x64'),
    identity = verifyDistribution(dir, 'win32-x64');
  fs.writeFileSync(path.join(dir, 'install.cmd'), '@echo off\n');
  assert.throws(() => writeDistribution(dir, identity), /bootstrap does not pin/);
  const linux = path.join(root, 'linux-x64'),
    file = path.join(linux, 'install-solo.sh');
  fs.renameSync(file, path.join(root, 'script'));
  try {
    fs.symlinkSync(path.join(root, 'script'), file);
  } catch (error) {
    if (error.code === 'EPERM') return t.skip('Symlink creation unavailable');
    throw error;
  }
  assert.throws(() => verifyDistribution(linux, 'linux-x64'), /regular file/);
});

test('lockfile source identity is stable across Windows checkout line endings', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-lock-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '--quiet');
  git('config', 'core.autocrlf', 'false');
  const file = path.join(root, 'pnpm-lock.yaml');
  fs.writeFileSync(file, 'lockfileVersion: 9\nsettings: {}\n');
  const expected = digest(file);
  git('add', 'pnpm-lock.yaml');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  );
  fs.writeFileSync(file, 'lockfileVersion: 9\r\nsettings: {}\r\n');
  assert.notEqual(digest(file), expected);
  assert.equal(committedLockfileSha256(root), expected);
});
