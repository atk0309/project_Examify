import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BankIR } from '../../tools/examify-ingest/src/index';
import {
  AGENT_CLI_BIN_ENV,
  CLI_PROVIDER_TIMEOUT_MS,
  CliNotFoundError,
  GenerateAbortedError,
  ProviderFailureError,
  UnreadableSourcesError,
  assertReadableProviderInput,
  generateSubject,
  loadGeneratePrompt,
  resolveAgentCliBinary,
  resolveSubjectSources,
} from '../../tools/examify-ingest/src/generate-api';
import { runProviderCommand } from '../../tools/examify-ingest/src/providers/command';
import { agentCliEnv, agentCliTempRoot } from '../../tools/examify-ingest/src/providers/agent-cli';
import { claudeResultEvent } from '../../tools/examify-ingest/src/providers/claude-cli';
import {
  CODEX_DISABLED_FEATURES,
  codexFailure,
} from '../../tools/examify-ingest/src/providers/codex-cli';
import { fakeCli } from '../helpers/fake-agent-cli';

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function plantsBank(): BankIR {
  return {
    version: 1,
    subject: { id: 'plants', label: 'Plants', icon: 'biology', l: 0.58, c: 0.09, h: 142 },
    difficulties: {
      easy: [
        {
          id: 'plants-easy-1',
          type: 'mcq',
          q: 'What do chloroplasts make?',
          choices: ['Sugar', 'Stone', 'Iron', 'Salt'],
          answer: 0,
          provenance: { pdf: 'notes.txt', locator: 'p1' },
        },
      ],
      medium: [],
      hard: [],
    },
  };
}

/** Temp family-style root with one subject: notes, a PDF, optionally an image. */
function plantsRoot(options: { notes?: boolean; pdf?: boolean; image?: boolean } = {}): string {
  const { notes = true, pdf = true, image = false } = options;
  const root = mkdtempSync(path.join(tmpdir(), 'examify-agent-cli-'));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'project-examify' }));
  mkdirSync(path.join(root, 'content/subjects/plants'), { recursive: true });
  mkdirSync(path.join(root, 'content/source-pdfs/plants'), { recursive: true });
  writeFileSync(
    path.join(root, 'content/subjects/plants/subject.json'),
    `${JSON.stringify(plantsBank().subject)}\n`,
  );
  if (notes) {
    writeFileSync(
      path.join(root, 'content/subjects/plants/notes.txt'),
      'Chloroplasts make sugar.\n',
    );
  }
  if (pdf) {
    writeFileSync(
      path.join(root, 'content/source-pdfs/plants/leaf.pdf'),
      '%PDF-1.4\n% leaf study notes\n%%EOF\n',
    );
  }
  if (image) {
    writeFileSync(path.join(root, 'content/subjects/plants/diagram.png'), PNG_1PX);
  }
  return root;
}

/** Env the providers get: this machine's PATH (for node) plus secrets that must not leak. */
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

async function generatePlants(
  provider: 'claude-cli' | 'codex-cli',
  env: { [key: string]: string | undefined },
  root = plantsRoot(),
  signal?: AbortSignal,
) {
  const subjectDir = path.join(root, 'content/subjects/plants');
  return generateSubject({
    repoRoot: root,
    subject: plantsBank().subject,
    subjectDir,
    sources: resolveSubjectSources(root, 'plants', subjectDir),
    provider,
    seed: 0,
    env,
    dryRunIr: true,
    rasterize: () => false,
    ...(signal ? { signal } : {}),
  });
}

const SECRET_KEYS = [
  'AUTH_SECRET',
  'SETUP_BOOTSTRAP_SECRET',
  'SMTP_PASS',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
];

