/** Private immutable state generations. The installation pointer is the only commit record. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION = /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/;
export function validateInstallation(value) {
  if (
    !value ||
    value.app !== 'examify-solo' ||
    typeof value.version !== 'string' ||
    !VERSION.test(value.version)
  )
    throw new Error('Invalid installation metadata.');
  if (value.protocol !== undefined && value.protocol !== 1)
    throw new Error('Unsupported installation protocol.');
  if (value.protocol === 1) {
    if (
      value.release !== `releases/${value.version}-${String(value.release).split('-').at(-1)}` ||
      !/^[a-f0-9]{32}$/.test(String(value.release).split('-').at(-1))
    )
      throw new Error('Invalid release pointer.');
    if (
      value.state !== undefined &&
      (typeof value.state !== 'string' || !/^states\/[a-f0-9]{32}$/.test(value.state))
    )
      throw new Error('Invalid state pointer.');
  } else if (value.state !== undefined || value.release !== undefined) {
    throw new Error('Legacy installations cannot select state generations.');
  }
  if (value.initialized !== undefined && typeof value.initialized !== 'boolean')
    throw new Error('Invalid initialization marker.');
  return value;
}
export function readInstallation(root, secureFile) {
  const file = path.join(root, 'installation.json');
  try {
    secureFile(file);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  return validateInstallation(JSON.parse(fs.readFileSync(file, 'utf8')));
}
export const stateRoot = (root, marker) => (marker?.state ? path.join(root, marker.state) : root);
export const releaseRoot = (root, marker) =>
  path.join(root, marker.release ?? `releases/${marker.version}`);

export function assertUpgradeVersion(previous, next) {
  const parse = (value) => {
    const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
    if (!match) throw new Error('Cross-version upgrades require stable numeric release versions.');
    return match.slice(1).map(BigInt);
  };
  const a = parse(previous);
  const b = parse(next);
  for (let i = 0; i < 3; i += 1) {
    if (b[i] > a[i]) return;
    if (b[i] < a[i]) break;
  }
  throw new Error(
    'Downgrades are not supported. Restore a matched application and private backup separately.',
  );
}

export function syncDirectory(directory) {
  // Windows does not expose a portable directory FlushFileBuffers via Node.
  // Files are flushed and replace is atomic, but sudden storage/power loss is
  // not claimed recoverable there; never emulate replace with delete + rename.
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
export function durableJson(file, value) {
  const temporary = `${file}.${randomBytes(16).toString('hex')}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
  syncDirectory(path.dirname(file));
}

function inspect(file, directory) {
  const stat = fs.lstatSync(file);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error(
      'Unsafe file in private study state. Links and special files are not supported.',
    );
  return stat;
}
export function inventoryState(root) {
  if (process.platform === 'win32') {
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(path.dirname(fileURLToPath(import.meta.url)), 'inspect-state.ps1'),
        '-Path',
        root,
      ],
      { stdio: 'ignore', windowsHide: true, timeout: 120000 },
    );
    if (result.status !== 0)
      throw new Error(
        'Study state must be owned by this Windows user and contain no reparse points.',
      );
  }
  const entries = [];
  function visit(directory, relative) {
    inspect(directory, true);
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const rel = `${relative}/${name}`;
      const stat = fs.lstatSync(file);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        inspect(file, true);
        entries.push({ path: rel, directory: true });
        visit(file, rel);
      } else {
        inspect(file, false);
        entries.push({
          path: rel,
          bytes: stat.size,
          sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
        });
      }
    }
  }
  for (const name of ['data', 'config']) {
    const directory = path.join(root, name);
    try {
      fs.lstatSync(directory);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    entries.push({ path: name, directory: true });
    visit(directory, name);
  }
  return entries;
}
export function copyState(source, destination, entries, secureDirectory) {
  secureDirectory(destination);
  for (const item of entries) {
    const from = path.join(source, item.path);
    const to = path.join(destination, item.path);
    if (item.directory) {
      inspect(from, true);
      secureDirectory(to);
      continue;
    }
    inspect(from, false);
    const input = fs.openSync(from, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    let output;
    try {
      const stat = fs.fstatSync(input);
      if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid()))
        throw new Error('Unsafe source file.');
      output = fs.openSync(to, 'wx', 0o600);
      const hash = createHash('sha256');
      const buffer = Buffer.alloc(65536);
      let size = 0;
      let count;
      while ((count = fs.readSync(input, buffer, 0, buffer.length, null))) {
        hash.update(buffer.subarray(0, count));
        size += count;
        let offset = 0;
        while (offset < count) offset += fs.writeSync(output, buffer, offset, count - offset);
      }
      if (size !== item.bytes || hash.digest('hex') !== item.sha256)
        throw new Error('Study files changed during backup. Stop all Examify processes and retry.');
      fs.fsyncSync(output);
    } finally {
      fs.closeSync(input);
      if (output !== undefined) fs.closeSync(output);
    }
  }
  if (JSON.stringify(inventoryState(source)) !== JSON.stringify(entries))
    throw new Error('Study files changed during backup.');
  syncTree(destination);
}
export function syncTree(root) {
  for (const name of fs.readdirSync(root)) {
    const file = path.join(root, name);
    const stat = fs.lstatSync(file);
    if (stat.isDirectory() && !stat.isSymbolicLink()) syncTree(file);
    else {
      inspect(file, false);
      const fd = fs.openSync(file, process.platform === 'win32' ? 'r+' : 'r');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
  }
  syncDirectory(root);
}
export function requireSpace(root, entries) {
  const needed =
    entries.reduce((sum, item) => sum + BigInt(item.bytes ?? 0), 0n) * 2n + 128n * 1024n * 1024n;
  const stat = fs.statfsSync(root, { bigint: true });
  if (stat.bavail * stat.bsize < needed)
    throw new Error('Not enough free space for a private upgrade copy and migration reserve.');
}

export function syncRelease(root) {
  for (const name of fs.readdirSync(root)) {
    const file = path.join(root, name);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) continue; // Only verified package runtime links; do not follow.
    if (stat.isDirectory()) syncRelease(file);
    else {
      const fd = fs.openSync(file, process.platform === 'win32' ? 'r+' : 'r');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
  }
  syncDirectory(root);
}

export function assertStateComplete(root, marker) {
  const selected = stateRoot(root, marker);
  inspect(selected, true);
  if (marker?.state || marker?.initialized) {
    for (const name of ['data', 'config']) inspect(path.join(selected, name), true);
    for (const name of ['data/app.db', 'config/secrets.json'])
      inspect(path.join(selected, name), false);
  }
  return selected;
}
