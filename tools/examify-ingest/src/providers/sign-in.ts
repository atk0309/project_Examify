import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  agentCliEnv,
  agentCliHomeOutsideCheckout,
  envValue,
  resolveAgentCliBinary,
  withAgentCliWorkDir,
  type AgentCli,
} from './agent-cli';
import { stageCodexHome } from './codex-cli';
import { runProviderCommand, type ProviderCommandResult } from './command';
import type { ProviderEnv } from './types';

/**
 * Whether Claude Code / Codex is signed in for this user, asked the way
 * install.sh asks: `claude auth status` (JSON with `loggedIn`) and
 * `codex login status` ("Logged in …" / "Not logged in", on stderr).
 * `unknown`: the CLI was not found, the check timed out, or its answer was
 * neither (an older CLI without the subcommand).
 */
export type AgentCliSignIn = 'signed_in' | 'signed_out' | 'unknown';

/** A sign-in check is a local status command: a few seconds at most. */
export const AGENT_CLI_SIGNIN_TIMEOUT_MS = 5_000;

/**
 * After the deadline the check stops waiting even if the command never closes
 * its output (a helper it started outside its process group may hold it open).
 */
const SIGNIN_HARD_STOP_GRACE_MS = 1_000;

/** The status commands print a few lines; anything longer is not a status. */
const SIGNIN_MAX_BUFFER = 64 * 1024;

/**
 * Claude Code reads only the project's settings, like a marking run
 * (`--setting-sources project`, before the subcommand: `auth status` refuses
 * it after), so a sign-in that exists only in the service user's own
 * settings (an `env` key, an `apiKeyHelper`) is not counted: the locked-down
 * run would not have it either.
 */
const SIGNIN_ARGS: Record<AgentCli, readonly string[]> = {
  claude: ['--setting-sources', 'project', 'auth', 'status'],
  codex: ['login', 'status'],
};

/**
 * Asked first, once per binary: the subcommand's help must list `status`. A
 * Claude Code before 2.1.40 has no `auth` command and reads `auth status` as
 * a prompt (a whole agent run with the user's own tools and settings), and an
 * older Codex has no `login status`. Help runs nothing on either: an old CLI
 * prints its general help, which lists no `status` command, and the check is
 * `unknown` without running the status command at all.
 */
const SIGNIN_PROBE_ARGS: Record<AgentCli, readonly string[]> = {
  claude: ['auth', '--help'],
  codex: ['login', '--help'],
};

/** Whether help text lists a `status` command (`  status [options]  Show …`). */
export function helpListsStatus(help: string): boolean {
  return /^\s+status\b/m.test(help);
}

/** Per binary file (its real path, size and mtime, so an upgrade asks again): has `status`. */
const probedStatus = new Map<string, boolean>();