describe('agent CLI binaries', () => {
  it('finds the CLI on PATH, then in ~/.local/bin, and honours an absolute EXAMIFY_*_BIN', () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'examify-empty-path-'));
    const home = mkdtempSync(path.join(tmpdir(), 'examify-home-'));
    expect(resolveAgentCliBinary('claude', { PATH: empty, HOME: home })).toBeNull();

    const onPath = fakeCli('claude', { mode: 'hang' });
    expect(
      resolveAgentCliBinary('claude', { PATH: `${empty}${path.delimiter}${onPath.dir}` }),
    ).toBe(onPath.bin);

    mkdirSync(path.join(home, '.local/bin'), { recursive: true });
    const local = path.join(home, '.local/bin/codex');
    writeFileSync(local, '#!/bin/sh\n');
    chmodSync(local, 0o755);
    expect(resolveAgentCliBinary('codex', { PATH: empty, HOME: home })).toBe(local);

    expect(
      resolveAgentCliBinary('claude', { PATH: empty, HOME: home, EXAMIFY_CLAUDE_BIN: onPath.bin }),
    ).toBe(onPath.bin);
    // A relative path is not trusted (relative to what?), nor a missing file.
    expect(
      resolveAgentCliBinary('claude', { PATH: empty, HOME: home, EXAMIFY_CLAUDE_BIN: './claude' }),
    ).toBeNull();
    expect(
      resolveAgentCliBinary('claude', {
        PATH: empty,
        HOME: home,
        EXAMIFY_CLAUDE_BIN: path.join(empty, 'claude'),
      }),
    ).toBeNull();
  });

  it('skips a non-executable file with the CLI name', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'examify-noexec-'));
    writeFileSync(path.join(dir, 'claude'), 'not a program');
    chmodSync(path.join(dir, 'claude'), 0o644);
    const home = mkdtempSync(path.join(tmpdir(), 'examify-home-'));
    expect(resolveAgentCliBinary('claude', { PATH: dir, HOME: home })).toBeNull();
  });

  it('refuses before any spawn when the CLI is missing (CliNotFoundError names the setting)', async () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'examify-empty-path-'));
    const home = mkdtempSync(path.join(tmpdir(), 'examify-home-'));
    for (const provider of ['claude-cli', 'codex-cli'] as const) {
      const error = await generatePlants(provider, { PATH: empty, HOME: home }).catch((e) => e);
      expect(error).toBeInstanceOf(CliNotFoundError);
      const cli = provider === 'claude-cli' ? 'claude' : 'codex';
      expect((error as CliNotFoundError).cli).toBe(cli);
      expect((error as Error).message).toContain(AGENT_CLI_BIN_ENV[cli]);
    }
  });

  it('passes only allowlisted env: none of Examify’s secrets, plus the CLI’s own sign-in', () => {
    const env = hostEnv({
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
      CLAUDE_CONFIG_DIR: '/srv/claude',
      CODEX_HOME: '/srv/codex',
      HTTPS_PROXY: 'http://proxy:3128',
    });
    const claude = agentCliEnv(env, 'claude');
    const codex = agentCliEnv(env, 'codex');
    for (const key of SECRET_KEYS) {
      expect(claude).not.toHaveProperty(key);
      expect(codex).not.toHaveProperty(key);
    }
    expect(claude).toMatchObject({
      PATH: process.env.PATH,
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
      CLAUDE_CONFIG_DIR: '/srv/claude',
      HTTPS_PROXY: 'http://proxy:3128',
      DISABLE_AUTOUPDATER: '1',
      // No user CLAUDE.md, hooks, plugins, skills or MCP servers.
      CLAUDE_CODE_SAFE_MODE: '1',
    });
    expect(claude).not.toHaveProperty('CODEX_HOME');
    expect(codex).toMatchObject({ CODEX_HOME: '/srv/codex', HTTPS_PROXY: 'http://proxy:3128' });
    expect(codex).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(codex).not.toHaveProperty('CLAUDE_CODE_SAFE_MODE');
  });
});

