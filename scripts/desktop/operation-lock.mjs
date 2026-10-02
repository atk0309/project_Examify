import fs from 'node:fs';
import path from 'node:path';

/** OS-released transaction locks; never open or modify a learner database. */
async function acquireLock(
  { root, secureDirectory, secureFile, timeout = 120000, onContended = () => {} },
  name,
  wait,
) {
  // The namespace is tied to the install root, never TEMP/TMP or shell env.
  // Keep this tiny coordination database outside learner data/config. Do not
  // unlink it after release: another process may already be waiting on it.
  const directory = secureDirectory(path.join(path.resolve(root), '.examify-operations'));
  const file = path.join(directory, name);
  try {
    fs.closeSync(fs.openSync(file, 'wx', 0o600));
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  secureFile(file);
  // Available in the exact bundled Node 22.22.2 runtime, on both supported OSes.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout = ${wait ? 100 : 0}`);
  const started = Date.now();
  let reportedContention = false;
  try {
    while (true) {
      try {
        db.exec('BEGIN EXCLUSIVE');
        break;
      } catch (error) {
        if (error.errcode !== 5 && error.errcode !== 6) throw error;
        if (!wait) {
          db.close();
          return null;
        }
        if (!reportedContention) {
          onContended();
          reportedContention = true;
        }
        if (Date.now() - started >= timeout)
          throw new Error(
            'Another Examify operation is still running. Wait for it to finish and try again.',
          );
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  } catch (error) {
    db.close();
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      db.exec('ROLLBACK');
    } finally {
      db.close();
    }
  };
}

/** Serialize launcher startup and repair, waiting for another operation to finish. */
export function acquireOperationLock(options) {
  return acquireLock(options, 'lock.sqlite', true);
}

/** Try once; null means a live instance still owns this install root. */
export function tryAcquireInstanceLock(options) {
  return acquireLock(options, 'instance.sqlite', false);
}

/** Independent child lifetime lease, including migrations and orphaned servers. */
export function tryAcquireWorkerLock(options) {
  return acquireLock(options, 'worker.sqlite', false);
}
