#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertExistingAncestors, privateDirectory, privateFile } from '../launcher.mjs';
import { acquireOperationLock } from './operation-lock.mjs';
import { restoreRuntimeLinks } from './restore-links.mjs';

function exists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
function readMetadata(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error('Installation metadata is invalid. Existing data was preserved.');
  }
}
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1)
    throw new Error('Invalid running-service metadata. Stop Examify before repairing it.');
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

/** Called only by the checksum-verified installer, using its verified temporary Node. */
export async function installRelease({ root, staged, version, prepare = restoreRuntimeLinks }) {
  root = path.resolve(root);
  staged = path.resolve(staged);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(version)) throw new Error('Invalid release version.');
  assertExistingAncestors(root);
  assertExistingAncestors(staged);
  if (
    !staged.startsWith(root + path.sep) ||
    !/^\.install\.[^/\\]+[/\\]app$/.test(path.relative(root, staged))
  )
    throw new Error('The verified package must be staged inside its installation folder.');
  const release = readMetadata(path.join(staged, 'desktop-release.json'));
  if (
    release.version !== version ||
    release.platform !== `${process.platform}-${process.arch}` ||
    release.nodeVersion !== process.versions.node
  )
    throw new Error('Wrong release/runtime.');
  const unlock = await acquireOperationLock({
    root,
    secureDirectory: privateDirectory,
    secureFile: privateFile,
  });
  try {
    const runningPath = path.join(root, 'running.json');
    if (exists(runningPath)) {
      privateFile(runningPath);
      if (alive(readMetadata(runningPath).pid))
        throw new Error(
          'Examify is running. Stop its launcher before reinstalling or repairing the app.',
        );
    }
    const marker = path.join(root, 'installation.json');
    if (exists(marker)) {
      privateFile(marker);
      const previous = readMetadata(marker);
      if (previous.app !== 'examify-solo' || previous.version !== version)
        throw new Error('Different or unknown installation. Automatic upgrades are not enabled.');
    }
    const releases = path.join(root, 'releases');
    assertExistingAncestors(releases);
    fs.mkdirSync(releases, { recursive: true, mode: 0o700 });
    const destination = path.join(releases, version);
    assertExistingAncestors(destination);
    const backup = path.join(releases, `.previous-${version}-${randomBytes(8).toString('hex')}`);
    // Prepare the complete new tree before exposing it at the live path. On
    // Windows, junctions are authored for that final path while staged.
    await prepare(staged, { installedRoot: destination });
    const temporaryMarker = path.join(root, `.installation-${randomBytes(8).toString('hex')}.json`);
    const needsMarker = !exists(marker);
    if (needsMarker)
      fs.writeFileSync(temporaryMarker, `${JSON.stringify({ app: 'examify-solo', version })}\n`, {
        mode: 0o600,
        flag: 'wx',
      });
    let movedOld = false;
    let movedNew = false;
    try {
      if (exists(destination)) {
        fs.renameSync(destination, backup);
        movedOld = true;
      }
      fs.renameSync(staged, destination);
      movedNew = true;
      if (needsMarker) fs.renameSync(temporaryMarker, marker);
    } catch (error) {
      // Put the previously usable app back before reporting failure. Data and
      // configuration are siblings of releases and are never moved or deleted.
      if (movedNew) fs.renameSync(destination, staged);
      if (movedOld) fs.renameSync(backup, destination);
      if (needsMarker) fs.rmSync(temporaryMarker, { force: true });
      throw error;
    }
    if (movedOld) fs.rmSync(backup, { recursive: true, force: true });
  } finally {
    unlock();
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await installRelease({
      root: process.argv[2],
      staged: process.argv[3],
      version: process.argv[4],
    });
  } catch (error) {
    console.error(
      error.message?.startsWith('Examify is running.')
        ? error.message
        : 'Could not safely install this release. Existing learner data was preserved.',
    );
    process.exitCode = 1;
  }
}
