import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_CLI_PROBE_CACHE_MS,
  AGENT_CLI_SIGNIN_TIMEOUT_MS,
  checkAgentCliSignIn,
  helpListsStatus,
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

/**
 * A fake whose help probe has already been answered (cached per binary file),
 * then set to `signIn`: the deadline under test covers the status command only.
 */
async function warmedFake(cli: 'claude' | 'codex', signIn: 'hang' | 'orphan') {
  const fake = fakeCli(cli, { mode: 'hang', signIn: 'in' });
  const binEnv = cli === 'claude' ? 'EXAMIFY_CLAUDE_BIN' : 'EXAMIFY_CODEX_BIN';
  await expect(checkAgentCliSignIn(cli, hostEnv({ [binEnv]: fake.bin }))).resolves.toBe(
    'signed_in',
  );
  writeFileSync(path.join(fake.dir, 'behavior.json'), JSON.stringify({ mode: 'hang', signIn }));
  return fake;
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

describe('the status command in a CLI’s help', () => {
  const CLAUDE_AUTH_HELP = [
    'Usage: claude auth [options] [command]',
    '',
    'Manage authentication',
    '',
    'Options:',
    '  -h, --help        Display help for command',
    '',
    'Commands:',
    '  help [command]    display help for command',
    '  login [options]   Sign in to your Anthropic account',
    '  logout            Log out from your Anthropic account',
    '  status [options]  Show authentication status',
    '',
  ].join('\n');
  const CODEX_LOGIN_HELP = [
    'Manage login',
    '',
    'Usage: codex login [OPTIONS] [COMMAND]',
    '',
    'Commands:',
    '  status  Show login status',
    '  help    Print this message or the help of the given subcommand(s)',
    '',
    'Options:',
    '  -c, --config <key=value>',
    '          Override a configuration value',
  ].join('\n');

  it('finds it in the Commands list of `claude auth --help` / `codex login --help`', () => {
    expect(helpListsStatus(CLAUDE_AUTH_HELP)).toBe(true);
    expect(helpListsStatus(CODEX_LOGIN_HELP)).toBe(true);
    expect(helpListsStatus(CODEX_LOGIN_HELP.replace(/\n/g, '\r\n'))).toBe(true);
  });

  it('does not read one into an old CLI’s general help or prose', () => {
    // An old Claude Code prints its general help for `claude auth --help`.
    const general = [
      'Usage: claude [options] [command] [prompt]',
      '',
      'Claude Code - starts an interactive session by default; it can run git status.',
      '',
      'Arguments:',
      '  prompt                Your prompt',
      '',
      'Options:',
      '  status                (an option line that starts with status)',
      '',
      'Commands:',
      '  config                Manage configuration',
      '  mcp                   Configure and manage MCP servers, and show their',
      '                        status',
      '  doctor                Check the health of your installation',
    ].join('\n');
    expect(helpListsStatus(general)).toBe(false);
    // An older Codex: `login` without subcommands.
    const oldCodex = [
      'Manage login',
      '',
      'Usage: codex login [OPTIONS]',
      '',
      'Options:',
      '      --api-key <API_KEY>  status of the key is not checked',
      '  -h, --help               Print help',
    ].join('\n');
    expect(helpListsStatus(oldCodex)).toBe(false);
    expect(helpListsStatus('')).toBe(false);
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
    // The help probe before it ran the same way, in the same folder.
    const help = signedIn.helpRecord();
    expect(help.argv).toEqual(['auth', '--help']);
    expect(help.cwd).toBe(record.cwd);
    expect(help.cwdEntries).toEqual([]);
    for (const key of SECRET_KEYS) expect(help.env[key]).toBeUndefined();
    expect(help.env.TMPDIR).toBe(record.cwd);

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
    const help = signedIn.helpRecord();
    expect(help.argv).toEqual(['login', '--help']);
    for (const key of SECRET_KEYS) expect(help.env[key]).toBeUndefined();
    expect(help.codexHome).toEqual({ entries: ['auth.json'], auth });

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
      // Its help is asked once per binary, locked down like the rest.
      expect(old.helpCalls()).toBe(1);
      for (const key of SECRET_KEYS) expect(old.helpRecord().env[key]).toBeUndefined();
      expect(existsSync(old.helpRecord().cwd)).toBe(false);
    }
  });

  it('keeps each CLI’s help answer apart when one shim file starts both', async () => {
    // A version manager (Volta, mise) links every tool to one shim, which
    // picks the tool by the name it was started as. Here Codex is current and
    // Claude Code is old: its `auth status` would be a prompt.
    const dir = mkdtempSync(path.join(tmpdir(), 'examify-shim-'));
    const shim = path.join(dir, 'shim');
    writeFileSync(
      shim,
      `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2).join(' ');
fs.appendFileSync(path.join(${JSON.stringify(dir)}, 'calls'), tool + ' ' + args + '\\n');
if (tool === 'codex' && args === 'login --help') { process.stdout.write('Commands:\\n  status  Show login status\\n'); process.exit(0); }
if (tool === 'codex' && args === 'login status') { process.stderr.write('Not logged in\\n'); process.exit(1); }
if (tool === 'claude' && args === 'auth --help') { process.stdout.write('Usage: claude [prompt]\\n\\nCommands:\\n  config  Manage configuration\\n'); process.exit(0); }
fs.appendFileSync(path.join(${JSON.stringify(dir)}, 'prompt-runs'), args + '\\n');
process.exit(1);
`,
    );
    chmodSync(shim, 0o755);
    mkdirSync(path.join(dir, 'bin'));
    symlinkSync(shim, path.join(dir, 'bin', 'claude'));
    symlinkSync(shim, path.join(dir, 'bin', 'codex'));
    const env = hostEnv({
      EXAMIFY_CLAUDE_BIN: path.join(dir, 'bin', 'claude'),
      EXAMIFY_CODEX_BIN: path.join(dir, 'bin', 'codex'),
    });
    await expect(checkAgentCliSignIn('codex', env)).resolves.toBe('signed_out');
    await expect(checkAgentCliSignIn('claude', env)).resolves.toBe('unknown');
    await expect(checkAgentCliSignIn('codex', env)).resolves.toBe('signed_out');
    expect(existsSync(path.join(dir, 'prompt-runs'))).toBe(false);
    expect(readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n')).toEqual([
      'codex login --help',
      'codex login status',
      'claude auth --help',
      'codex login status',
    ]);
  });

  it('keeps no answer from a help probe that failed, and asks again', async () => {
    const claude = fakeCli('claude', { mode: 'hang', signIn: 'help-fails' });
    const env = hostEnv({ EXAMIFY_CLAUDE_BIN: claude.bin });
    await expect(checkAgentCliSignIn('claude', env)).resolves.toBe('unknown');
    expect(claude.statusCalls()).toBe(0);
    // It can start now (say, a newer node on the service PATH): signed out is seen.
    claude.setSignIn('out');
    await expect(checkAgentCliSignIn('claude', env)).resolves.toBe('signed_out');
    expect([claude.helpCalls(), claude.statusCalls()]).toEqual([2, 1]);
  });

  it('asks the help again after a while, for a CLI upgraded behind the same file', async () => {
    const codex = fakeCli('codex', { mode: 'hang', signIn: 'old' });
    const env = hostEnv({ EXAMIFY_CODEX_BIN: codex.bin });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await expect(checkAgentCliSignIn('codex', env)).resolves.toBe('unknown');
      codex.setSignIn('out');
      vi.setSystemTime(Date.now() + AGENT_CLI_PROBE_CACHE_MS - 1_000);
      await expect(checkAgentCliSignIn('codex', env)).resolves.toBe('unknown');
      expect(codex.helpCalls()).toBe(1);
      vi.setSystemTime(Date.now() + 1_000);
      await expect(checkAgentCliSignIn('codex', env)).resolves.toBe('signed_out');
      expect(codex.helpCalls()).toBe(2);
    } finally {
      vi.useRealTimers();
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
    const hang = await warmedFake('claude', 'hang');
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
    const orphan = await warmedFake('codex', 'orphan');
    const pidFile = path.join(orphan.dir, 'orphan.pid');
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
      const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : 0;
      if (pid > 0) process.kill(pid, 'SIGKILL');
    }
  });

  it('copies a sign-in Codex refreshed during its check back, and creates none', async () => {
    const userHome = mkdtempSync(path.join(tmpdir(), 'examify-codex-home-'));
    writeFileSync(path.join(userHome, 'auth.json'), '{"tokens":{"refresh_token":"r1"}}');
    const refreshed = '{"tokens":{"refresh_token":"r2"}}';
    const fake = fakeCli('codex', { mode: 'hang', signIn: 'in', refreshAuth: refreshed });
    await expect(
      checkAgentCliSignIn('codex', hostEnv({ EXAMIFY_CODEX_BIN: fake.bin, CODEX_HOME: userHome })),
    ).resolves.toBe('signed_in');
    expect(readFileSync(path.join(userHome, 'auth.json'), 'utf8')).toBe(refreshed);

    const empty = mkdtempSync(path.join(tmpdir(), 'examify-codex-home-'));
    await expect(
      checkAgentCliSignIn('codex', hostEnv({ EXAMIFY_CODEX_BIN: fake.bin, CODEX_HOME: empty })),
    ).resolves.toBe('signed_in');
    expect(existsSync(path.join(empty, 'auth.json'))).toBe(false);
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
