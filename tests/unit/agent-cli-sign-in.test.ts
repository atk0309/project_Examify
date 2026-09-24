import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_CLI_SIGNIN_CACHE_MS,
  agentCliSignIn,
  forgetAgentCliSignIn,
  resetAgentCliSignInCacheForTests,
} from '@/lib/agent-cli-sign-in';
import type { AgentCliSignIn } from '@/lib/onboarding-types';
import { fakeCli } from '../helpers/fake-agent-cli';

function hostEnv(extra: { [key: string]: string | undefined } = {}) {
  return {
    PATH: process.env.PATH,
    HOME: mkdtempSync(path.join(tmpdir(), 'examify-home-')),
    ...extra,
  };
}

/** A check that answers from a script and counts its calls; `release` settles a held one. */
function scriptedCheck(answers: AgentCliSignIn[]) {
  let calls = 0;
  let hold: (() => void) | null = null;
  let held = false;
  return {
    calls: () => calls,
    holdNext() {
      held = true;
    },
    release() {
      hold?.();
    },
    check: async (): Promise<AgentCliSignIn> => {
      const answer = answers[Math.min(calls, answers.length - 1)] ?? 'unknown';
      calls += 1;
      if (held) {
        held = false;
        await new Promise<void>((resolve) => {
          hold = resolve;
        });
      }
      return answer;
    },
  };
}

function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  resetAgentCliSignInCacheForTests();
});

