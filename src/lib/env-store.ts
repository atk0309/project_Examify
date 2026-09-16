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
/** Tests only — Docker / systemd / parent exec environ. `null` = real `/proc`. */
let initialEnvironOverride: Record<string, string | undefined> | null = null;
let cachedInitialEnviron: Record<string, string> | null = null;

/** Tests only — point `.env` writes at a temp tree. */
export function setEnvStoreRootForTests(root: string | null): void {
  envStoreRootOverride = root;
  if (root === null) initialEnvironOverride = null;
}

/** Tests only — simulate a host-injected exec environment. */
export function setInitialEnvironForTests(env: Record<string, string | undefined> | null): void {
  initialEnvironOverride = env;
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

export type EnvSecretWriteError = { ok: false; reason: 'invalid' | 'disk' | 'host_managed' };
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
  if (envStoreSecretWriteBlocked(key, root)) return { ok: false, reason: 'host_managed' };
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
  if (envStoreSecretWriteBlocked(key, root)) return { ok: false, reason: 'host_managed' };
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
  return readEnvFileKey(filePath, key) !== undefined;
}

function parseEnvAssignmentValue(line: string, key: string): string | undefined {
  if (!isKeyAssignment(line, key)) return undefined;
  const body = line.trim();
  const rest = body.startsWith('export ') ? body.slice(7).trim() : body;
  const eq = rest.indexOf('=');
  let value = rest.slice(eq + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

function readEnvFileKey(filePath: string, key: string): string | undefined {
  try {
    for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      const value = parseEnvAssignmentValue(line, key);
      if (value !== undefined) return value;
    }
    return undefined;
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}

/** `.env` then `.env.local` (local wins) — same order as ingest `mergeRepoEnvFiles`. */
function readStoreFileSecret(root: string, key: string): string | undefined {
  let value = readEnvFileKey(envStorePath(root, PRIMARY_ENV_FILE), key);
  const local = readEnvFileKey(envStorePath(root, ENV_FILES[1]), key);
  if (local !== undefined) value = local;
  return value;
}

/**
 * Initial exec environment (Linux `/proc/self/environ`). Next.js / dotenv
 * copies `.env` into `process.env` after start; Docker / systemd / a parent
 * shell put the key in the exec environ. Only allowlisted keys are kept.
 */
function readInitialProcessEnviron(): Record<string, string> {
  if (cachedInitialEnviron) return cachedInitialEnviron;
  const out: Record<string, string> = {};
  try {
    const raw = readFileSync('/proc/self/environ', 'utf8');
    for (const entry of raw.split('\0')) {
      const eq = entry.indexOf('=');
      if (eq <= 0) continue;
      const name = entry.slice(0, eq);
      if (!isEnvStoreKey(name)) continue;
      out[name] = entry.slice(eq + 1);
    }
  } catch {
    // Non-Linux or unreadable — no exec-environ evidence.
  }
  cachedInitialEnviron = out;
  return out;
}

function resolveInitialEnviron(
  explicit?: Record<string, string | undefined>,
): Record<string, string | undefined> {
  if (explicit) return explicit;
  if (initialEnvironOverride) return initialEnvironOverride;
  // Temp-root tests must not inherit the runner's real exec environ.
  if (envStoreRootOverride !== null) return {};
  return readInitialProcessEnviron();
}

/** True when the exec environ assigned the key — including `''` / `test`. */
function execEnvironAssignsKey(env: Record<string, string | undefined>, key: string): boolean {
  return Object.hasOwn(env, key);
}

/**
 * True when a host (Docker / systemd / parent process) owns the key.
 * Provenance is the process exec environment, not live-vs-file equality
 * and not “usable?” — an injected `''` or `test` still wins after restart
 * (`mergeRepoEnvFiles` leaves existing env alone, including empty).
 */
export function envStoreSecretHostManaged(
  key: EnvStoreKey,
  root = getEnvStoreRoot(),
  env: Record<string, string | undefined> = process.env,
  initialEnv?: Record<string, string | undefined>,
): boolean {
  if (execEnvironAssignsKey(resolveInitialEnviron(initialEnv), key)) return true;
  const live = env[key]?.trim() ?? '';
  if (!isUsableEnvSecret(live)) return false;
  const stored = readStoreFileSecret(root, key)?.trim() ?? '';
  return stored !== live;
}

export function envStoreSecretConfigured(
  key: EnvStoreKey,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isUsableEnvSecret(env[key]);
}

/**
 * True when live env or the `.env` store has a value — including `test`.
 * Empty is not present. Never returns the value.
 */
export function envStoreSecretPresent(
  key: EnvStoreKey,
  env: Record<string, string | undefined> = process.env,
  root = getEnvStoreRoot(),
): boolean {
  const live = env[key];
  if (typeof live === 'string' && live.trim() !== '') return true;
  const stored = readStoreFileSecret(root, key);
  return typeof stored === 'string' && stored.trim() !== '';
}

/**
 * Host-injected usable keys stay locked. A boot `test` sentinel can still
 * be cleared / replaced so the wizard does not require saving a dummy key.
 * Host-injected empty stays locked (not a sentinel the admin can clear).
 */
export function envStoreSecretWriteBlocked(
  key: EnvStoreKey,
  root = getEnvStoreRoot(),
  env: Record<string, string | undefined> = process.env,
  initialEnv?: Record<string, string | undefined>,
): boolean {
  if (!envStoreSecretHostManaged(key, root, env, initialEnv)) return false;
  const live = env[key]?.trim() ?? '';
  return live !== 'test';
}
