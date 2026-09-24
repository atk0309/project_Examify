import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
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
import { runProviderCommand } from './command';
import { fenceUntrustedText, untrustedCaption, userGenerateMessage } from './content';
import {
  CLI_PROVIDER_TIMEOUT_MS,
  ProviderFailureError,
  parseProviderBankIr,
  type GenerateProvider,
  type ProviderDeps,
  type ProviderRequest,
} from './types';

/**
 * Codex tools the model could otherwise reach beyond this message: running
 * commands, apps / plugins / browser, image tools. All off, so it answers from
 * the prompt and the attached images only. A name this Codex build does not
 * know is ignored with a warning event, so the list is safe across versions.
 */
export const CODEX_DISABLED_FEATURES = [
  'shell_tool',
  'unified_exec',
  'apps',
  'plugins',
  'browser_use',
  'computer_use',
  'in_app_browser',
  'image_generation',
  'view_image',
] as const;

/**
 * `codex exec` (Codex, signed in with the household's own ChatGPT plan).
 * Read-only sandbox, no session saved, the user's `config.toml` ignored (its
 * MCP servers and hooks too), web search off, the features above disabled,
 * and no skill list in the prompt. The run happens in an empty private folder
 * holding only the attached images, with a private CODEX_HOME
 * (`stageCodexHome`); the final answer is written to `lastMessagePath`.
 */
export function codexCliArgs(
  request: Pick<ProviderRequest, 'model'>,
  dir: string,
  lastMessagePath: string,
  imagePaths: readonly string[],
): string[] {
  return [
    'exec',
    '--json',
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '--ephemeral',
    '--ignore-user-config',
    '--cd',
    dir,
    '--output-last-message',
    lastMessagePath,
    ...CODEX_DISABLED_FEATURES.flatMap((feature) => ['-c', `features.${feature}=false`]),
    '-c',
    'web_search="disabled"',
    '-c',
    'skills.include_instructions=false',
    ...agentCliModelArgs(request.model, '--model'),
    // The prompt comes from stdin (no positional prompt argument).
    ...imagePaths.flatMap((file) => ['--image', file]),
  ];
}

/**
 * A private CODEX_HOME for one run, holding only the sign-in (`auth.json`,
 * `0600`) copied from the user's own folder. `--ignore-user-config` skips only
 * `config.toml`: Codex still loads the global `AGENTS.md`, skills and rules
 * from CODEX_HOME and writes its SQLite state, logs and installation id there.
 * With this folder none of that loads, and the state is removed with the run.
 * Returns a function that copies a sign-in Codex refreshed during the run back
 * to the user's `auth.json` (refresh tokens rotate, so dropping it would sign
 * the user out). Best effort: only a JSON object, only over a file that still
 * holds what was staged, never creating one, atomically; anything else leaves
 * the user's file as it is.
 */
