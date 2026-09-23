import { accessSync, constants, mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeTempRoot } from '../temp-root';
import { CliNotFoundError, type ProviderEnv } from './types';

/**
 * Shared plumbing for the AI command-line tools a household may already pay
 * for (Claude Code, Codex): where the binary is, what environment it gets,
 * and a private scratch folder. Each run is locked down by its provider
 * (claude-cli.ts / codex-cli.ts): no tools that read files, run commands or
 * fetch the web, and no session saved.
 */
export type AgentCli = 'claude' | 'codex';

export const AGENT_CLI_BIN_ENV: Record<AgentCli, string> = {
  claude: 'EXAMIFY_CLAUDE_BIN',
  codex: 'EXAMIFY_CODEX_BIN',
};

export const AGENT_CLI_MODEL_ENV: Record<AgentCli, string> = {
  claude: 'EXAMIFY_CLAUDE_MODEL',
  codex: 'EXAMIFY_CODEX_MODEL',
};

/** Recorded model when neither `--model` nor the model env var is set: the CLI picks. */
export const AGENT_CLI_DEFAULT_MODEL = 'default';

/** Stdout cap for agent CLIs (their JSON event stream repeats the answer). */
export const AGENT_CLI_MAX_BUFFER = 20 * 1024 * 1024;

const AGENT_CLI_LABEL: Record<AgentCli, string> = {
  claude: 'Claude Code (claude)',
  codex: 'Codex (codex)',
};

/**
 * The only variables an agent CLI inherits. Examify's own secrets
 * (AUTH_SECRET, SMTP / Resend credentials, ANTHROPIC_API_KEY,
 * OPENAI_API_KEY, …) never reach it: the CLI signs in with its own login.
 */
const BASE_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TZ',
  'TMPDIR',
  'TMP',
  'TEMP',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'all_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'SYSTEMROOT',
  'WINDIR',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PATHEXT',
  'COMSPEC',
] as const;

/** Each CLI's own config folder and headless sign-in token. */
const CLI_ENV_KEYS: Record<AgentCli, readonly string[]> = {
  claude: ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN'],
  codex: ['CODEX_HOME', 'CODEX_API_KEY'],
};

const CLI_ENV_SET: Record<AgentCli, Record<string, string>> = {
  // A server-launched run must not update itself or send telemetry, and must not
  // load the user's CLAUDE.md, hooks, plugins, skills or MCP servers (safe mode;
  // an older Claude Code ignores the variable, and `--setting-sources project`
  // in claude-cli.ts still keeps user settings and CLAUDE.md out).
  claude: {
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_SAFE_MODE: '1',
  },
  codex: {},
};

export function agentCliEnv(env: ProviderEnv, cli: AgentCli): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of [...BASE_ENV_KEYS, ...CLI_ENV_KEYS[cli]]) {
    const value = env[key];
    if (value !== undefined) out[key] = value;
  }
  return { ...out, ...CLI_ENV_SET[cli] };
}

function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (process.platform !== 'win32') accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function binaryNames(name: string): string[] {
  return process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, name] : [name];
}

function searchDirs(name: string, dirs: readonly string[]): string | null {
  for (const dir of dirs) {
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const candidate of binaryNames(name)) {
      const file = path.join(dir, candidate);
      if (isExecutableFile(file)) return file;
    }
  }
  return null;
}

function pathDirs(env: ProviderEnv): string[] {
  return (env.PATH ?? '').split(path.delimiter).filter(Boolean);
}

/**
 * Where the CLI is: `EXAMIFY_CLAUDE_BIN` / `EXAMIFY_CODEX_BIN` (an absolute
 * path, or a bare name looked up on PATH), else the name on PATH, else the
 * installers' per-user folders (`~/.local/bin`; `~/.claude/local` for Claude
 * Code) that a service's PATH often misses. Null when not found.
 */
export function resolveAgentCliBinary(cli: AgentCli, env: ProviderEnv): string | null {
  const configured = env[AGENT_CLI_BIN_ENV[cli]]?.trim() ?? '';
  if (configured) {
    if (configured.includes('/') || configured.includes(path.sep)) {
      return path.isAbsolute(configured) && isExecutableFile(configured) ? configured : null;
    }
    return searchDirs(configured, pathDirs(env));
  }
  const home = env.HOME?.trim() || os.homedir();
  const userDirs = [
    path.join(home, '.local', 'bin'),
    ...(cli === 'claude' ? [path.join(home, '.claude', 'local')] : []),
  ];
  return searchDirs(cli, [...pathDirs(env), ...userDirs]);
}

export function requireAgentCliBinary(cli: AgentCli, env: ProviderEnv): string {
  const found = resolveAgentCliBinary(cli, env);
  if (found) return found;
  const envName = AGENT_CLI_BIN_ENV[cli];
  const configured = env[envName]?.trim();
  throw new CliNotFoundError(
    cli,
    configured
      ? `${envName} does not name an executable file (use its full path, or a name on PATH)`
      : `${AGENT_CLI_LABEL[cli]} was not found on PATH or in ~/.local/bin. Install it and sign in as the user that runs Examify, or set ${envName} to its full path`,
  );
}

/** `--model` / model env var, else the CLI's own default (no `--model` flag). */
export function agentCliModelArgs(model: string, flag: string): string[] {
  return model && model !== AGENT_CLI_DEFAULT_MODEL ? [flag, model] : [];
}

/** A private (0700) scratch folder for one run, outside the checkout, removed afterwards. */
export async function withAgentCliWorkDir<T>(
  cli: AgentCli,
  work: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(path.join(safeTempRoot(), `examify-${cli}-`));
  try {
    return await work(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Parse a JSON-lines event stream, skipping lines that are not JSON objects. */
export function parseJsonLines(stdout: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        events.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Not an event line.
    }
  }
  return events;
}

/** First line of a CLI's own error text, trimmed for a CLI error message. */
export function cliDetail(text: string, max = 200): string {
  const line = text.trim().split('\n')[0]?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** A CLI's error text that means "not signed in / sign-in refused". */
export const CLI_AUTH_HINT =
  /\/login|not logged in|log in|logged out|sign in|signed in|authenticat|unauthori[sz]ed|invalid api key|credential/i;