describe('claude-cli provider', () => {
  it('runs claude -p with no tools, the generate prompt, and PDFs as documents', async () => {
    const fake = fakeCli('claude', { mode: 'success', text: JSON.stringify(plantsBank()) });
    const result = await generatePlants(
      'claude-cli',
      hostEnv({ EXAMIFY_CLAUDE_BIN: fake.bin, CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token' }),
    );
    expect(result.bank.difficulties.easy[0]?.id).toBe('plants-easy-1');
    expect(result.manifest).toMatchObject({
      provider: 'claude-cli',
      model: 'default',
      keyEnv: null,
      hasApiKey: false,
      seedHonored: false,
    });
    expect(result.wroteIr).toBe(false);

    const record = fake.record();
    const args = record.argv;
    expect(args.slice(0, 6)).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
    ]);
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).toContain('--strict-mcp-config');
    // The service user's own settings (hooks) and CLAUDE.md stay out.
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('project');
    expect(args).toContain('--no-session-persistence');
    expect(args[args.indexOf('--system-prompt') + 1]).toBe(loadGeneratePrompt().text);
    expect(args).not.toContain('--model');

    // An empty private folder, removed afterwards — never the checkout.
    expect(record.cwdEntries).toEqual([]);
    expect(path.basename(record.cwd)).toMatch(/^examify-claude-/);
    expect(existsSync(record.cwd)).toBe(false);

    for (const key of SECRET_KEYS) expect(record.env).not.toHaveProperty(key);
    expect(record.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-token');
    expect(record.env.CLAUDE_CODE_SAFE_MODE).toBe('1');

    const message = JSON.parse(record.stdin.trim()) as {
      type: string;
      message: { role: string; content: { type: string; text?: string; source?: unknown }[] };
    };
    expect(message.type).toBe('user');
    expect(message.message.role).toBe('user');
    const blocks = message.message.content;
    expect(blocks.some((block) => block.type === 'document')).toBe(true);
    expect(JSON.stringify(blocks)).toContain('Chloroplasts make sugar');
    expect(JSON.stringify(blocks)).toContain('BEGIN UNTRUSTED SOURCE MATERIAL');
  });

  it('passes EXAMIFY_CLAUDE_MODEL as --model, and --model wins over it', async () => {
    const fake = fakeCli('claude', { mode: 'success', text: JSON.stringify(plantsBank()) });
    const env = hostEnv({ EXAMIFY_CLAUDE_BIN: fake.bin, EXAMIFY_CLAUDE_MODEL: 'sonnet' });
    const fromEnv = await generatePlants('claude-cli', env);
    expect(fromEnv.manifest.model).toBe('sonnet');
    expect(fake.record().argv.slice(-2)).toEqual(['--model', 'sonnet']);

    const root = plantsRoot();
    const subjectDir = path.join(root, 'content/subjects/plants');
    const explicit = await generateSubject({
      repoRoot: root,
      subject: plantsBank().subject,
      subjectDir,
      sources: resolveSubjectSources(root, 'plants', subjectDir),
      provider: 'claude-cli',
      model: 'opus',
      seed: 0,
      env,
      dryRunIr: true,
      rasterize: () => false,
    });
    expect(explicit.manifest.model).toBe('opus');
    expect(fake.record().argv.slice(-2)).toEqual(['--model', 'opus']);
  });

  it('reads a PDF-only subject (no rasterizer needed)', () => {
    const pdf = {
      relPath: 'content/source-pdfs/plants/leaf.pdf',
      kind: 'pdf' as const,
      sha256: 'x',
      mediaType: 'application/pdf',
      bytes: Buffer.from('%PDF-1.4'),
    };
    expect(() => assertReadableProviderInput('claude-cli', {}, [pdf as never], [])).not.toThrow();
    expect(() => assertReadableProviderInput('codex-cli', {}, [pdf as never], [])).toThrow(
      UnreadableSourcesError,
    );
    expect(() => assertReadableProviderInput('codex-cli', {}, [pdf as never], [])).toThrow(
      /Codex generate cannot read PDF bytes/,
    );
  });

  it('maps an API error status to an http failure', async () => {
    const fake = fakeCli('claude', { mode: 'api-error', status: 429 });
    const error = await generatePlants(
      'claude-cli',
      hostEnv({ EXAMIFY_CLAUDE_BIN: fake.bin }),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderFailureError);
    expect(error).toMatchObject({ kind: 'http', status: 429 });
  });

  it('maps "not logged in" to an auth failure', async () => {
    const fake = fakeCli('claude', { mode: 'not-signed-in' });
    const error = await generatePlants(
      'claude-cli',
      hostEnv({ EXAMIFY_CLAUDE_BIN: fake.bin }),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderFailureError);
    expect(error).toMatchObject({ kind: 'auth' });
    expect((error as Error).message).toMatch(/not signed in/);
  });

  it('names the CLI’s own stderr when it exits without a result (e.g. too old for a flag)', async () => {
    const fake = fakeCli('claude', {
      mode: 'crash',
      stderr: "error: unknown option '--tools'",
      code: 1,
    });
    const error = await generatePlants(
      'claude-cli',
      hostEnv({ EXAMIFY_CLAUDE_BIN: fake.bin }),
    ).catch((e) => e);
    expect(error).toMatchObject({ kind: 'command' });
    expect((error as Error).message).toContain("unknown option '--tools'");
  });

  it('is an output failure when the answer is not BankIR', async () => {
    const fake = fakeCli('claude', { mode: 'success', text: 'Sorry, I cannot help with that.' });
    const error = await generatePlants(
      'claude-cli',
      hostEnv({ EXAMIFY_CLAUDE_BIN: fake.bin }),
    ).catch((e) => e);
    expect(error).toMatchObject({ kind: 'output' });
  });

  it('cancel kills the running CLI and throws GenerateAbortedError', async () => {
    const fake = fakeCli('claude', { mode: 'hang' });
    const controller = new AbortController();
    const running = generatePlants(
      'claude-cli',
      hostEnv({ EXAMIFY_CLAUDE_BIN: fake.bin }),
      plantsRoot(),
      controller.signal,
    ).catch((e) => e);
    const recordPath = path.join(fake.dir, 'record.json');
    for (let i = 0; i < 100 && !existsSync(recordPath); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    controller.abort();
    expect(await running).toBeInstanceOf(GenerateAbortedError);
    const pid = fake.record().pid;
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('reads the last result event and ignores non-JSON lines', () => {
    const stdout = [
      'warning: something',
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'first' }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'last' }),
    ].join('\n');
    expect(claudeResultEvent(stdout)?.result).toBe('last');
    expect(claudeResultEvent('not json')).toBeNull();
  });
});