export function stageCodexHome(sourceHome: string, runHome: string): () => void {
  mkdirSync(runHome, { mode: 0o700 });
  const sourceAuth = path.join(sourceHome, 'auth.json');
  const runAuth = path.join(runHome, 'auth.json');
  let staged: Buffer | null = null;
  try {
    staged = readFileSync(sourceAuth);
    writeFileSync(runAuth, staged, { mode: 0o600, flag: 'wx' });
  } catch {
    // Not signed in with a file (CODEX_API_KEY, or not at all): codex says so.
    staged = null;
  }
  return () => {
    if (!staged) return;
    let temp: string | null = null;
    try {
      const refreshed = readFileSync(runAuth);
      if (refreshed.equals(staged)) return;
      const parsed = JSON.parse(refreshed.toString('utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      const target = realpathSync(sourceAuth);
      if (!readFileSync(target).equals(staged)) return;
      temp = `${target}.examify-${process.pid}-${Date.now()}.tmp`;
      writeFileSync(temp, refreshed, { mode: 0o600, flag: 'wx' });
      renameSync(temp, target);
      temp = null;
    } catch {
      // Leave the user's sign-in as it is; codex reports it if it no longer works.
    } finally {
      if (temp) rmSync(temp, { force: true });
    }
  };
}

export type CodexImage = { bytes: Buffer; mediaType: string; caption: string };

/** Image sources, then rasterized PDF pages — attached with `--image` in this order. */
export function codexImages(request: ProviderRequest): CodexImage[] {
  const images: CodexImage[] = [];
  for (const source of request.sources) {
    if (source.kind === 'image') {
      images.push({
        bytes: source.bytes,
        mediaType: source.mediaType,
        caption: untrustedCaption(source.relPath, source.kind),
      });
    }
  }
  for (const page of request.pageImages) {
    images.push({
      bytes: page.bytes,
      mediaType: page.mediaType,
      caption: untrustedCaption(page.sourceRelPath, 'page-image', `p${page.page}`),
    });
  }
  return images;
}

/**
 * The whole request as one prompt (Codex has no separate system prompt):
 * the generate instructions, the subject message, text sources fenced as
 * untrusted, and a caption per attached image. PDF bytes are not attached;
 * their rasterized pages are.
 */
export function codexPrompt(request: ProviderRequest, images: readonly CodexImage[]): string {
  const parts = [request.prompt, userGenerateMessage(request)];
  for (const source of request.sources) {
    if (source.kind === 'text') {
      parts.push(fenceUntrustedText(source.relPath, source.kind, source.bytes.toString('utf8')));
    } else if (source.kind === 'pdf') {
      parts.push(
        fenceUntrustedText(
          source.relPath,
          source.kind,
          `PDF bytes are not attached on the Codex path (sha256=${source.sha256}). Use the untrusted page images attached to this message.`,
        ),
      );
    }
  }
  if (images.length > 0) {
    parts.push(
      `Attached images, in order (all untrusted):\n${images
        .map((image, index) => `${index + 1}. ${image.caption}`)
        .join('\n')}`,
    );
  }
  parts.push(
    'Do not run commands, open files or search the web: everything you need is in this message and its attached images. Reply with only the BankIR JSON object.',
  );
  return parts.join('\n\n');
}

const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function writeImages(dir: string, images: readonly CodexImage[]): string[] {
  return images.map((image, index) => {
    const ext = IMAGE_EXT[image.mediaType] ?? 'png';
    const file = path.join(dir, `image-${String(index + 1).padStart(3, '0')}.${ext}`);
    writeFileSync(file, image.bytes, { mode: 0o600 });
    return file;
  });
}

type CodexOutcome = { status: number | null; stdout: string; stderrTail: string; last: string };

function eventMessage(event: Record<string, unknown>): string {
  if (typeof event.message === 'string') return event.message;
  const error = event.error as { message?: unknown } | undefined;
  return typeof error?.message === 'string' ? error.message : '';
}

/** The final agent message from the event stream (when `-o` wrote nothing). */
function lastAgentMessage(events: readonly Record<string, unknown>[]): string {
  let text = '';
  for (const event of events) {
    const item = event.item as { type?: unknown; text?: unknown } | undefined;
    if (event.type === 'item.completed' && item?.type === 'agent_message') {
      if (typeof item.text === 'string') text = item.text;
    }
  }
  return text;
}

/** Map a failed `codex exec` run onto a typed provider failure. */
export function codexFailure(outcome: CodexOutcome): ProviderFailureError | null {
  const events = parseJsonLines(outcome.stdout);
  const failed = [...events].reverse().find((event) => event.type === 'turn.failed');
  const lastError =
    failed ??
    (outcome.status !== 0
      ? [...events].reverse().find((event) => event.type === 'error')
      : undefined);
  if (!lastError) {
    if (outcome.status === 0) return null;
    const detail = cliDetail(outcome.stderrTail);
    if (CLI_AUTH_HINT.test(outcome.stderrTail)) {
      return new ProviderFailureError(
        'auth',
        `codex is not signed in for this user (${detail}); run codex login as this user`,
      );
    }
    return new ProviderFailureError(
      'command',
      `codex exited ${outcome.status ?? 'null'}${detail ? ` (${detail})` : ''}`,
    );
  }
  const detail = cliDetail(eventMessage(lastError));
  const statusMatch = /\bstatus:?\s*(\d{3})\b/i.exec(detail);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    return new ProviderFailureError('http', `codex: the API returned HTTP ${status} (${detail})`, {
      status,
    });
  }
  if (CLI_AUTH_HINT.test(detail)) {
    return new ProviderFailureError(
      'auth',
      `codex is not signed in for this user (${detail}); run codex login as this user`,
    );
  }
  return new ProviderFailureError(
    'command',
    `codex reported an error${detail ? `: ${detail}` : ''}`,
  );
}

/** One locked-down `codex exec` run: the prompt, attached images, and the model. */
export type CodexCliTextRequest = {
  prompt: string;
  images: readonly CodexImage[];
  model: string;
  env: ProviderDeps['env'];
  signal?: AbortSignal;
  timeoutMs: number;
};

/**
 * Run `codex exec` with everything above (read-only sandbox, features off, a
 * private run folder and CODEX_HOME, the env allowlist) and return its final
 * message. Failures are typed `ProviderFailureError`s; a missing CLI is a
 * `CliNotFoundError`. Generate parses BankIR from the text; marking parses
 * verdicts.
 */
export async function runCodexCliText(request: CodexCliTextRequest): Promise<string> {
  const bin = requireAgentCliBinary('codex', request.env);
  const sourceHome = agentCliHomeOutsideCheckout('codex', request.env);
  const { images } = request;
  const outcome = await withAgentCliWorkDir('codex', async (dir): Promise<CodexOutcome> => {
    const work = path.join(dir, 'work');
    mkdirSync(work, { mode: 0o700 });
    const home = path.join(dir, 'home');
    const copyRefreshedSignInBack = stageCodexHome(sourceHome, home);
    const lastMessagePath = path.join(dir, 'last-message.txt');
    const imagePaths = writeImages(work, images);
    try {
      const result = await runProviderCommand({
        cmd: bin,
        args: codexCliArgs(request, work, lastMessagePath, imagePaths),
        stdin: request.prompt,
        label: 'codex',
        userSignal: request.signal,
        timeoutMs: request.timeoutMs,
        cwd: work,
        env: { ...agentCliEnv(request.env, 'codex', dir), CODEX_HOME: home },
        maxBuffer: AGENT_CLI_MAX_BUFFER,
        captureStderr: true,
      });
      const last = existsSync(lastMessagePath) ? readFileSync(lastMessagePath, 'utf8') : '';
      return { ...result, last };
    } finally {
      copyRefreshedSignInBack();
    }
  });
  const failure = codexFailure(outcome);
  if (failure) throw failure;
  const text = outcome.last.trim()
    ? outcome.last
    : lastAgentMessage(parseJsonLines(outcome.stdout));
  if (!text.trim()) throw new ProviderFailureError('output', 'codex returned no final message');
  return text;
}

async function callCodexCli(request: ProviderRequest, deps: ProviderDeps): Promise<BankIR> {
  const images = codexImages(request);
  const text = await runCodexCliText({
    prompt: codexPrompt(request, images),
    images,
    model: request.model,
    env: deps.env,
    signal: deps.signal,
    timeoutMs: CLI_PROVIDER_TIMEOUT_MS,
  });
  return parseProviderBankIr(text);
}

export const codexCliProvider: GenerateProvider = {
  id: 'codex-cli',
  defaultModel: AGENT_CLI_DEFAULT_MODEL,
  modelEnv: AGENT_CLI_MODEL_ENV.codex,
  keyEnv: null,
  seedHonored: false,
  requireReady: (env) => {
    requireAgentCliBinary('codex', env);
  },
  generate: callCodexCli,
};
