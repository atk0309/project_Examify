#!/usr/bin/env node
/** Root-stable bootstrap. The v1 protocol and its copied runtime are immutable. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireOperationLock } from './operation-lock.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const runtimeName = process.platform === 'win32' ? 'node.exe' : 'node';
const bootstrapFiles = ['dispatch.mjs', 'operation-lock.mjs', 'private-path.ps1', runtimeName];
const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const releaseRuntime = process.platform === 'win32' ? 'runtime/node.exe' : 'runtime/bin/node';
const validVersion = (value) =>
  typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(value);
function exists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
function checkAncestors(directory) {
  let current = path.parse(path.resolve(directory)).root;
  for (const part of path
    .resolve(directory)
    .slice(current.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, part);
    if (!exists(current)) continue;
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe installation path.');
  }
}
function secureWindows(file) {
  if (process.platform !== 'win32') return;
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(here, 'private-path.ps1'),
      '-Path',
      file,
    ],
    { stdio: 'ignore', windowsHide: true, timeout: 15000 },
  );
  if (result.status !== 0) throw new Error('Could not secure private Examify bootstrap files.');
}
function secureDirectory(directory) {
  checkAncestors(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (process.getuid && stat.uid !== process.getuid())
    throw new Error('Installation belongs to another user.');
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
  else secureWindows(directory);
  return directory;
}
function secureFile(file) {
  checkAncestors(path.dirname(file));
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new Error('Unsafe bootstrap file.');
  if (process.getuid && stat.uid !== process.getuid())
    throw new Error('Installation belongs to another user.');
  if (process.platform !== 'win32' && stat.mode & 0o077)
    throw new Error('Bootstrap files must be private.');
  secureWindows(file);
}

function flushFile(file) {
  const descriptor = fs.openSync(file, process.platform === 'win32' ? 'r+' : 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}
function flushDirectory(directory) {
  if (process.platform !== 'win32') flushFile(directory);
}

/** Caller holds the root operation lock. Must run BEFORE release activation. */
export function installBootstrap({
  root,
  staged,
  secureDirectory: directory = secureDirectory,
  secureFile: file = secureFile,
}) {
  root = path.resolve(root);
  staged = path.resolve(staged);
  const parent = directory(path.join(root, 'bootstrap'));
  const destination = path.join(parent, 'v1');
  checkAncestors(destination);
  if (!exists(destination)) {
    const temporary = fs.mkdtempSync(path.join(parent, '.v1-'));
    try {
      for (const name of ['dispatch.mjs', 'operation-lock.mjs', 'private-path.ps1']) {
        const source = path.join(staged, 'scripts/desktop', name);
        checkAncestors(path.dirname(source));
        const stat = fs.lstatSync(source);
        if (!stat.isFile() || stat.isSymbolicLink())
          throw new Error('Incomplete bootstrap package.');
        fs.copyFileSync(source, path.join(temporary, name), fs.constants.COPYFILE_EXCL);
        fs.chmodSync(path.join(temporary, name), 0o600);
        flushFile(path.join(temporary, name));
      }
      const sourceNode = path.join(staged, releaseRuntime);
      checkAncestors(path.dirname(sourceNode));
      const stat = fs.lstatSync(sourceNode);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid bootstrap runtime.');
      fs.copyFileSync(sourceNode, path.join(temporary, runtimeName), fs.constants.COPYFILE_EXCL);
      fs.chmodSync(path.join(temporary, runtimeName), 0o700);
      flushFile(path.join(temporary, runtimeName));
      fs.writeFileSync(
        path.join(temporary, 'integrity.json'),
        JSON.stringify({
          protocol: 1,
          files: Object.fromEntries(
            bootstrapFiles.map((name) => [name, digest(path.join(temporary, name))]),
          ),
        }) + '\n',
        { mode: 0o600, flag: 'wx' },
      );
      flushFile(path.join(temporary, 'integrity.json'));
      flushDirectory(temporary);
      // An interrupted copy leaves only an unreferenced staging directory.
      fs.renameSync(temporary, destination);
      flushDirectory(parent);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
  directory(destination);
  // Never rewrite a running Windows executable, including during same-version repair.
  for (const name of [...bootstrapFiles, 'integrity.json']) file(path.join(destination, name));
  const integrity = JSON.parse(fs.readFileSync(path.join(destination, 'integrity.json'), 'utf8'));
  if (
    integrity?.protocol !== 1 ||
    !integrity.files ||
    bootstrapFiles.some((name) => integrity.files[name] !== digest(path.join(destination, name)))
  )
    throw new Error(
      'The stable Examify bootstrap is damaged. Existing installation was not activated.',
    );
  const entry = path.join(root, process.platform === 'win32' ? 'Examify.cmd' : 'Examify');
  if (exists(entry)) file(entry);
  const contents =
    process.platform === 'win32'
      ? '@echo off\r\nsetlocal\r\n"%~dp0bootstrap\\v1\\node.exe" "%~dp0bootstrap\\v1\\dispatch.mjs" %*\r\nif errorlevel 1 pause\r\n'
      : '#!/usr/bin/env bash\nset -euo pipefail\nROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec "$ROOT/bootstrap/v1/node" "$ROOT/bootstrap/v1/dispatch.mjs" "$@"\n';
  if (exists(entry) && fs.readFileSync(entry, 'utf8') === contents) return;
  const temporaryEntry = path.join(root, `.entry-${randomBytes(8).toString('hex')}`);
  try {
    fs.writeFileSync(temporaryEntry, contents, { mode: 0o700, flag: 'wx' });
    file(temporaryEntry);
    flushFile(temporaryEntry);
    fs.renameSync(temporaryEntry, entry);
    flushDirectory(root);
  } finally {
    fs.rmSync(temporaryEntry, { force: true });
  }
}

/** Read the single commit record while serialized with installation operations. */
export async function resolveLaunchTarget(root) {
  root = path.resolve(root);
  checkAncestors(root);
  const unlock = await acquireOperationLock({ root, secureDirectory, secureFile });
  try {
    const marker = path.join(root, 'installation.json');
    secureFile(marker);
    let value;
    try {
      value = JSON.parse(fs.readFileSync(marker, 'utf8'));
    } catch {
      throw new Error('Invalid installation metadata. Reinstall the verified release.');
    }
    if (
      !value ||
      value.app !== 'examify-solo' ||
      !validVersion(value.version) ||
      (value.state !== undefined &&
        (typeof value.state !== 'string' || !/^states\/[a-f0-9]{32}$/.test(value.state)))
    )
      throw new Error('Invalid installation metadata. Reinstall the verified release.');
    if (
      value.previous !== undefined &&
      (!value.previous ||
        !validVersion(value.previous.version) ||
        (value.previous.state !== undefined &&
          (typeof value.previous.state !== 'string' ||
            !/^states\/[a-f0-9]{32}$/.test(value.previous.state))))
    )
      throw new Error('Invalid previous installation metadata.');
    if (value.protocol !== undefined && value.protocol !== 1)
      throw new Error('Unsupported installation protocol.');
    const validRelease = (release, version) =>
      typeof release === 'string' &&
      release.startsWith(`releases/${version}-`) &&
      /^[a-f0-9]{32}$/.test(release.slice(`releases/${version}-`.length));
    if (value.protocol === 1 && !validRelease(value.release, value.version))
      throw new Error('Invalid active release path.');
    if (value.protocol === undefined && (value.release !== undefined || value.state !== undefined))
      throw new Error('Invalid legacy installation metadata.');
    if (
      value.previous?.release !== undefined &&
      !validRelease(value.previous.release, value.previous.version)
    )
      throw new Error('Invalid previous release path.');
    const appRoot = path.join(root, value.release ?? `releases/${value.version}`);
    checkAncestors(appRoot);
    const runtime = path.join(appRoot, releaseRuntime);
    const launcher = path.join(appRoot, 'scripts/launcher.mjs');
    // Release files need not be mode 0600; their root directory is private.
    for (const target of [runtime, launcher]) {
      checkAncestors(path.dirname(target));
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error('Active release is incomplete. Reinstall the verified release.');
    }
    return { version: value.version, appRoot, runtime, launcher };
  } finally {
    unlock();
  }
}

export async function dispatch({ root, args = [] }) {
  if (args.length) throw new Error('Usage: Examify');
  const target = await resolveLaunchTarget(root);
  // Release the operation lock first: launcher reacquires it and revalidates
  // that its app directory is still selected by installation.json.
  return await new Promise((resolve, reject) => {
    const child = spawn(target.runtime, [target.launcher, '--root', path.resolve(root)], {
      stdio: 'inherit',
      windowsHide: false,
    });
    const forward = (signal) => {
      if (!child.killed) child.kill(signal);
    };
    const onInterrupt = () => forward('SIGINT');
    const onTerminate = () => forward('SIGTERM');
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTerminate);
    const cleanup = () => {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
    };
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      cleanup();
      resolve(code ?? (signal === 'SIGINT' ? 130 : 1));
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await dispatch({
      root: path.resolve(here, '../..'),
      args: process.argv.slice(2),
    });
  } catch (error) {
    console.error(error.message || 'Examify could not start.');
    process.exitCode = 1;
  }
}
