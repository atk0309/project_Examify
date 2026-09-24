import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AGENT_CLI_SIGNIN_TIMEOUT_MS,
  checkAgentCliSignIn,
  parseClaudeAuthStatus,
  parseCodexLoginStatus,
  safeTempRoot,
} from '../../tools/examify-ingest/src/generate-api';
import { fakeCli } from '../helpers/fake-agent-cli';

/** The env a check gets: this machine's PATH (for node) plus secrets that must not reach the CLI. */
function hostEnv(extra: { [key: string]: string | undefined } = {}) {
  return {
    PATH: process.env.PATH,
    HOME: mkdtempSync(path.join(tmpdir(), 'examify-home-')),
    AUTH_SECRET: 'auth-secret-must-not-leak',
    SETUP_BOOTSTRAP_SECRET: 'setup-secret-must-not-leak',
    SMTP_PASS: 'smtp-pass-must-not-leak',
    ANTHROPIC_API_KEY: 'sk-ant-must-not-leak',
    OPENAI_API_KEY: 'sk-openai-must-not-leak',
    ...extra,
  };
}

const SECRET_KEYS = [
  'AUTH_SECRET',
  'SETUP_BOOTSTRAP_SECRET',
  'SMTP_PASS',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
];

describe('sign-in status output', () => {
  it('reads loggedIn from `claude auth status`', () => {
    expect(parseClaudeAuthStatus('{\n  "loggedIn": true,\n  "authMethod": "claude.ai"\n}\n')).toBe(
      'signed_in',
    );
    expect(parseClaudeAuthStatus('{"loggedIn":false,"authMethod":"none"}')).toBe('signed_out');
    // A warning line around the JSON does not hide it.
    expect(parseClaudeAuthStatus('Update available\n{"loggedIn": false}\n')).toBe('signed_out');
    // The field alone, as install.sh matches it.
    expect(parseClaudeAuthStatus('{"loggedIn": true, broken')).toBe('signed_in');
    expect(parseClaudeAuthStatus('noise "loggedIn": false noise')).toBe('signed_out');
    // No answer: an older CLI, the text format, or a non-boolean field.
    expect(parseClaudeAuthStatus("error: unknown command 'auth'")).toBe('unknown');
    expect(parseClaudeAuthStatus('Login method: Claude API account')).toBe('unknown');
    expect(parseClaudeAuthStatus('{"loggedIn": "yes"}')).toBe('unknown');
    expect(parseClaudeAuthStatus('')).toBe('unknown');
  });

  it('reads "Logged in" / "Not logged in" from `codex login status`', () => {
    expect(parseCodexLoginStatus('Logged in using ChatGPT\n')).toBe('signed_in');
    expect(parseCodexLoginStatus('Logged in using an API key - sk-proj-***ABCDE')).toBe(
      'signed_in',
    );
    expect(parseCodexLoginStatus('Not logged in\n')).toBe('signed_out');
    expect(parseCodexLoginStatus("error: unrecognized subcommand 'status'")).toBe('unknown');
    expect(parseCodexLoginStatus('')).toBe('unknown');
  });
});

