import type { BankIR } from '../schema';
import {
  AGENT_CLI_DEFAULT_MODEL,
  AGENT_CLI_MAX_BUFFER,
  AGENT_CLI_MODEL_ENV,
  CLI_AUTH_HINT,
  agentCliEnv,
  agentCliHomeOutsideCheckout,
  agentCliModelArgs,
  cliDetail,
  parseJsonLines,
  requireAgentCliBinary,
  withAgentCliWorkDir,
} from './agent-cli';
import { buildAnthropicContent } from './anthropic';
import { runProviderCommand } from './command';
import {
  CLI_PROVIDER_TIMEOUT_MS,
  ProviderFailureError,
  parseProviderBankIr,
  type GenerateProvider,
  type ProviderDeps,
  type ProviderRequest,
} from './types';

/**
 * `claude -p` (Claude Code, signed in with the household's own Claude plan).
 * The request is one stream-json user message with the same content blocks as
 * the Anthropic API provider (text, PDFs as documents, images), so PDFs need
 * no rasterizer. `--tools ""` leaves the model no tools at all: it cannot
 * read, write or run anything, or fetch the web. `--system-prompt` replaces
 * Claude Code's coding-agent prompt; `--strict-mcp-config` loads no MCP
 * servers. `--setting-sources project` skips the service user's own settings
 * and CLAUDE.md (a user hook would otherwise get the untrusted study text on
 * stdin), and the project is the empty private folder the run happens in, so
 * no project CLAUDE.md or settings apply either; `CLAUDE_CODE_SAFE_MODE=1`
 * (agent-cli.ts) also turns off plugins and skills. Not saved as a session.
 */
export function claudeCliArgs(request: Pick<ProviderRequest, 'prompt' | 'model'>): string[] {
  return [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--tools',
    '',
    '--strict-mcp-config',
    '--setting-sources',
    'project',
    '--no-session-persistence',
    '--system-prompt',
    request.prompt,
    ...agentCliModelArgs(request.model, '--model'),
  ];
}

/** One stream-json user message carrying Anthropic content blocks. */
export function claudeCliStdin(content: readonly unknown[]): string {
  const message = { type: 'user', message: { role: 'user', content } };
  return `${JSON.stringify(message)}\n`;
}

type ClaudeResult = {
  subtype?: unknown;
  is_error?: unknown;
  api_error_status?: unknown;
  result?: unknown;
};

/** The last `result` event of a stream-json run, if any. */
export function claudeResultEvent(stdout: string): ClaudeResult | null {
  const events = parseJsonLines(stdout).filter((event) => event.type === 'result');
  return (events[events.length - 1] as ClaudeResult | undefined) ?? null;
}

/** One locked-down `claude -p` run: a system prompt, content blocks, and the model. */
export type ClaudeCliTextRequest = {
  systemPrompt: string;
  content: readonly unknown[];
  model: string;
  env: ProviderDeps['env'];
  signal?: AbortSignal;
  timeoutMs: number;
};

/**
 * Run `claude -p` with everything above (no tools, no user settings, safe
 * mode, a private run folder, the env allowlist) and return the final
 * `result` text. Failures are typed `ProviderFailureError`s; a missing CLI is a
 * `CliNotFoundError`. Generate parses BankIR from the text; marking parses
 * verdicts.
 */
export async function runClaudeCliText(request: ClaudeCliTextRequest): Promise<string> {
  const bin = requireAgentCliBinary('claude', request.env);
  agentCliHomeOutsideCheckout('claude', request.env);
  const { status, stdout, stderrTail } = await withAgentCliWorkDir('claude', (dir) =>
    runProviderCommand({
      cmd: bin,
      args: claudeCliArgs({ prompt: request.systemPrompt, model: request.model }),
      stdin: claudeCliStdin(request.content),
      label: 'claude',
      userSignal: request.signal,
      timeoutMs: request.timeoutMs,
      cwd: dir,
      env: agentCliEnv(request.env, 'claude', dir),
      maxBuffer: AGENT_CLI_MAX_BUFFER,
      captureStderr: true,
    }),
  );
  const result = claudeResultEvent(stdout);
  if (!result) {
    const detail = cliDetail(stderrTail);
    if (CLI_AUTH_HINT.test(stderrTail)) {
      throw new ProviderFailureError(
        'auth',
        `claude is not signed in for this user (${detail}); run claude once as this user and sign in`,
      );
    }
    throw new ProviderFailureError(
      'command',
      `claude exited ${status ?? 'null'} without a result${detail ? ` (${detail})` : ''}`,
    );
  }
  const text = typeof result.result === 'string' ? result.result : '';
  if (result.is_error === true || result.subtype !== 'success') {
    const detail = cliDetail(text || String(result.subtype ?? ''));
    const httpStatus =
      typeof result.api_error_status === 'number' ? result.api_error_status : undefined;
    if (httpStatus) {
      throw new ProviderFailureError(
        'http',
        `claude: the API returned HTTP ${httpStatus}${detail ? ` (${detail})` : ''}`,
        { status: httpStatus },
      );
    }
    if (CLI_AUTH_HINT.test(detail)) {
      throw new ProviderFailureError(
        'auth',
        `claude is not signed in for this user (${detail}); run claude once as this user and sign in`,
      );
    }
    throw new ProviderFailureError(
      'command',
      `claude reported an error${detail ? `: ${detail}` : ''}`,
    );
  }
  if (!text.trim()) throw new ProviderFailureError('output', 'claude returned no text');
  return text;
}

/** Generate: one `claude -p` run over the sources, parsed as BankIR. */
async function callClaudeCli(request: ProviderRequest, deps: ProviderDeps): Promise<BankIR> {
  const text = await runClaudeCliText({
    systemPrompt: request.prompt,
    content: buildAnthropicContent(request),
    model: request.model,
    env: deps.env,
    signal: deps.signal,
    timeoutMs: CLI_PROVIDER_TIMEOUT_MS,
  });
  return parseProviderBankIr(text);
}

export const claudeCliProvider: GenerateProvider = {
  id: 'claude-cli',
  defaultModel: AGENT_CLI_DEFAULT_MODEL,
  modelEnv: AGENT_CLI_MODEL_ENV.claude,
  keyEnv: null,
  seedHonored: false,
  requireReady: (env) => {
    requireAgentCliBinary('claude', env);
  },
  generate: callClaudeCli,
};