describe('agentCliSignIn', () => {
  it('asks once, then answers from the cache while the answer is fresh', async () => {
    const claude = fakeCli('claude', { mode: 'hang' });
    const env = hostEnv({ EXAMIFY_CLAUDE_BIN: claude.bin });
    const script = scriptedCheck(['signed_in']);
    const time = clock();
    const deps = { check: script.check, now: time.now };

    await expect(agentCliSignIn('claude', env, deps)).resolves.toBe('signed_in');
    time.advance(AGENT_CLI_SIGNIN_CACHE_MS.signed_in - 1);
    await expect(agentCliSignIn('claude', env, deps)).resolves.toBe('signed_in');
    expect(script.calls()).toBe(1);
  });

  it('answers a stale result at once and checks again in the background', async () => {
    const claude = fakeCli('claude', { mode: 'hang' });
    const env = hostEnv({ EXAMIFY_CLAUDE_BIN: claude.bin });
    const script = scriptedCheck(['signed_in', 'signed_out']);
    const time = clock();
    const deps = { check: script.check, now: time.now };

    await agentCliSignIn('claude', env, deps);
    time.advance(AGENT_CLI_SIGNIN_CACHE_MS.signed_in);
    script.holdNext();
    // The render does not wait for the new check: it gets the last answer.
    await expect(agentCliSignIn('claude', env, deps)).resolves.toBe('signed_in');
    expect(script.calls()).toBe(2);
    // Renders while that check runs share it (no second process).
    await expect(agentCliSignIn('claude', env, deps)).resolves.toBe('signed_in');
    expect(script.calls()).toBe(2);
    script.release();
    await flush();
    await expect(agentCliSignIn('claude', env, deps)).resolves.toBe('signed_out');
    expect(script.calls()).toBe(2);
  });

  it('waits for the new check when the last answer is very old', async () => {
    const claude = fakeCli('claude', { mode: 'hang' });
    const env = hostEnv({ EXAMIFY_CLAUDE_BIN: claude.bin });
    const script = scriptedCheck(['signed_in', 'signed_out']);
    const time = clock();
    const deps = { check: script.check, now: time.now };
    await agentCliSignIn('claude', env, deps);
    // A server idle overnight: yesterday's answer is not served.
    time.advance(2 * AGENT_CLI_SIGNIN_CACHE_MS.signed_in);
    await expect(agentCliSignIn('claude', env, deps)).resolves.toBe('signed_out');
    expect(script.calls()).toBe(2);
  });

  it('lets a signed-out answer go stale sooner, and waits for the new check', async () => {
    expect(AGENT_CLI_SIGNIN_CACHE_MS.signed_out).toBeLessThan(AGENT_CLI_SIGNIN_CACHE_MS.signed_in);
    // "A few minutes", so a page render rarely starts a check.
    expect(AGENT_CLI_SIGNIN_CACHE_MS.signed_in).toBeGreaterThanOrEqual(60_000);
    expect(AGENT_CLI_SIGNIN_CACHE_MS.unknown).toBe(AGENT_CLI_SIGNIN_CACHE_MS.signed_in);

    const codex = fakeCli('codex', { mode: 'hang' });
    const env = hostEnv({ EXAMIFY_CODEX_BIN: codex.bin });
    const script = scriptedCheck(['signed_out', 'signed_in']);
    const time = clock();
    const deps = { check: script.check, now: time.now };

    await expect(agentCliSignIn('codex', env, deps)).resolves.toBe('signed_out');
    time.advance(AGENT_CLI_SIGNIN_CACHE_MS.signed_out - 1);
    await agentCliSignIn('codex', env, deps);
    expect(script.calls()).toBe(1);
    time.advance(1);
    // Signed in since: the next load says so (no stale "signed out").
    await expect(agentCliSignIn('codex', env, deps)).resolves.toBe('signed_in');
    expect(script.calls()).toBe(2);
  });

  it('asks again on a recheck, even while the answer is fresh', async () => {
    const claude = fakeCli('claude', { mode: 'hang' });
    const env = hostEnv({ EXAMIFY_CLAUDE_BIN: claude.bin });
    const script = scriptedCheck(['signed_out', 'signed_in']);
    const deps = { check: script.check };
    await expect(agentCliSignIn('claude', env, deps)).resolves.toBe('signed_out');
    await expect(agentCliSignIn('claude', env, { ...deps, recheck: true })).resolves.toBe(
      'signed_in',
    );
    expect(script.calls()).toBe(2);
    // The recheck's answer is what everyone else gets next.
    await expect(agentCliSignIn('claude', env, deps)).resolves.toBe('signed_in');
    expect(script.calls()).toBe(2);
  });

  it('shares one first check between renders that arrive together', async () => {
    const claude = fakeCli('claude', { mode: 'hang' });
    const env = hostEnv({ EXAMIFY_CLAUDE_BIN: claude.bin });
    const script = scriptedCheck(['signed_out']);
    const deps = { check: script.check };
    const answers = await Promise.all([
      agentCliSignIn('claude', env, deps),
      agentCliSignIn('claude', env, deps),
      agentCliSignIn('claude', env, deps),
    ]);
    expect(answers).toEqual(['signed_out', 'signed_out', 'signed_out']);
    expect(script.calls()).toBe(1);
  });

  it('asks nothing when the CLI is not found', async () => {
    const script = scriptedCheck(['signed_in']);
    const missing = path.join(mkdtempSync(path.join(tmpdir(), 'examify-none-')), 'codex');
    await expect(
      agentCliSignIn('codex', hostEnv({ EXAMIFY_CODEX_BIN: missing, PATH: '' }), {
        check: script.check,
      }),
    ).resolves.toBe('unknown');
    expect(script.calls()).toBe(0);
  });

  it('asks again when the binary, its folder or a passed-on token changes', async () => {
    const first = fakeCli('codex', { mode: 'hang' });
    const second = fakeCli('codex', { mode: 'hang' });
    const home = mkdtempSync(path.join(tmpdir(), 'examify-home-'));
    const script = scriptedCheck(['signed_out', 'signed_in', 'signed_out', 'signed_in']);
    const deps = { check: script.check };
    const base = { PATH: process.env.PATH, HOME: home };

    await expect(
      agentCliSignIn('codex', { ...base, EXAMIFY_CODEX_BIN: first.bin }, deps),
    ).resolves.toBe('signed_out');
    await expect(
      agentCliSignIn('codex', { ...base, EXAMIFY_CODEX_BIN: second.bin }, deps),
    ).resolves.toBe('signed_in');
    await expect(
      agentCliSignIn(
        'codex',
        { ...base, EXAMIFY_CODEX_BIN: first.bin, CODEX_HOME: path.join(home, 'other') },
        deps,
      ),
    ).resolves.toBe('signed_out');
    await expect(
      agentCliSignIn('codex', { ...base, EXAMIFY_CODEX_BIN: first.bin, CODEX_API_KEY: 'k' }, deps),
    ).resolves.toBe('signed_in');
    expect(script.calls()).toBe(4);
    // Back to the first setup: still cached.
    await expect(
      agentCliSignIn('codex', { ...base, EXAMIFY_CODEX_BIN: first.bin }, deps),
    ).resolves.toBe('signed_out');
    expect(script.calls()).toBe(4);
  });

  it('forgets one CLI’s answers when a run it made was refused as not signed in', async () => {
    const claude = fakeCli('claude', { mode: 'hang' });
    const codex = fakeCli('codex', { mode: 'hang' });
    const env = hostEnv({ EXAMIFY_CLAUDE_BIN: claude.bin, EXAMIFY_CODEX_BIN: codex.bin });
    const script = scriptedCheck(['signed_in', 'signed_in', 'signed_out']);
    const deps = { check: script.check };
    await agentCliSignIn('claude', env, deps);
    await agentCliSignIn('codex', env, deps);
    forgetAgentCliSignIn('claude');
    await expect(agentCliSignIn('claude', env, deps)).resolves.toBe('signed_out');
    await expect(agentCliSignIn('codex', env, deps)).resolves.toBe('signed_in');
    expect(script.calls()).toBe(3);
  });

  it('is unknown when the check itself fails', async () => {
    const claude = fakeCli('claude', { mode: 'hang' });
    const env = hostEnv({ EXAMIFY_CLAUDE_BIN: claude.bin });
    await expect(
      agentCliSignIn('claude', env, {
        check: () => Promise.reject(new Error('spawn failed')),
      }),
    ).resolves.toBe('unknown');
  });

  it('runs the real check once per fresh answer', async () => {
    const claude = fakeCli('claude', { mode: 'hang', signIn: 'out' });
    const env = hostEnv({ EXAMIFY_CLAUDE_BIN: claude.bin });
    await expect(agentCliSignIn('claude', env)).resolves.toBe('signed_out');
    await expect(agentCliSignIn('claude', env)).resolves.toBe('signed_out');
    expect(claude.statusCalls()).toBe(1);
  });
});
