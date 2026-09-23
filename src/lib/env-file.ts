import { readFileSync } from 'node:fs';
import path from 'node:path';

// Relative imports only: `tools/examify-ingest`, `db:migrate` (tsx) and
// drizzle-kit load this without the `@/` alias.

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

/** Parse KEY=VALUE lines. Never logs values. */
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

/** Parse one env file; a missing file is `{}`, any other read error throws. */
export function readEnvFile(absPath: string): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(absPath, 'utf8'));
  } catch (error) {
    if (isEnoent(error)) return {};
    throw error;
  }
}

/**
 * The files `next start` loads, highest precedence first (`@next/env`,
 * production mode). `next dev` swaps `production` for `development`.
 */
export const PRODUCTION_ENV_FILES = [
  '.env.production.local',
  '.env.local',
  '.env.production',
  '.env',
] as const;

/**
 * One key as `next start` would see it from the repo env files: the
 * highest-precedence file that **defines** the key wins, even with an empty
 * value (so `.env.local` `KEY=` hides `.env` `KEY=x`, exactly like Next).
 * `undefined` when no file defines it.
 */
export function envFileValue(
  files: ReadonlyArray<Record<string, string>>,
  key: string,
): string | undefined {
  for (const file of files) {
    if (Object.prototype.hasOwnProperty.call(file, key)) return file[key];
  }
  return undefined;
}

/** Read the production env files of a checkout, highest precedence first. */
export function readProductionEnvFiles(repoRoot: string): Array<Record<string, string>> {
  return PRODUCTION_ENV_FILES.map((name) =>
    readEnvFile(path.join(/*turbopackIgnore: true*/ repoRoot, name)),
  );
}