describe('checkAgentCliSignIn', () => {
  it('asks Claude Code with `claude auth status`, locked down like a marking run', async () => {
    const signedIn = fakeCli('claude', { mode: 'hang', signIn: 'in' });
    const env = hostEnv({ EXAMIFY_CLAUDE_BIN: signedIn.bin, CLAUDE_CONFIG_DIR: '/srv/claude' });
    await expect(checkAgentCliSignIn('claude', env)).resolves.toBe('signed_in');

    const record = signedIn.statusRecord();
    // The service user's own settings stay out, as in a marking run (the
    // option goes before the subcommand, which refuses it after).
    expect(record.argv).toEqual(['--setting-sources', 'project', 'auth', 'status']);
    // An empty private folder outside the checkout, removed afterwards.
    expect(record.cwdEntries).toEqual([]);
    expect(realpathSync(path.dirname(record.cwd))).toBe(realpathSync(safeTempRoot()));
    expect(path.basename(record.cwd)).toMatch(/^examify-claude-/);
    expect(existsSync(record.cwd)).toBe(false);
    // The allowlisted env only: no Examify secrets, its own temp folder, safe mode.
    for (const key of SECRET_KEYS) expect(record.env[key]).toBeUndefined();
    expect(record.env.CLAUDE_CONFIG_DIR).toBe('/srv/claude');
    expect(record.env.TMPDIR).toBe(record.cwd);
    expect(record.env.CLAUDE_CODE_SAFE_MODE).toBe('1');

    const signedOut = fakeCli('claude', { mode: 'hang', signIn: 'out' });
    await expect(
      checkAgentCliSignIn('claude', hostEnv({ EXAMIFY_CLAUDE_BIN: signedOut.bin })),
    ).resolves.toBe('signed_out');
  });

  it('asks Codex with `codex login status` in a private CODEX_HOME', async () => {
    const userHome = mkdtempSync(path.join(tmpdir(), 'examify-codex-home-'));
    const auth = '{"tokens":{"refresh_token":"r1"}}';
    writeFileSync(path.join(userHome, 'auth.json'), auth);
    writeFileSync(path.join(userHome, 'AGENTS.md'), 'user instructions');
    const signedIn = fakeCli('codex', { mode: 'hang', signIn: 'in' });
    const env = hostEnv({ EXAMIFY_CODEX_BIN: signedIn.bin, CODEX_HOME: userHome });
    await expect(checkAgentCliSignIn('codex', env)).resolves.toBe('signed_in');

    const record = signedIn.statusRecord();
    expect(record.argv).toEqual(['login', 'status']);
    for (const key of SECRET_KEYS) expect(record.env[key]).toBeUndefined();
    // Only a copy of the sign-in, never the user's folder itself.
    expect(record.env.CODEX_HOME).toBe(path.join(record.cwd, 'home'));
    expect(record.codexHome).toEqual({ entries: ['auth.json'], auth });
    expect(existsSync(record.cwd)).toBe(false);
    expect(readFileSync(path.join(userHome, 'auth.json'), 'utf8')).toBe(auth);

    const signedOut = fakeCli('codex', { mode: 'hang', signIn: 'out' });
    await expect(
      checkAgentCliSignIn('codex', hostEnv({ EXAMIFY_CODEX_BIN: signedOut.bin })),
    ).resolves.toBe('signed_out');
  });

  it('never runs the status command on a CLI without it (an old Claude Code reads it as a prompt)', async () => {
    for (const cli of ['claude', 'codex'] as const) {
      const old = fakeCli(cli, { mode: 'hang', signIn: 'old' });
      const binEnv = cli === 'claude' ? 'EXAMIFY_CLAUDE_BIN' : 'EXAMIFY_CODEX_BIN';
      await expect(checkAgentCliSignIn(cli, hostEnv({ [binEnv]: old.bin }))).resolves.toBe(
        'unknown',
      );
      await expect(checkAgentCliSignIn(cli, hostEnv({ [binEnv]: old.bin }))).resolves.toBe(
        'unknown',
      );
      expect(old.promptRuns()).toBe(0);
      expect(old.statusCalls()).toBe(0);
      // Its help is asked once per binary.
      expect(old.helpCalls()).toBe(1);
    }
  });

  it('asks the help once per binary file, and again after an upgrade', async () => {
    const claude = fakeCli('claude', { mode: 'hang', signIn: 'in' });
    const env = hostEnv({ EXAMIFY_CLAUDE_BIN: claude.bin });
    await expect(checkAgentCliSignIn('claude', env)).resolves.toBe('signed_in');
    await expect(checkAgentCliSignIn('claude', env)).resolves.toBe('signed_in');
    expect([claude.helpCalls(), claude.statusCalls()]).toEqual([1, 2]);
    // The same path, a new file (an in-place upgrade): asked again.
    writeFileSync(claude.bin, `${readFileSync(claude.bin, 'utf8')}\n// upgraded\n`);
    await expect(checkAgentCliSignIn('claude', env)).resolves.toBe('signed_in');
    expect([claude.helpCalls(), claude.statusCalls()]).toEqual([2, 3]);
  });

  it('is unknown when the CLI gives no answer in time', async () => {
    const hang = fakeCli('claude', { mode: 'hang', signIn: 'hang' });
    const started = Date.now();
    await expect(
      checkAgentCliSignIn('claude', hostEnv({ EXAMIFY_CLAUDE_BIN: hang.bin }), {
        timeoutMs: 400,
      }),
    ).resolves.toBe('unknown');
    expect(Date.now() - started).toBeLessThan(5_000);
    // The check's process is gone (the whole group is killed).
    const pid = hang.statusRecord().pid;
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(() => process.kill(pid, 0)).toThrow();
    // Page renders wait on this, so the default is a few seconds.
    expect(AGENT_CLI_SIGNIN_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });

  it('stops waiting soon after the deadline even when the output never closes', async () => {
    const orphan = fakeCli('codex', { mode: 'hang', signIn: 'orphan' });
    const started = Date.now();
    try {
      await expect(
        checkAgentCliSignIn('codex', hostEnv({ EXAMIFY_CODEX_BIN: orphan.bin }), {
          timeoutMs: 300,
        }),
      ).resolves.toBe('unknown');
      expect(Date.now() - started).toBeLessThan(4_000);
      // The private run folder (with its copy of the sign-in) is removed anyway.
      expect(existsSync(orphan.statusRecord().cwd)).toBe(false);
    } finally {
      const pid = Number(readFileSync(path.join(orphan.dir, 'orphan.pid'), 'utf8'));
      if (pid > 0) process.kill(pid, 'SIGKILL');
    }
  });

  it('is unknown, and runs nothing, when the CLI is not found', async () => {
    const missing = path.join(mkdtempSync(path.join(tmpdir(), 'examify-none-')), 'claude');
    await expect(
      checkAgentCliSignIn('claude', hostEnv({ EXAMIFY_CLAUDE_BIN: missing, PATH: '' })),
    ).resolves.toBe('unknown');
  });

  it('runs nothing when the CLI folder is inside an Examify checkout', async () => {
    const checkout = mkdtempSync(path.join(tmpdir(), 'examify-checkout-'));
    writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({ name: 'project-examify' }));
    const home = path.join(checkout, '.claude');
    mkdirSync(home);
    const fake = fakeCli('claude', { mode: 'hang', signIn: 'out' });
    await expect(
      checkAgentCliSignIn(
        'claude',
        hostEnv({ EXAMIFY_CLAUDE_BIN: fake.bin, CLAUDE_CONFIG_DIR: home }),
      ),
    ).resolves.toBe('unknown');
    expect(fake.statusCalls()).toBe(0);
  });

  it('does not call a CLI signed out when the run passes it a sign-in token', async () => {
    const claude = fakeCli('claude', { mode: 'hang', signIn: 'out' });
    await expect(
      checkAgentCliSignIn(
        'claude',
        hostEnv({ EXAMIFY_CLAUDE_BIN: claude.bin, CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token' }),
      ),
    ).resolves.toBe('unknown');
    const codex = fakeCli('codex', { mode: 'hang', signIn: 'out' });
    await expect(
      checkAgentCliSignIn('codex', hostEnv({ EXAMIFY_CODEX_BIN: codex.bin, CODEX_API_KEY: 'k' })),
    ).resolves.toBe('unknown');
    // A blank token is no sign-in.
    await expect(
      checkAgentCliSignIn('codex', hostEnv({ EXAMIFY_CODEX_BIN: codex.bin, CODEX_API_KEY: ' ' })),
    ).resolves.toBe('signed_out');
    // Signed in stays signed in.
    const inClaude = fakeCli('claude', { mode: 'hang', signIn: 'in' });
    await expect(
      checkAgentCliSignIn(
        'claude',
        hostEnv({ EXAMIFY_CLAUDE_BIN: inClaude.bin, CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token' }),
      ),
    ).resolves.toBe('signed_in');
  });
});
