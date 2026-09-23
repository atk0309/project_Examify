import path from 'node:path';
import { parseEnvFile, readEnvFile } from '../../../src/lib/env-file';

export { parseEnvFile };

const ENV_FILES = ['.env', '.env.local'] as const;

/**
 * Fill unset keys from repo `.env` then `.env.local`.
 * Keys already present on `env` (including empty string) are left alone.
 */
export function mergeRepoEnvFiles(
  repoRoot: string,
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const fromFiles: Record<string, string> = {};
  for (const name of ENV_FILES) {
    Object.assign(fromFiles, readEnvFile(path.join(repoRoot, name)));
  }
  const out: Record<string, string | undefined> = { ...env };
  for (const [key, value] of Object.entries(fromFiles)) {
    if (out[key] === undefined) out[key] = value;
  }
  return out;
}
