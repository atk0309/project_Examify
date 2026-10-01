import fs from 'node:fs';
import path from 'node:path';

/** OS-released transaction lock; never opens or modifies a learner database. */
export async function acquireOperationLock({
  root,
  secureDirectory,
  secureFile,
  timeout = 120000,
  onContended = () => {},
}) {
  // The namespace is tied to the install root, never TEMP/TMP or shell env.
  // Keep this tiny coordination database outside learner data/config. Do not
  // unlink it after release: another process may already be waiting on it.
  const directory = secureDirectory(path.join(path.resolve(root), '.examify-operations'));
  const file = path.join(directory, 'lock.sqlite');
  try {
    fs.closeSync(fs.openSync(file, 'wx', 0o600));
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  secureFile(file);
  // Available in the exact bundled Node 22.22.2 runtime, on both supported OSes.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 100');
  const started = Date.now();
  let reportedContention = false;
  try {
    while (true) {
      try {
        db.exec('BEGIN EXCLUSIVE');
        break;
      } catch (error) {
        if (error.errcode !== 5 && error.errcode !== 6) throw error;
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
