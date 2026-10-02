#!/usr/bin/env node
/** Technical redistribution evidence; not a complete SBOM or legal certification. */
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertReleaseInventory } from './inventory.mjs';
import { digest, policyName, verifyDistribution } from './distribution.mjs';
import { loadSupplementalNotices } from './supplemental-licenses.mjs';
const excludedName = (name) => name === 'sharp' || name.startsWith('@img/');
const excludedPath = (name) =>
  /(?:^|\/)node_modules\/(?:sharp|@img)(?:\/|$)|(?:^|\/)\.pnpm\/(?:sharp@|@img\+)/.test(name);
export function standaloneConfig(app) {
  const source = fs.readFileSync(path.join(app, 'server.js'), 'utf8');
  const matches = [...source.matchAll(/^const nextConfig = (\{.*\});?\s*$/gm)];
  if (matches.length !== 1)
    throw new Error('Cannot verify the serialized standalone configuration.');
  return JSON.parse(matches[0][1]);
}
export function createRuntimePolicy(app, identity, licenses) {
  if (standaloneConfig(app).images?.unoptimized !== true)
    throw new Error(
      'Portable image optimization must be disabled in the actual standalone server.',
    );
  const files = assertReleaseInventory(app);
  if (files.some(excludedPath))
    throw new Error('Unused native image packages remain in the portable runtime.');
  const links = JSON.parse(fs.readFileSync(path.join(app, 'runtime-links.json'), 'utf8'));
  if (
    !Array.isArray(links) ||
    links.some((link) => excludedPath(link.path) || excludedPath(link.target))
  )
    throw new Error('Portable runtime links still reference excluded image packages.');
  const packages = licenses.packages.map(({ name, version }) => ({ name, version }));
  if (packages.some((pkg) => excludedName(pkg.name)))
    throw new Error('Native image package remains in the license inventory.');
  const nativeBinaries = files.filter((file) =>
    /\.(?:node|so(?:\.[0-9]+)*|dll|dylib)$/i.test(file),
  );
  if (
    !nativeBinaries.length ||
    nativeBinaries.some(
      (file) => !file.endsWith('.node') || !/\/node_modules\/better-sqlite3\//.test(`/${file}`),
    )
  )
    throw new Error('Unreviewed bundled native library; redistribution evidence must be updated.');
  const expectedNotices = loadSupplementalNotices(packages).documents;
  for (const document of expectedNotices)
    if (digest(path.join(app, document.path)) !== document.sha256)
      throw new Error('Required supplemental notice is missing or changed.');
  for (const file of ['LICENSE', 'runtime/LICENSE'])
    if (!fs.readFileSync(path.join(app, file), 'utf8').trim())
      throw new Error('Application/runtime license is missing.');
  const policy = {
    schema: 1,
    policy: 'portable-without-image-optimizer-v1',
    version: identity.version,
    platform: identity.platform,
    sourceCommit: identity.sourceCommit,
    imageOptimization: 'disabled',
    standaloneServerSha256: digest(path.join(app, 'server.js')),
    packages,
    nativeBinaries,
    supplementalDocuments: expectedNotices.map(({ path: noticePath, sha256 }) => ({
      path: noticePath,
      sha256,
    })),
    licenseInventorySha256: digest(path.join(app, 'THIRD-PARTY-LICENSES.json')),
    reviewWarnings: licenses.warnings,
    scope:
      'Verifies the approved unused image-library exclusion and known notice fixes. Not publisher identity, a complete SBOM, or legal certification.',
  };
  validateRuntimePolicy(policy, identity);
  return policy;
}
export function validateRuntimePolicy(policy, identity) {
  if (
    policy.schema !== 1 ||
    policy.policy !== 'portable-without-image-optimizer-v1' ||
    policy.imageOptimization !== 'disabled' ||
    ['version', 'platform', 'sourceCommit'].some((field) => policy[field] !== identity[field]) ||
    !/^[a-f0-9]{64}$/.test(policy.standaloneServerSha256) ||
    !/^[a-f0-9]{64}$/.test(policy.licenseInventorySha256)
  )
    throw new Error('Missing or mismatched portable-runtime policy evidence.');
  if (
    !Array.isArray(policy.packages) ||
    policy.packages.some(
      (pkg) =>
        typeof pkg.name !== 'string' || typeof pkg.version !== 'string' || excludedName(pkg.name),
    ) ||
    !policy.packages.some((pkg) => pkg.name === 'better-sqlite3' && pkg.version === '13.0.3') ||
    !policy.packages.some((pkg) => pkg.name === '@next/env' && pkg.version === '16.3.6')
  )
    throw new Error('Unreviewed runtime package identities.');
  if (
    !Array.isArray(policy.nativeBinaries) ||
    !policy.nativeBinaries.length ||
    policy.nativeBinaries.some(
      (file) =>
        typeof file !== 'string' ||
        !file.endsWith('.node') ||
        !/\/node_modules\/better-sqlite3\//.test(`/${file}`) ||
        file.split('/').includes('..'),
    )
  )
    throw new Error('Unreviewed bundled native library.');
  const expected = loadSupplementalNotices(policy.packages).documents.map(
    ({ path: noticePath, sha256 }) => ({ path: noticePath, sha256 }),
  );
  if (JSON.stringify(policy.supplementalDocuments) !== JSON.stringify(expected))
    throw new Error('Exact required notice evidence is incomplete.');
}
export function assertRedistributionReady(directory, platform) {
  const distribution = verifyDistribution(directory, platform);
  if (distribution.localPreview || distribution.sourceDirty)
    throw new Error('Dirty/local preview artifacts are not eligible for distribution.');
  const policy = JSON.parse(fs.readFileSync(path.join(directory, policyName(platform)), 'utf8'));
  validateRuntimePolicy(policy, distribution);
  const archive = distribution.assets.find((asset) => /\.(zip|tar.gz)$/.test(asset.name));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-archive-policy-'));
  try {
    const source = path.join(directory, archive.name);
    if (platform === 'win32-x64') {
      if (process.platform !== 'win32')
        throw new Error('Verify Windows archive evidence on native Windows.');
      execFileSync(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-File',
          path.join(import.meta.dirname, 'archive.ps1'),
          '-Operation',
          'verify-extract',
          '-Source',
          source,
          '-Destination',
          path.join(temporary, 'app'),
        ],
        { stdio: 'pipe' },
      );
    } else {
      if (process.platform !== 'linux')
        throw new Error('Verify Linux archive evidence on native Linux.');
      const entries = execFileSync('tar', ['-tzf', source], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      })
        .trim()
        .split('\n');
      if (
        entries.some(
          (name) =>
            name.startsWith('/') || /[\\\r\x00-\x1f]/.test(name) || name.split('/').includes('..'),
        )
      )
        throw new Error('Unsafe archive member path.');
      const modes = execFileSync('tar', ['-tvzf', source], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      })
        .trim()
        .split('\n');
      if (modes.some((line) => !/^[-d]/.test(line)))
        throw new Error('Archive may contain only regular files and directories.');
      fs.mkdirSync(path.join(temporary, 'app'));
      execFileSync('tar', ['-xzf', source, '-C', path.join(temporary, 'app'), '--no-same-owner'], {
        stdio: 'pipe',
      });
    }
    const app = path.join(temporary, 'app');
    const actualIdentity = JSON.parse(
      fs.readFileSync(path.join(app, 'desktop-release.json'), 'utf8'),
    );
    for (const field of [
      'version',
      'platform',
      'sourceCommit',
      'lockfileSha256',
      'nodeVersion',
      'nodeArchiveSha256',
      'localPreview',
      'sourceDirty',
      'upgradeProtocol',
      'imageOptimization',
    ])
      if (actualIdentity[field] !== distribution[field])
        throw new Error('Archive identity differs from distribution.');
    const retained = JSON.parse(
      fs.readFileSync(path.join(app, 'desktop-runtime-policy.json'), 'utf8'),
    );
    const licenses = JSON.parse(
      fs.readFileSync(path.join(app, 'THIRD-PARTY-LICENSES.json'), 'utf8'),
    );
    const actual = createRuntimePolicy(app, actualIdentity, licenses);
    if (
      JSON.stringify(retained) !== JSON.stringify(policy) ||
      JSON.stringify(actual) !== JSON.stringify(policy)
    )
      throw new Error('Archive runtime differs from the recorded policy.');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  return policy;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, directory, platform] = process.argv.slice(2);
  if (command !== 'check' || !directory || !platform)
    throw new Error('Usage: distribution-policy.mjs check DIRECTORY PLATFORM');
  try {
    assertRedistributionReady(path.resolve(directory), platform);
    console.log(
      'Portable exclusion and required notice evidence verified; publication remains separately approved.',
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
