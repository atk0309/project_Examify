import { readFileSync } from 'node:fs';
import path from 'node:path';

const ENV_FILES = ['.env', '.env.local'] as const;

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/** Strip an unquoted ` # comment`, then unwrap matching quotes (Next.js / dotenv). */
function parseEnvAssignmentValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const start = trimmed[0];
    const end = trimmed[trimmed.length - 1];
    if ((start === '"' && end === '"') || (start === "'" && end === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  const uncommented = trimmed.replace(/\s+#.*$/, '').trim();
  if (uncommented.length >= 2) {
    const start = uncommented[0];
    const end = uncommented[uncommented.length - 1];
    if ((start === '"' && end === '"') || (start === "'" && end === "'")) {
      return uncommented.slice(1, -1);
    }
  }
  return uncommented;
}

/** Parse KEY=VALUE lines. Existing process env must win; this never logs values. */
export function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out[key] = parseEnvAssignmentValue(body.slice(eq + 1));
  }
  return out;
}

function readEnvFile(absPath: string): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(absPath, 'utf8'));
  } catch (error) {
    if (isEnoent(error)) return {};
    throw error;
  }
}

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
