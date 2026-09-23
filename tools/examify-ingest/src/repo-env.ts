import path from 'node:path';
import { parseEnvFile, readEnvFile } from '../../../src/lib/env-file';

export { parseEnvFile };

const ENV_FILES = ['.env', '.env.local'] as const;

/**
 * Fill unset keys from repo `.env` then `.env.local`.
 * Keys already present on `env` (including empty string) are left alone.
 * On Windows, env names are case-insensitive, so every name is folded to
 * upper case (`Path` → `PATH`, `Examify_Codex_Bin` → `EXAMIFY_CODEX_BIN`) with
 * the same precedence: `env` wins over the files whatever either one's
 * spelling. Every exact-key lookup downstream then sees one value per name.
 */
export function mergeRepoEnvFiles(
  repoRoot: string,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string | undefined> {
  const fromFiles: Record<string, string> = {};
  for (const name of ENV_FILES) {
    Object.assign(fromFiles, readEnvFile(path.join(repoRoot, name)));
  }
  const fold = platform === 'win32' ? (key: string) => key.toUpperCase() : (key: string) => key;
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    const name = fold(key);
    if (value !== undefined && out[name] === undefined) out[name] = value;
  }
  for (const [key, value] of Object.entries(fromFiles)) {
    const name = fold(key);
    if (out[name] === undefined) out[name] = value;
  }
  return out;
}
