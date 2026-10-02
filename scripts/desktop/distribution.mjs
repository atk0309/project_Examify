#!/usr/bin/env node
/** Offline integrity checks and candidate assembly. Never tags or publishes. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
// Hash the committed blob, not Windows' potentially CRLF-normalized checkout.
export function committedLockfileSha256(repository) {
  return createHash('sha256')
    .update(
      execFileSync('git', ['show', 'HEAD:pnpm-lock.yaml'], {
        cwd: repository,
        maxBuffer: 16 * 1024 * 1024,
      }),
    )
    .digest('hex');
}
export const platforms = ['linux-x64', 'win32-x64'];
export const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const manifestName = (platform) => `distribution-${platform}.json`;
export const policyName = (platform) => `runtime-policy-${platform}.json`;
export function assetNames(version, platform) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(version) || !platforms.includes(platform))
    throw new Error('Invalid distribution version or platform.');
  const archive = `examify-${version}-${platform}.${platform === 'win32-x64' ? 'zip' : 'tar.gz'}`;
  return [
    archive,
    `${archive}.sha256`,
    policyName(platform),
    ...(platform === 'win32-x64' ? ['install.cmd', 'install.ps1'] : ['install-solo.sh']),
  ].sort();
}
function regularFile(directory, name) {
  const file = path.join(directory, name);
  if (!fs.lstatSync(file).isFile()) throw new Error(`Asset must be a regular file: ${name}`);
  return file;
}
export function writeDistribution(directory, identity) {
  const assets = assetNames(identity.version, identity.platform).map((name) => ({
    name,
    bytes: fs.statSync(regularFile(directory, name)).size,
    sha256: digest(regularFile(directory, name)),
  }));
  fs.writeFileSync(
    path.join(directory, manifestName(identity.platform)),
    json({ schema: 1, ...identity, assets }),
  );
  const names = [...assets.map((asset) => asset.name), manifestName(identity.platform)].sort();
  fs.writeFileSync(
    path.join(directory, `SHA256SUMS-${identity.platform}`),
    names.map((name) => `${digest(regularFile(directory, name))}  ${name}\n`).join(''),
  );
  return verifyDistribution(directory, identity.platform);
}
function hasAssignment(script, pattern, expected) {
  const matches = script.split(/\r?\n/).filter((line) => pattern.test(line));
  return matches.length === 1 && matches[0] === expected;
}
export function verifyDistribution(directory, platform) {
  if (!platforms.includes(platform)) throw new Error('Unsupported distribution platform.');
  const manifest = JSON.parse(
    fs.readFileSync(regularFile(directory, manifestName(platform)), 'utf8'),
  );
  if (
    manifest.schema !== 1 ||
    manifest.upgradeProtocol !== 1 ||
    manifest.imageOptimization !== 'disabled' ||
    manifest.platform !== platform ||
    !/^[0-9a-f]{40}$/.test(manifest.sourceCommit) ||
    !/^[0-9a-f]{64}$/.test(manifest.lockfileSha256) ||
    !/^[0-9a-f]{64}$/.test(manifest.nodeArchiveSha256) ||
    typeof manifest.nodeVersion !== 'string' ||
    !/^22\.[0-9]+\.[0-9]+$/.test(manifest.nodeVersion) ||
    typeof manifest.localPreview !== 'boolean' ||
    typeof manifest.sourceDirty !== 'boolean'
  )
    throw new Error('Invalid distribution identity.');
  const names = assetNames(manifest.version, platform);
  if (
    !Array.isArray(manifest.assets) ||
    JSON.stringify(manifest.assets.map((asset) => asset.name)) !== JSON.stringify(names)
  )
    throw new Error('Incomplete or unexpected asset set.');
  const expected = [...names, manifestName(platform), `SHA256SUMS-${platform}`].sort();
  if (JSON.stringify(fs.readdirSync(directory).sort()) !== JSON.stringify(expected))
    throw new Error('Distribution directory contains missing or unexpected files.');
  for (const asset of manifest.assets)
    if (
      fs.statSync(regularFile(directory, asset.name)).size !== asset.bytes ||
      digest(regularFile(directory, asset.name)) !== asset.sha256
    )
      throw new Error(`Distribution checksum mismatch: ${asset.name}`);
  const sums = [...names, manifestName(platform)]
    .sort()
    .map((name) => `${digest(regularFile(directory, name))}  ${name}\n`)
    .join('');
  if (fs.readFileSync(regularFile(directory, `SHA256SUMS-${platform}`), 'utf8') !== sums)
    throw new Error('Distribution checksum list mismatch.');
  const archive = names.find((name) => /\.(zip|tar.gz)$/.test(name));
  const hash = digest(path.join(directory, archive));
  if (
    fs.readFileSync(path.join(directory, `${archive}.sha256`), 'utf8') !== `${hash}  ${archive}\n`
  )
    throw new Error('Archive checksum sidecar mismatch.');
  const installer = fs.readFileSync(
    path.join(directory, platform === 'win32-x64' ? 'install.ps1' : 'install-solo.sh'),
    'utf8',
  );
  if (
    !(platform === 'win32-x64'
      ? hasAssignment(installer, /^\s*\$Version\s*=/i, `$Version = '${manifest.version}'`) &&
        hasAssignment(installer, /^\s*\$Sha256\s*=/i, `$Sha256 = '${hash}'`)
      : hasAssignment(installer, /^\s*VERSION=/, `VERSION='${manifest.version}'`) &&
        hasAssignment(installer, /^\s*SHA256=/, `SHA256='${hash}'`)) ||
    /__EXAMIFY_/.test(installer)
  )
    throw new Error('Installer does not pin this version and archive.');
  if (platform === 'win32-x64') {
    const cmd = fs.readFileSync(path.join(directory, 'install.cmd'), 'utf8');
    if (
      !hasAssignment(
        cmd,
        /^\s*set "?EXAMIFY_INSTALL_VERSION=/i,
        `set "EXAMIFY_INSTALL_VERSION=${manifest.version}"`,
      ) ||
      !hasAssignment(
        cmd,
        /^\s*set "?EXAMIFY_INSTALL_PS_SHA256=/i,
        `set "EXAMIFY_INSTALL_PS_SHA256=${digest(path.join(directory, 'install.ps1'))}"`,
      ) ||
      /__EXAMIFY_/.test(cmd)
    )
      throw new Error('Command Prompt bootstrap does not pin this installer.');
  }
  return manifest;
}
export function assembleReleaseSet(input, output) {
  const manifests = platforms.map((platform) =>
    verifyDistribution(path.join(input, platform), platform),
  );
  const first = manifests[0];
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(first.version))
    throw new Error('An RC asset set requires the intended stable numeric release version.');
  for (const candidate of manifests)
    if (
      candidate.localPreview ||
      candidate.sourceDirty ||
      ['version', 'sourceCommit', 'lockfileSha256', 'nodeVersion'].some(
        (key) => candidate[key] !== first[key],
      )
    )
      throw new Error('RC assets must share one clean source, version, lockfile and Node version.');
  if (fs.existsSync(output))
    throw new Error('Use a new empty release-set destination; never overwrite candidate evidence.');
  fs.mkdirSync(output, { recursive: true });
  const assets = [];
  for (const platform of platforms)
    for (const name of fs.readdirSync(path.join(input, platform)).sort()) {
      fs.copyFileSync(
        regularFile(path.join(input, platform), name),
        path.join(output, name),
        fs.constants.COPYFILE_EXCL,
      );
      assets.push({
        name,
        bytes: fs.statSync(path.join(output, name)).size,
        sha256: digest(path.join(output, name)),
      });
    }
  assets.sort((a, b) => a.name.localeCompare(b.name));
  const record = {
    schema: 1,
    status: 'candidate-not-approved-for-publication',
    version: first.version,
    sourceCommit: first.sourceCommit,
    lockfileSha256: first.lockfileSha256,
    nodeVersion: first.nodeVersion,
    platforms,
    assets,
  };
  fs.writeFileSync(path.join(output, 'release-set.json'), json(record));
  fs.writeFileSync(
    path.join(output, 'SHA256SUMS'),
    [...assets.map((asset) => asset.name), 'release-set.json']
      .sort()
      .map((name) => `${digest(path.join(output, name))}  ${name}\n`)
      .join(''),
  );
  return record;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, input, output] = process.argv.slice(2);
  if (command === 'verify' && input && output)
    console.log(verifyDistribution(path.resolve(input), output));
  else if (command === 'assemble' && input && output)
    console.log(assembleReleaseSet(path.resolve(input), path.resolve(output)));
  else
    throw new Error(
      'Usage: distribution.mjs verify DIRECTORY PLATFORM | assemble INPUT_ROOT NEW_OUTPUT',
    );
}
