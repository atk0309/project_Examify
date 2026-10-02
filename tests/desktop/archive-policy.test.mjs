/** Real archive parsing/extraction, with inert fixtures. Never executes archive code. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { digest, policyName, writeDistribution } from '../../scripts/desktop/distribution.mjs';
import {
  assertRedistributionReady,
  createRuntimePolicy,
} from '../../scripts/desktop/distribution-policy.mjs';
import { loadSupplementalNotices } from '../../scripts/desktop/supplemental-licenses.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const platform = `${process.platform}-${process.arch}`;
const supported = ['linux-x64', 'win32-x64'].includes(platform);
const windows = process.platform === 'win32';
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function archiveTool(operation, source, destination) {
  return execFileSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      path.join(repo, 'scripts/desktop/archive.ps1'),
      '-Operation',
      operation,
      '-Source',
      source,
      '-Destination',
      destination,
    ],
    { stdio: 'pipe' },
  );
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-archive-regression-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, 'app');
  const out = path.join(root, 'distribution');
  fs.mkdirSync(app);
  fs.mkdirSync(out);
  const put = (name, bytes) => {
    const file = path.join(app, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  };
  const identity = {
    version: '0.1.0',
    platform,
    sourceCommit: 'a'.repeat(40),
    nodeVersion: '22.22.2',
    nodeArchiveSha256: 'b'.repeat(64),
    lockfileSha256: 'c'.repeat(64),
    upgradeProtocol: 1,
    localPreview: false,
    sourceDirty: false,
    imageOptimization: 'disabled',
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
  put('LICENSE', 'Application fixture license');
  put('runtime/LICENSE', 'Runtime fixture license');
  put('THIRD-PARTY-LICENSES.json', json(licenses));
  put('desktop-release.json', json(identity));
  put(
    'node_modules/.pnpm/better-sqlite3@13.0.3/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
    'Inert native-library fixture, never loaded or executed.',
  );
  for (const notice of loadSupplementalNotices(licenses.packages).files)
    put(notice.destination, notice.bytes);
  const policy = createRuntimePolicy(app, identity, licenses);
  put('desktop-runtime-policy.json', json(policy));
  fs.writeFileSync(path.join(out, policyName(platform)), json(policy));
  const asset = `examify-${identity.version}-${platform}.${windows ? 'zip' : 'tar.gz'}`;
  const archive = path.join(out, asset);

  function refreshDistribution() {
    // Recompute all outer checksums so each failure must inspect the archive,
    // rather than merely noticing a stale download checksum or installer pin.
    const hash = digest(archive);
    fs.writeFileSync(`${archive}.sha256`, `${hash}  ${asset}\n`);
    const installer = windows ? 'install.ps1' : 'install-solo.sh';
    fs.writeFileSync(
      path.join(out, installer),
      fs
        .readFileSync(path.join(repo, installer), 'utf8')
        .replaceAll('__EXAMIFY_VERSION__', identity.version)
        .replaceAll('__EXAMIFY_SHA256__', hash),
    );
    if (windows) {
      fs.writeFileSync(
        path.join(out, 'install.cmd'),
        fs
          .readFileSync(path.join(repo, 'install.cmd'), 'utf8')
          .replaceAll('__EXAMIFY_VERSION__', identity.version)
          .replaceAll('__EXAMIFY_INSTALL_PS_SHA256__', digest(path.join(out, installer))),
      );
    }
    writeDistribution(out, identity);
  }

  function pack(extra = []) {
    fs.rmSync(archive, { force: true });
    if (windows) archiveTool('create', app, archive);
    else execFileSync('tar', ['-czf', archive, ...extra, '-C', app, '.'], { stdio: 'pipe' });
    refreshDistribution();
  }

  function appendZip(name, attributes = 0) {
    // .NET emits the real central-directory attributes checked by verify-extract.
    // Even the deliberately escaping paths lead only to this disposable root.
    execFileSync(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression; ` +
          `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
          `$zip=[IO.Compression.ZipFile]::Open(${quote(archive)},[IO.Compression.ZipArchiveMode]::Update); ` +
          `try { $entry=$zip.CreateEntry(${quote(name)}); $entry.ExternalAttributes=[int]${attributes}; ` +
          `$writer=New-Object IO.StreamWriter($entry.Open()); try { $writer.Write('inert fixture'); } ` +
          `finally { $writer.Dispose(); } } finally { $zip.Dispose(); }`,
      ],
      { stdio: 'pipe' },
    );
    refreshDistribution();
  }
  return { root, app, out, archive, identity, policy, put, pack, appendZip, refreshDistribution };
}

test(
  'native archive gate re-extracts and verifies a consistent inert fixture',
  { skip: !supported },
  (t) => {
    const f = fixture(t);
    f.pack();
    assert.deepEqual(assertRedistributionReady(f.out, platform), f.policy);
  },
);

test(
  'valid outer pins cannot hide an enabled optimizer inside the archive',
  { skip: !supported },
  (t) => {
    const f = fixture(t);
    f.put('server.js', 'const nextConfig = {"images":{"unoptimized":false}}\n');
    f.pack();
    assert.throws(() => assertRedistributionReady(f.out, platform), /actual standalone/);
  },
);

test(
  'valid outer pins cannot hide mismatched archive source identity',
  { skip: !supported },
  (t) => {
    const f = fixture(t);
    f.put('desktop-release.json', json({ ...f.identity, sourceCommit: 'd'.repeat(40) }));
    f.pack();
    assert.throws(() => assertRedistributionReady(f.out, platform), /Archive identity differs/);
  },
);

test(
  'actual notice bytes must match even when every outer checksum is recomputed',
  { skip: !supported },
  (t) => {
    const f = fixture(t);
    f.put(f.policy.supplementalDocuments[0].path, 'altered fixture notice');
    f.pack();
    assert.throws(() => assertRedistributionReady(f.out, platform), /notice is missing or changed/);
  },
);

test(
  'sidecar runtime policy cannot differ from the independently inspected archive',
  { skip: !supported },
  (t) => {
    const f = fixture(t);
    f.pack();
    fs.writeFileSync(
      path.join(f.out, policyName(platform)),
      json({
        ...f.policy,
        standaloneServerSha256: 'e'.repeat(64),
      }),
    );
    f.refreshDistribution();
    assert.throws(() => assertRedistributionReady(f.out, platform), /Archive runtime differs/);
  },
);

test(
  'Linux archive traversal is rejected before extraction',
  { skip: platform !== 'linux-x64' },
  (t) => {
    const f = fixture(t);
    f.pack(['--transform=s,^,../,']);
    assert.throws(() => assertRedistributionReady(f.out, platform), /Unsafe archive member path/);
  },
);

for (const kind of ['symlink', 'hardlink']) {
  test(
    `Linux archive ${kind} members are rejected before extraction`,
    { skip: platform !== 'linux-x64' },
    (t) => {
      const f = fixture(t);
      const link = path.join(f.app, `unsafe-${kind}`);
      if (kind === 'symlink') fs.symlinkSync('../escaped', link);
      else fs.linkSync(path.join(f.app, 'LICENSE'), link);
      f.pack();
      assert.throws(
        () => assertRedistributionReady(f.out, platform),
        /only regular files and directories/,
      );
    },
  );
}

for (const [label, member, attributes] of [
  ['forward-slash traversal', '../escaped.txt', 0],
  ['backslash traversal', '..\\escaped.txt', 0],
  ['alternate data stream', 'payload.txt:stream', 0],
  ['DOS device name', 'CON.txt', 0],
  ['trailing-dot alias', 'directory./payload.txt', 0],
  ['Unix symlink attributes', 'unsafe-link', 0o120777 << 16],
  ['absolute local path', null, 0],
]) {
  test(
    `Windows ZIP rejects ${label} before extracting any entries`,
    { skip: platform !== 'win32-x64' },
    (t) => {
      const f = fixture(t);
      f.pack();
      f.appendZip(member ?? path.join(f.root, 'escaped.txt'), attributes);
      const destination = path.join(f.root, 'rejected-extraction');
      assert.throws(
        () => archiveTool('verify-extract', f.archive, destination),
        /Unsafe archive member/,
      );
      assert.equal(
        fs.existsSync(destination),
        false,
        'The complete ZIP is preflighted before extraction',
      );
      assert.equal(fs.existsSync(path.join(f.root, 'escaped.txt')), false);
      assert.throws(() => assertRedistributionReady(f.out, platform), /Unsafe archive member/);
    },
  );
}
