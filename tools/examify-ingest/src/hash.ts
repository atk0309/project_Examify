import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function sha256Bytes(bytes: Buffer | Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256File(absPath: string): string {
  return sha256Bytes(readFileSync(absPath));
}

/** Sort object keys so cache keys stay stable across insertion order. */
export function sortRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}