describe('codex-cli provider', () => {
  it('runs codex exec read-only with tools off, images attached and the prompt on stdin', async () => {
    const fake = fakeCli('codex', { mode: 'success', text: JSON.stringify(plantsBank()) });
    const result = await generatePlants(
      'codex-cli',
      hostEnv({ EXAMIFY_CODEX_BIN: fake.bin, CODEX_HOME: '/srv/codex' }),
      plantsRoot({ image: true }),
    );
    expect(result.manifest).toMatchObject({ provider: 'codex-cli', model: 'default' });

    const record = fake.record();
    const args = record.argv;
    expect(args[0]).toBe('exec');
    expect(args).toContain('--json');
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(args).toContain('--skip-git-repo-check');
    expect(args).toContain('--ephemeral');
    expect(args).toContain('--ignore-user-config');
    expect(args[args.indexOf('--cd') + 1]).toBe(record.cwd);
    for (const feature of CODEX_DISABLED_FEATURES) {
      expect(args).toContain(`features.${feature}=false`);
    }
    expect(args).toContain('features.shell_tool=false');
    expect(args).toContain('web_search="disabled"');
    expect(args).not.toContain('--model');
    // No positional prompt: codex reads it from stdin.
    expect(args).not.toContain('-');

    expect(record.images).toHaveLength(1);
    expect(record.images?.[0]).toMatchObject({ exists: true, size: PNG_1PX.length, inCwd: true });
    expect(existsSync(record.cwd)).toBe(false);

    expect(record.stdin.startsWith(loadGeneratePrompt().text)).toBe(true);
    expect(record.stdin).toContain('Chloroplasts make sugar');
    expect(record.stdin).toContain('BEGIN UNTRUSTED SOURCE MATERIAL');
    expect(record.stdin).toContain('PDF bytes are not attached on the Codex path');
    expect(record.stdin).toContain('Attached images, in order');
    expect(record.stdin).toMatch(/Do not run commands, open files or search the web/);

    for (const key of SECRET_KEYS) expect(record.env).not.toHaveProperty(key);
    expect(record.env.CODEX_HOME).toBe('/srv/codex');
  });

  it('passes EXAMIFY_CODEX_MODEL as --model', async () => {
    const fake = fakeCli('codex', { mode: 'success', text: JSON.stringify(plantsBank()) });
    const result = await generatePlants(
      'codex-cli',
      hostEnv({ EXAMIFY_CODEX_BIN: fake.bin, EXAMIFY_CODEX_MODEL: 'gpt-5-codex' }),
    );
    expect(result.manifest.model).toBe('gpt-5-codex');
    const args = fake.record().argv;
    expect(args[args.indexOf('--model') + 1]).toBe('gpt-5-codex');
  });

  it('falls back to the last agent_message event when no final-message file was written', async () => {
    const fake = fakeCli('codex', {
      mode: 'agent-message-only',
      text: JSON.stringify(plantsBank()),
    });
    const result = await generatePlants('codex-cli', hostEnv({ EXAMIFY_CODEX_BIN: fake.bin }));
    expect(result.bank.difficulties.easy).toHaveLength(1);
  });

  it('maps turn.failed with an HTTP status, and "not logged in"', async () => {
    const http = fakeCli('codex', { mode: 'api-error', status: 401 });
    const httpError = await generatePlants(
      'codex-cli',
      hostEnv({ EXAMIFY_CODEX_BIN: http.bin }),
    ).catch((e) => e);
    expect(httpError).toMatchObject({ kind: 'http', status: 401 });

    const auth = fakeCli('codex', { mode: 'not-signed-in' });
    const authError = await generatePlants(
      'codex-cli',
      hostEnv({ EXAMIFY_CODEX_BIN: auth.bin }),
    ).catch((e) => e);
    expect(authError).toMatchObject({ kind: 'auth' });
  });

  it('names the CLI’s stderr when it exits without events', async () => {
    const fake = fakeCli('codex', {
      mode: 'crash',
      stderr: "error: unexpected argument '--ignore-user-config' found",
      code: 2,
    });
    const error = await generatePlants('codex-cli', hostEnv({ EXAMIFY_CODEX_BIN: fake.bin })).catch(
      (e) => e,
    );
    expect(error).toMatchObject({ kind: 'command' });
    expect((error as Error).message).toContain('--ignore-user-config');
  });

  it('ignores reconnect noise on a run that succeeded', () => {
    const stdout = [
      JSON.stringify({ type: 'error', message: 'Reconnecting... 1/5 (unexpected status 503)' }),
      JSON.stringify({ type: 'turn.completed' }),
    ].join('\n');
    expect(codexFailure({ status: 0, stdout, stderrTail: '', last: '{}' })).toBeNull();
  });
});

