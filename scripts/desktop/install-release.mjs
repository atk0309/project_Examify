#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertExistingAncestors, privateDirectory, privateFile } from '../launcher.mjs';
import {
  acquireOperationLock,
  tryAcquireInstanceLock,
  tryAcquireWorkerLock,
} from './operation-lock.mjs';
import { restoreRuntimeLinks } from './restore-links.mjs';
import { installBootstrap } from './dispatch.mjs';
import { probeRelease } from './upgrade-probe.mjs';
import {
  readInstallation,
  assertStateComplete,
  inventoryState,
  copyState,
  requireSpace,
  assertUpgradeVersion,
  durableJson,
  syncTree,
  syncRelease,
  syncDirectory,
} from './state-store.mjs';

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

/** Called only by the checksum-verified installer, using its verified temporary Node. */
export async function installRelease({
  root,
  staged,
  version,
  prepare = restoreRuntimeLinks,
  probe = probeRelease,
  bootstrap = installBootstrap,
  onPhase = () => {},
  helperOptions = {},
}) {
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
  // Imported modules keep their original URLs after staging is renamed. Keep
  // helper lookup local to this transaction, and rebase it with the app tree.
  // Tests importing checkout code may stage only metadata, so their helpers
  // deliberately remain beside the imported installer.
  let helperDirectory = path.dirname(fileURLToPath(import.meta.url));
  const helperRelative = path.relative(staged, helperDirectory);
  const helpersAreStaged =
    helperRelative !== '..' &&
    !helperRelative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(helperRelative);
  const options = () => ({ ...helperOptions, helperDirectory });
  const secureDirectory = (dir) => privateDirectory(dir, options());
  const secureFile = (file) => privateFile(file, options());
  const unlock = await acquireOperationLock({
    root,
    secureDirectory,
    secureFile,
  });
  let releaseInstance;
  let releaseWorker;
  try {
    releaseInstance = await tryAcquireInstanceLock({
      root,
      secureDirectory,
      secureFile,
    });
    if (!releaseInstance)
      throw new Error(
        'Examify is running. Stop its launcher before reinstalling or repairing the app.',
      );
    const runningPath = path.join(root, 'running.json');
    if (exists(runningPath)) {
      secureFile(runningPath);
      // Marker PIDs are diagnostic only: they can be reused after a crash.
    }
    releaseWorker = await tryAcquireWorkerLock({
      root,
      secureDirectory,
      secureFile,
    });
    if (!releaseWorker)
      throw new Error('Examify is running. A database worker is still stopping; retry shortly.');
    const marker = path.join(root, 'installation.json');
    const previous = readInstallation(root, secureFile);
    if (previous && previous.version !== version) {
      if (previous.protocol !== 1 || release.upgradeProtocol !== 1)
        throw new Error(
          'This preview installation cannot be upgraded in place. Keep it and install into a separate empty folder.',
        );
      assertUpgradeVersion(previous.version, version);
    }
    if (!previous || previous.protocol === 1) {
      if (release.upgradeProtocol !== 1)
        throw new Error('The package does not support safe activation.');
      const releases = secureDirectory(path.join(root, 'releases'));
      const releaseId = `${version}-${randomBytes(16).toString('hex')}`;
      const destination = path.join(releases, releaseId);
      await prepare(staged, { installedRoot: destination });
      await bootstrap({ root, staged, secureDirectory, secureFile });
      fs.renameSync(staged, destination);
      if (helpersAreStaged) helperDirectory = path.join(destination, helperRelative);
      // Application links are package-verified and may be junctions. fsync each
      // regular file without following them; the package was staged privately.
      syncRelease(destination);
      syncDirectory(releases);
      let state;
      let candidate;
      if (previous) {
        const source = assertStateComplete(root, previous);
        assertExistingAncestors(source);
        const entries = inventoryState(source, options());
        requireSpace(root, entries);
        const states = secureDirectory(path.join(root, 'states'));
        state = `states/${randomBytes(16).toString('hex')}`;
        candidate = path.join(root, state);
        copyState(source, candidate, entries, secureDirectory, options());
        durableJson(path.join(candidate, 'backup-source.json'), {
          installation: previous,
          files: entries,
        });
        onPhase('state-copied');
        await probe({
          root: candidate,
          appDir: destination,
          node: path.join(
            destination,
            'runtime',
            process.platform === 'win32' ? 'node.exe' : 'bin/node',
          ),
        });
        const lockOptions = {
          root: candidate,
          secureDirectory,
          secureFile,
        };
        const candidateInstance = await tryAcquireInstanceLock(lockOptions);
        if (!candidateInstance) throw new Error('Upgrade verification has not stopped.');
        let candidateWorker;
        try {
          candidateWorker = await tryAcquireWorkerLock(lockOptions);
          if (!candidateWorker) throw new Error('Upgrade database verification has not stopped.');
          assertStateComplete(candidate, { initialized: true });
          inventoryState(candidate, options()); // Revalidate migrated files and config.
          syncTree(candidate);
          syncDirectory(states);
        } finally {
          candidateWorker?.();
          candidateInstance();
        }
      }
      const next = {
        app: 'examify-solo',
        protocol: 1,
        version,
        release: `releases/${releaseId}`,
        ...(state ? { state } : {}),
        ...(previous
          ? {
              previous: {
                app: previous.app,
                protocol: previous.protocol,
                version: previous.version,
                initialized: previous.initialized,
                release: previous.release,
                ...(previous.state ? { state: previous.state } : {}),
              },
            }
          : {}),
      };
      onPhase('before-activate');
      durableJson(marker, next);
      // After this point never auto-rollback: a fresh launch may save new work.
      onPhase('activated');
      return next;
    }
    // Legacy same-version repair stays a legacy installation. It never gains
    // an upgrade protocol or state pointer merely by replacing its app files.
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
    await bootstrap({ root, staged, secureDirectory, secureFile });
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
    releaseWorker?.();
    releaseInstance?.();
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
