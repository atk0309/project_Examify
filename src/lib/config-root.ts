import { lstatSync, readFileSync, realpathSync, type Stats } from 'node:fs';
import path from 'node:path';
import { EXAMIFY_PACKAGE_NAME } from './repo-root';

// Neutral helper: both the Next server and examify-ingest read the same store.
// The launcher creates this directory; runtime code never creates or chmods it.
export const PROVIDER_ENV_FILES = ['.env', '.env.local'] as const;
/** Persistent provider choices only; runtime security and command paths stay separate. */
export const PROVIDER_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'EXAMIFY_ANTHROPIC_MODEL',
  'EXAMIFY_OPENAI_MODEL',
  'EXAMIFY_LLM_BASE_URL',
  'EXAMIFY_LLM_MODEL',
  'EXAMIFY_CLAUDE_MODEL',
  'EXAMIFY_CODEX_MODEL',
] as const;

export class UnsafeConfigDirError extends Error {
  readonly code = 'UNSAFE_CONFIG_DIR';

  constructor() {
    super('unsafe_config_dir');
    this.name = 'UnsafeConfigDirError';
  }
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

function optionalStat(target: string): Stats | undefined {
  try {
    return lstatSync(target);
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}

function contains(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function isCheckout(dir: string): boolean {
  const git = path.join(dir, '.git');
  const gitStat = optionalStat(git);
  if (
    gitStat &&
    (!gitStat.isDirectory() ||
      optionalStat(path.join(git, 'HEAD')) ||
      optionalStat(path.join(git, 'config')))
  ) {
    return true;
  }
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
      name?: string;
    };
    return pkg.name === EXAMIFY_PACKAGE_NAME;
  } catch (error) {
    if (error instanceof SyntaxError || isEnoent(error)) return false;
    throw error;
  }
}

function assertPrivateOwned(stat: Stats, platform: NodeJS.Platform): void {
  // Windows privacy is established by the launcher's user-only ACL. Node's
  // POSIX mode/uid fields cannot represent or verify a Windows ACL.
  if (platform === 'win32') return;
  if ((stat.mode & 0o077) !== 0) throw new UnsafeConfigDirError();
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new UnsafeConfigDirError();
  }
}

/**
 * Household settings keep their existing checkout-root location. Solo settings
 * live in an existing private absolute directory outside every checkout and
 * outside the versioned app. Refuse unsafe paths before any settings read/write;
 * errors intentionally expose neither filesystem paths nor credential values.
 */
export function resolveEnvStoreRoot(
  repoRoot: string,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.EXAMIFY_MODE !== 'solo') return repoRoot;
  try {
    const configured = env.EXAMIFY_CONFIG_DIR;
    if (!configured || !path.isAbsolute(configured) || /[\r\n\0]/.test(configured)) {
      throw new UnsafeConfigDirError();
    }
    const root = path.resolve(configured);
    const repo = realpathSync(repoRoot);
    if (contains(repo, root) || contains(root, repo)) throw new UnsafeConfigDirError();

    // Walk every existing component, not just the final directory: a symlinked
    // parent could otherwise redirect settings into an unrelated installation.
    let cursor = root;
    for (;;) {
      const stat = lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink() || isCheckout(cursor)) {
        throw new UnsafeConfigDirError();
      }
      if (cursor === root) assertPrivateOwned(stat, platform);
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    for (const name of PROVIDER_ENV_FILES) {
      const stat = optionalStat(path.join(/*turbopackIgnore: true*/ root, name));
      if (!stat) continue;
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw new UnsafeConfigDirError();
      }
      assertPrivateOwned(stat, platform);
    }
    return root;
  } catch {
    throw new UnsafeConfigDirError();
  }
}