describe('provider command runner', () => {
  it('times out with the given deadline and names the command', async () => {
    const error = await runProviderCommand({
      cmd: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      stdin: '',
      label: 'claude',
      timeoutMs: 200,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderFailureError);
    expect(error).toMatchObject({ kind: 'timeout' });
    expect((error as Error).message).toBe('claude timed out after 200ms');
  });

  it('resolves with a non-zero status and the stderr tail for the caller to judge', async () => {
    const result = await runProviderCommand({
      cmd: process.execPath,
      args: [
        '-e',
        'process.stderr.write("boom\\n"); process.stdout.write("partial"); process.exit(3)',
      ],
      stdin: '',
      label: 'codex',
      captureStderr: true,
    });
    expect(result).toEqual({ status: 3, stdout: 'partial', stderrTail: 'boom\n' });
  });

  it('gives agent CLIs a longer deadline than API calls', () => {
    expect(CLI_PROVIDER_TIMEOUT_MS).toBe(600_000);
  });
});

describe('agent CLI scratch folder', () => {
  it('skips a temp folder inside an Examify checkout (judged on its realpath)', () => {
    const checkout = plantsRoot();
    const inside = path.join(checkout, 'tmp');
    mkdirSync(inside);
    const outside = mkdtempSync(path.join(tmpdir(), 'examify-tmp-'));
    expect(agentCliTempRoot([inside, outside])).toBe(realpathSync(outside));
    const link = path.join(outside, 'into-checkout');
    symlinkSync(inside, link);
    expect(agentCliTempRoot([link, outside])).toBe(realpathSync(outside));
    expect(() => agentCliTempRoot([inside, path.join(outside, 'missing')])).toThrow(
      /\(TMPDIR\) is inside the Examify checkout/,
    );
  });

  it('runs the CLI outside the checkout even when TMPDIR points into it', async () => {
    const checkout = plantsRoot();
    const inside = path.join(checkout, 'tmp');
    mkdirSync(inside);
    const fake = fakeCli('claude', { mode: 'success', text: JSON.stringify(plantsBank()) });
    const env = hostEnv({ EXAMIFY_CLAUDE_BIN: fake.bin });
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = inside;
    try {
      await generatePlants('claude-cli', env, checkout);
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
    const record = fake.record();
    expect(record.cwd.startsWith(`${realpathSync(checkout)}${path.sep}`)).toBe(false);
    expect(readdirSync(inside)).toEqual([]);
  });
});
