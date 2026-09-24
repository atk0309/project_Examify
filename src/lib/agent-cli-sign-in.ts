import 'server-only';

import * as ingest from 'examify-ingest/generate';
import type { AgentCliSignIn } from '@/lib/onboarding-types';

/* ============================================================================
   EXAMIFY — CLAUDE CODE / CODEX SIGN-IN, CACHED (server-only)
   ----------------------------------------------------------------------------
   Whether the household's Claude Code / Codex is signed in decides if exams
   keep written questions, so pages ask on render. The check itself
   (`checkAgentCliSignIn`: `claude auth status` / `codex login status`, locked
   down like a marking run, a few seconds at most) is cached per process:
   - a fresh result is returned as it is;
   - a stale signed-in (or unknown) one is returned too, and a new check starts
     in the background, so those renders never wait; one older than twice its
     freshness (a server idle overnight) waits for the new check instead;
   - a signed-out one goes stale sooner (30 s) and then waits for the new
     check, so a household that has just signed in sees it on the next load;
   - `recheck` (the admin's setup wizard page) always waits for a new check;
   - one check at a time per CLI: renders that need one share it.
   A render waits at most the check's own few-second deadline.
   ========================================================================== */

/** How long each answer counts as fresh. */
export const AGENT_CLI_SIGNIN_CACHE_MS: Record<AgentCliSignIn, number> = {
  signed_in: 5 * 60_000,
  unknown: 5 * 60_000,
  signed_out: 30_000,
};

type ProviderEnv = Record<string, string | undefined>;

export type AgentCliSignInOptions = {
  /** Ask again even when the cached answer is fresh (and wait for it). */
  recheck?: boolean;
  /** Tests: the check and the clock. */
  check?: (cli: ingest.AgentCli, env: ProviderEnv) => Promise<AgentCliSignIn>;
  now?: () => number;
};

type CacheEntry = { cli: ingest.AgentCli; state: AgentCliSignIn; checkedAt: number };

const results = new Map<string, CacheEntry>();
const running = new Map<string, Promise<AgentCliSignIn>>();
/** Bumped by the test reset, so a check started before it is not cached after it. */
let generation = 0;

/** The sign-in token the run passes on, when set (its value is not kept). */
const ENV_TOKEN: Record<ingest.AgentCli, string> = {
  claude: 'CLAUDE_CODE_OAUTH_TOKEN',
  codex: 'CODEX_API_KEY',
};

/**
 * What the answer depends on: the binary, the CLI's own folder, and whether a
 * token is passed on. Null when the CLI is not found (nothing to ask).
 */
function cacheKey(cli: ingest.AgentCli, env: ProviderEnv): string | null {
  const bin = ingest.resolveAgentCliBinary(cli, env);
  if (!bin) return null;
  return JSON.stringify([
    cli,
    bin,
    ingest.agentCliHome(cli, env),
    Boolean(env[ENV_TOKEN[cli]]?.trim()),
  ]);
}

function startCheck(
  key: string,
  cli: ingest.AgentCli,
  env: ProviderEnv,
  deps: AgentCliSignInOptions,
): Promise<AgentCliSignIn> {
  const inFlight = running.get(key);
  if (inFlight) return inFlight;
  const check = deps.check ?? ingest.checkAgentCliSignIn;
  const now = deps.now ?? Date.now;
  const startedIn = generation;
  const started = (async (): Promise<AgentCliSignIn> => {
    let state: AgentCliSignIn;
    try {
      state = await check(cli, env);
    } catch {
      state = 'unknown';
    }
    if (startedIn === generation) {
      results.set(key, { cli, state, checkedAt: now() });
      running.delete(key);
    }
    return state;
  })();
  running.set(key, started);
  return started;
}

/**
 * Whether `cli` is signed in for the user that runs Examify, from the cache
 * when it can. `unknown` when the CLI is not found or gave no clear answer.
 */
export async function agentCliSignIn(
  cli: ingest.AgentCli,
  env: ProviderEnv,
  options: AgentCliSignInOptions = {},
): Promise<AgentCliSignIn> {
  const key = cacheKey(cli, env);
  if (!key) return 'unknown';
  const now = options.now ?? Date.now;
  const cached = results.get(key);
  const age = cached ? now() - cached.checkedAt : Infinity;
  const freshMs = cached ? AGENT_CLI_SIGNIN_CACHE_MS[cached.state] : 0;
  if (cached && age < freshMs && !options.recheck) return cached.state;
  const check = startCheck(key, cli, env, options);
  // Stale signed in / unknown: this render gets the last answer, the next one the new one.
  if (cached && !options.recheck && cached.state !== 'signed_out' && age < 2 * freshMs) {
    return cached.state;
  }
  return check;
}

/**
 * Forget `cli`'s cached answers, so the next render asks again: a generate or
 * marking run it refused as not signed in. Nothing is cached from that
 * failure itself; the status command stays the only answer.
 */
export function forgetAgentCliSignIn(cli: ingest.AgentCli): void {
  for (const [key, entry] of results) {
    if (entry.cli === cli) results.delete(key);
  }
}

/** Forget every cached answer (tests). A check still running finishes on its own. */
export function resetAgentCliSignInCacheForTests(): void {
  generation += 1;
  results.clear();
  running.clear();
}
