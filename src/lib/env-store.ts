import 'server-only';

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { findRepoRoot } from '@/lib/repo-root';

/** Keys the wizard / install twin may write. Never NEXT_PUBLIC_*. */
export const ENV_STORE_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] as const;
export type EnvStoreKey = (typeof ENV_STORE_KEYS)[number];

export const OPENAI_ENV_KEY = 'OPENAI_API_KEY' satisfies EnvStoreKey;
export const ANTHROPIC_ENV_KEY = 'ANTHROPIC_API_KEY' satisfies EnvStoreKey;

const ENV_FILES = ['.env', '.env.local'] as const;
const PRIMARY_ENV_FILE = '.env';
const MAX_SECRET_CHARS = 256;

let envStoreRootOverride: string | null = null;

/** Tests only — point `.env` writes at a temp tree. */
export function setEnvStoreRootForTests(root: string | null): void {
  envStoreRootOverride = root;
}

export function getEnvStoreRoot(): string {
  // Same walker as content I/O and examify-ingest generate — never bare cwd.
  return envStoreRootOverride ?? findRepoRoot(process.cwd());
}

function envStorePath(root: string, name: string): string {
  return path.join(/*turbopackIgnore: true*/ root, name);
}

export function isEnvStoreKey(value: string): value is EnvStoreKey {
  return (ENV_STORE_KEYS as readonly string[]).includes(value);
}

/** Same rule as the wizard “configured?” badges — empty / `test` are not usable. */
export function isUsableEnvSecret(value: string | undefined): boolean {
  const trimmed = value?.trim() ?? '';
  return trimmed !== '' && trimmed !== 'test';
}

export type EnvSecretWriteError = { ok: false; reason: 'invalid' | 'disk' };
export type EnvSecretWriteSuccess = { ok: true };

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function isKeyAssignment(line: string, key: string): boolean {
  const body = line.trim();
  if (!body || body.startsWith('#')) return false;
  const rest = body.startsWith('export ') ? body.slice(7).trim() : body;
  const eq = rest.indexOf('=');
  if (eq <= 0) return false;
  return rest.slice(0, eq).trim() === key;
}

function formatEnvValue(value: string): string {
  if (/[\s#"']/.test(value)) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return value;
}

function writeEnvFileAtomic(absPath: string, body: string): void {
  const dir = path.dirname(absPath);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(absPath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, absPath);
    chmodSync(absPath, 0o600);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Temp may already be gone if rename succeeded then chmod failed.
    }
    throw error;
  }
}

function applyEnvKeyLine(contents: string, key: string, value: string | null): string {
  const lines = contents.length > 0 ? contents.split(/\r?\n/) : [];
  const next: string[] = [];
  let found = false;
  for (const line of lines) {
    if (isKeyAssignment(line, key)) {
      found = true;
      if (value !== null) next.push(`${key}=${formatEnvValue(value)}`);
      continue;
    }
    next.push(line);
  }
  if (!found && value !== null) {
    while (next.length > 0 && next[next.length - 1] === '') next.pop();
    next.push(`${key}=${formatEnvValue(value)}`);
  }
  const body = next.join('\n');
  if (body.length === 0) return '';
  return body.endsWith('\n') ? body : `${body}\n`;
}

function upsertEnvFile(filePath: string, key: string, value: string | null): void {
  let contents = '';
  let existed = false;
  try {
    contents = readFileSync(filePath, 'utf8');
    existed = true;
  } catch (error) {
    if (!isEnoent(error)) throw error;
    if (value === null) return;
  }
  const next = applyEnvKeyLine(contents, key, value);
  if (value === null && !existed) return;
  if (next.length === 0 && existed) {
    writeEnvFileAtomic(filePath, '');
    return;
  }
  if (next.length === 0) return;
  writeEnvFileAtomic(filePath, next);
}

function applyProcessEnv(key: EnvStoreKey, value: string | null): void {
  if (value === null) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

function normalizeSecretInput(raw: string): string | null {
  if (raw.includes('\n') || raw.includes('\r') || raw.includes('\0')) return null;
  const trimmed = raw.trim();
  if (!isUsableEnvSecret(trimmed) || trimmed.length > MAX_SECRET_CHARS) return null;
  return trimmed;
}

/**
 * Persist an allowlisted key in the install.sh `.env` store and the current process.
 * Never logs the value. `.env.local` is updated only when it already has the key
 * so a leftover local override cannot shadow the write after restart.
 */
export function setEnvStoreSecret(
  key: EnvStoreKey,
  raw: string,
  root = getEnvStoreRoot(),
): EnvSecretWriteSuccess | EnvSecretWriteError {
  if (!isEnvStoreKey(key)) return { ok: false, reason: 'invalid' };
  const value = normalizeSecretInput(raw);
  if (!value) return { ok: false, reason: 'invalid' };
  try {
    upsertEnvFile(envStorePath(root, PRIMARY_ENV_FILE), key, value);
    const localPath = envStorePath(root, ENV_FILES[1]);
    if (existsSync(/*turbopackIgnore: true*/ localPath) && envFileHasKey(localPath, key)) {
      upsertEnvFile(localPath, key, value);
    }
    applyProcessEnv(key, value);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'disk' };
  }
}

/** Remove an allowlisted key from `.env` / `.env.local` (if present) and `process.env`. */
export function clearEnvStoreSecret(
  key: EnvStoreKey,
  root = getEnvStoreRoot(),
): EnvSecretWriteSuccess | EnvSecretWriteError {
  if (!isEnvStoreKey(key)) return { ok: false, reason: 'invalid' };
  try {
    for (const name of ENV_FILES) {
      upsertEnvFile(envStorePath(root, name), key, null);
    }
    applyProcessEnv(key, null);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'disk' };
  }
}

function envFileHasKey(filePath: string, key: string): boolean {
  try {
    return readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .some((line) => isKeyAssignment(line, key));
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

export function envStoreSecretConfigured(
  key: EnvStoreKey,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isUsableEnvSecret(env[key]);
}
