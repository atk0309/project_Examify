import path from 'node:path';
import {
  PROVIDER_ENV_FILES,
  PROVIDER_ENV_KEYS,
  resolveEnvStoreRoot,
} from '../../../src/lib/config-root';
import { parseEnvFile, readEnvFile } from '../../../src/lib/env-file';

export { parseEnvFile };

/**
 * Fill unset keys from the installation `.env` then `.env.local`: the checkout
 * for households, the launcher's persistent config directory for solo mode.
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
  const folded = foldEnvNames(env, platform);
  return mergeResolvedEnvStoreFiles(
    resolveEnvStoreRoot(repoRoot, folded, platform),
    folded,
    platform,
  );
}

function foldEnvNames(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): Record<string, string | undefined> {
  const fold = platform === 'win32' ? (key: string) => key.toUpperCase() : (key: string) => key;
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    const name = fold(key);
    if (value !== undefined && out[name] === undefined) out[name] = value;
  }
  return out;
}

/**
 * Merge a store already resolved and validated by getEnvStoreRoot (runtime)
 * or resolveEnvStoreRoot (CLI). The config directory is not a checkout root:
 * resolving it a second time would reject a valid solo installation. Keeping
 * this entry point explicit also preserves disposable runtime test overrides.
 */
export function mergeResolvedEnvStoreFiles(
  settingsRoot: string,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string | undefined> {
  const fold = platform === 'win32' ? (key: string) => key.toUpperCase() : (key: string) => key;
  const out = foldEnvNames(env, platform);
  // Folded as each file is read, so `.env.local` overrides `.env` whatever
  // either one's spelling.
  const fromFiles: Record<string, string> = {};
  for (const name of PROVIDER_ENV_FILES) {
    for (const [key, value] of Object.entries(readEnvFile(path.join(settingsRoot, name)))) {
      const name = fold(key);
      if (out.EXAMIFY_MODE === 'solo' && !(PROVIDER_ENV_KEYS as readonly string[]).includes(name)) {
        continue;
      }
      fromFiles[name] = value;
    }
  }
  for (const [name, value] of Object.entries(fromFiles)) {
    if (out[name] === undefined) out[name] = value;
  }
  return out;
}
