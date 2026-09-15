import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

/** Write `body` via a sibling temp file, then rename over `absPath`. */
export function writeFileAtomic(absPath: string, body: string): void {
  const dir = path.dirname(absPath);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(absPath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, absPath);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file may already be gone if rename succeeded then a later step failed.
    }
    throw error;
  }
}