function binaryFileKey(bin: string): string | null {
  try {
    const real = realpathSync(bin);
    const stat = statSync(real);
    return `${real}\0${stat.size}\0${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

/** Rejects `hardStopMs` after it is called unless cleared; `clear` always runs. */
function hardStop(hardStopMs: number): { stopped: Promise<never>; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopped = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('sign-in check did not finish')), hardStopMs);
    timer.unref?.();
  });
  // Nobody awaits it once the command wins the race.
  stopped.catch(() => {});
  return { stopped, clear: () => clearTimeout(timer) };
}

/**
 * A sign-in held in the environment the run passes on (agent-cli.ts's
 * allowlist). `codex login status` reads only `auth.json`, while `codex exec`
 * also signs in with CODEX_API_KEY; the same guard covers a Claude Code whose
 * status ignores CLAUDE_CODE_OAUTH_TOKEN.
 */
const SIGNIN_ENV_TOKEN: Record<AgentCli, string> = {
  claude: 'CLAUDE_CODE_OAUTH_TOKEN',
  codex: 'CODEX_API_KEY',
};

/** `claude auth status` output: its JSON `loggedIn`, else unknown. */
export function parseClaudeAuthStatus(stdout: string): AgentCliSignIn {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(stdout.slice(start, end + 1)) as { loggedIn?: unknown } | null;
      if (parsed?.loggedIn === true) return 'signed_in';
      if (parsed?.loggedIn === false) return 'signed_out';
    } catch {
      // Not one JSON object: fall back to the field itself, as install.sh does.
    }
  }
  const field = /"loggedIn"\s*:\s*(true|false)\b/.exec(stdout);
  if (!field) return 'unknown';
  return field[1] === 'true' ? 'signed_in' : 'signed_out';
}

/** `codex login status` output (stderr and stdout together), as install.sh reads it. */
export function parseCodexLoginStatus(text: string): AgentCliSignIn {
  if (/Not logged in/.test(text)) return 'signed_out';
  if (/Logged in/.test(text)) return 'signed_in';
  return 'unknown';
}

/**
 * The status command's output, or null when this CLI has no status command
 * (`SIGNIN_PROBE_ARGS`). Both commands share one deadline.
 */
async function askStatus(
  cli: AgentCli,
  bin: string,
  env: Record<string, string>,
  dir: string,
  timeoutMs: number,
): Promise<ProviderCommandResult | null> {
  const deadline = Date.now() + timeoutMs;
  const run = (args: readonly string[]) =>
    runProviderCommand({
      cmd: bin,
      args,
      stdin: '',
      label: cli,
      timeoutMs: Math.max(1, deadline - Date.now()),
      cwd: dir,
      env,
      maxBuffer: SIGNIN_MAX_BUFFER,
      captureStderr: true,
    });
  const fileKey = binaryFileKey(bin);
  let hasStatus = fileKey ? probedStatus.get(fileKey) : undefined;
  if (hasStatus === undefined) {
    const help = await run(SIGNIN_PROBE_ARGS[cli]);
    hasStatus = helpListsStatus(`${help.stdout}\n${help.stderrTail}`);
    if (fileKey) probedStatus.set(fileKey, hasStatus);
  }
  return hasStatus ? run(SIGNIN_ARGS[cli]) : null;
}

/**
 * Ask the CLI whether it is signed in, locked down like a generate or marking
 * run: the env allowlist (none of Examify's secrets), an empty private run
 * folder, Claude Code without the service user's settings, Codex's private
 * CODEX_HOME holding only a copy of `auth.json`, so the answer is what those
 * runs would see, and a few seconds before the whole process group is killed
 * (a second later the check stops waiting whatever the command does). A CLI
 * whose help lists no status command is not asked. Never throws: anything
 * but a clear answer is `unknown`.
 */
export async function checkAgentCliSignIn(
  cli: AgentCli,
  env: ProviderEnv,
  options: { timeoutMs?: number } = {},
): Promise<AgentCliSignIn> {
  try {
    const bin = resolveAgentCliBinary(cli, env);
    if (!bin) return 'unknown';
    const sourceHome = agentCliHomeOutsideCheckout(cli, env);
    const output = await withAgentCliWorkDir(cli, async (dir) => {
      const childEnv = agentCliEnv(env, cli, dir);
      let copyRefreshedSignInBack = () => {};
      if (cli === 'codex') {
        const home = path.join(dir, 'home');
        copyRefreshedSignInBack = stageCodexHome(sourceHome, home);
        childEnv.CODEX_HOME = home;
      }
      const timeoutMs = options.timeoutMs ?? AGENT_CLI_SIGNIN_TIMEOUT_MS;
      const stop = hardStop(timeoutMs + SIGNIN_HARD_STOP_GRACE_MS);
      try {
        return await Promise.race([askStatus(cli, bin, childEnv, dir, timeoutMs), stop.stopped]);
      } finally {
        stop.clear();
        copyRefreshedSignInBack();
      }
    });
    if (!output) return 'unknown';
    const state =
      cli === 'claude'
        ? parseClaudeAuthStatus(output.stdout)
        : parseCodexLoginStatus(`${output.stderrTail}\n${output.stdout}`);
    if (state === 'signed_out' && envValue(env, SIGNIN_ENV_TOKEN[cli])?.trim()) return 'unknown';
    return state;
  } catch {
    return 'unknown';
  }
}
