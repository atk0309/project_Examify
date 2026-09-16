import { readFileSync } from 'node:fs';
import path from 'node:path';

const ENV_FILES = ['.env', '.env.local'] as const;

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function isWrappedInQuotes(value: string): boolean {
  if (value.length < 2) return false;
  const start = value[0];
  const end = value[value.length - 1];
  return (start === '"' && end === '"') || (start === "'" && end === "'");
}

/** Next.js / dotenv: unquoted comment starts at `#` after whitespace. Linear scan (no ReDoS). */
function stripUnquotedInlineComment(value: string): string {
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== '#') continue;
    if (i === 0) return '';
    const prev = value.charCodeAt(i - 1);
    if (prev === 32 || prev === 9 || prev === 11 || prev === 12 || prev === 13) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value;
}

/** Strip an unquoted ` # comment`, then unwrap matching quotes (Next.js / dotenv). */
function parseEnvAssignmentValue(raw: string): string {
  const trimmed = raw.trim();
  if (isWrappedInQuotes(trimmed)) return trimmed.slice(1, -1);
  const uncommented = stripUnquotedInlineComment(trimmed);
  if (isWrappedInQuotes(uncommented)) return uncommented.slice(1, -1);
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
