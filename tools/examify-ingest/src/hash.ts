import { createHash } from 'node:crypto';

export function sha256Bytes(bytes: Buffer | Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Code-unit order so cache keys stay stable across host locales. */
export function compareCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sort object keys so cache keys stay stable across insertion order. */
export function sortRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => compareCodeUnit(a, b)));
}
