// Acquire before settings, application modules or learner databases are opened.
// The OS releases this transaction even when the supervisor/worker is killed.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

function requireSupervisor() {
  const parent = Number(process.env.EXAMIFY_LAUNCHER_PID);
  if (!process.connected || !Number.isSafeInteger(parent) || parent <= 0 || parent !== process.ppid)
    throw new Error('The solo worker requires its connected launcher.');
}

function privatePath(file, directory) {
  const stat = fs.lstatSync(file);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
  )
    throw new Error('Unsafe solo worker lock path.');
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
        path.join(__dirname, 'private-path.ps1'),
        '-Path',
        file,
      ],
      { stdio: 'ignore', windowsHide: true, timeout: 15000 },
    );
    if (result.status !== 0) throw new Error('Could not secure private solo worker files.');
  } else if (stat.uid !== process.getuid() || stat.mode & 0o077) {
    throw new Error('Solo worker lock paths must be private to their owner.');
  }
}

requireSupervisor();
process.once('disconnect', () => process.exit(0));
const root = process.env.EXAMIFY_INSTALL_ROOT;
if (process.env.EXAMIFY_MODE !== 'solo' || !root || !path.isAbsolute(root))
  throw new Error('The solo worker requires its stable installation root.');
// Inspect every ancestor before opening the lock; never follow a symlink into
// another installation, even when candidate data/config live in another root.
let current = path.parse(root).root;
for (const part of path.resolve(root).slice(current.length).split(path.sep).filter(Boolean)) {
  current = path.join(current, part);
  const stat = fs.lstatSync(current);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error('Unsafe solo worker installation path.');
}
privatePath(root, true);
const directory = path.join(root, '.examify-operations');
try {
  fs.mkdirSync(directory, { mode: 0o700 });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
}
privatePath(directory, true);
const file = path.join(directory, 'worker.sqlite');
try {
  fs.closeSync(fs.openSync(file, 'wx', 0o600));
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
}
privatePath(file, false);
const database = new DatabaseSync(file);
try {
  database.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE');
  requireSupervisor();
} catch {
  database.close();
  throw new Error('Another solo worker is active or its launcher has disconnected.');
}
// Retain the connection for the whole process lifetime. Never release on an
// ordinary event or unlink the lock file: either can admit a concurrent writer.
module.exports = { requireSupervisor, database };
