import 'server-only';

/* ============================================================================
   EXAMIFY — GRADING: NON-ANTHROPIC BACKENDS (server-only)
   ----------------------------------------------------------------------------
   The household's AI mode marks its written answers (`markingBackendForAiMode`):
   - OpenAI: one Chat Completions call per answer with the live
     `OPENAI_API_KEY` (same `test` sentinel rule as Anthropic), 15 s each.
   - Local endpoint: the same call to `EXAMIFY_LLM_BASE_URL` with
     `EXAMIFY_LLM_MODEL`, all answers under one 45 s deadline (a local model
     often serves one request at a time, so answers queue). No JSON mode:
     some local servers (LM Studio) refuse `response_format: json_object`
     with a 400, and the reply is parsed leniently anyway.
   - Claude Code / Codex: ONE locked-down CLI run marks every answer of the
     attempt (the same runner as generate: no tools, a private run folder, the
     env allowlist, a private CODEX_HOME), 45 s. The CLI starts once, and the
     whole submit stays under a reverse proxy's usual 60 s read timeout.
   Every failure is `needs_review` with one reason-coded warning per answer,
   exactly like the Anthropic path; nothing here throws.
   ========================================================================== */
import * as ingest from 'examify-ingest/generate';
import { forgetAgentCliSignIn } from '@/lib/agent-cli-sign-in';
import { OPENAI_ENV_KEY, envStoreSecretConfigured, getEnvStoreRoot } from '@/lib/env-store';
import type { MarkingBackend } from '@/lib/onboarding-types';
import {
  API_GRADING_TIMEOUT_MS,
  answerFence,
  batchSystemPrompt,
  batchUserPrompt,
  gradingStubAllowed,
  needsReview,
  stubGrade,
  systemPrompt,
  thrownReason,
  toVerdict,
  userPrompt,
  type GradeArgs,
  type GradeResult,
  type NeedsReviewReason,
} from './shared';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
/** Same model as generate's OpenAI provider. */
const OPENAI_MODEL = 'gpt-4o';

/** All of an attempt's answers on a local endpoint share this deadline. */
export const LOCAL_GRADING_TIMEOUT_MS = 45_000;
/** One Claude Code / Codex run marks the whole attempt within this deadline. */
export const CLI_GRADING_TIMEOUT_MS = 45_000;

type ProviderEnv = Record<string, string | undefined>;

/**
 * The env the CLIs and the local endpoint read: the host env over the repo
 * `.env` files, the same merge generate and the wizard's badges use.
 */
export function markingHostEnv(): ProviderEnv {
  return ingest.mergeRepoEnvFiles(getEnvStoreRoot(), process.env);
}

/** The live `OPENAI_API_KEY`, trimmed; blank is unset. */
function liveOpenAiKey(): string | undefined {
  const live = process.env[OPENAI_ENV_KEY];
  if (typeof live !== 'string') return undefined;
  const trimmed = live.trim();
  return trimmed === '' ? undefined : trimmed;
}

type ChatTarget = {
  url: URL | string;
  headers: Record<string, string>;
  model: string;
  signal: AbortSignal;
  backend: MarkingBackend;
  /** Ask for `response_format: json_object` (OpenAI only; see the header). */
  jsonMode: boolean;
};

/** First message's text from an OpenAI-compatible Chat Completions response. */
function firstChoiceText(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const choices = (data as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return null;
  const content = (choices[0] as { message?: { content?: unknown } } | undefined)?.message?.content;
  return typeof content === 'string' ? content : null;
}

/** Mark one answer with an OpenAI-compatible Chat Completions call; never throws. */
async function gradeViaChatCompletions(args: GradeArgs, target: ChatTarget): Promise<GradeResult> {
  try {
    const res = await fetch(target.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...target.headers },
      body: JSON.stringify({
        model: target.model,
        temperature: 0,
        max_tokens: 700,
        ...(target.jsonMode ? { response_format: { type: 'json_object' } } : {}),
        messages: [
          { role: 'system', content: systemPrompt() },
          { role: 'user', content: userPrompt(args) },
        ],
      }),
      signal: target.signal,
    });
    if (!res.ok) return needsReview(`http_${res.status}`, target.backend);
    const text = firstChoiceText(await res.json());
    if (text === null) return needsReview('bad_shape', target.backend);
    let parsed: unknown;
    try {
      parsed = ingest.extractJsonObject(text);
    } catch {
      return needsReview('bad_json', target.backend);
    }
    const verdict = toVerdict(parsed, args.maxScore);
    if (verdict === null) return needsReview('bad_shape', target.backend);
    return { status: 'graded', verdict };
  } catch (error) {
    // Classify by type/name only; a message may quote model text.
    return needsReview(thrownReason(error), target.backend);
  }
}

/** OpenAI with the live key; the `test` sentinel stubs like Anthropic's. */
export async function gradeViaOpenAi(tasks: readonly GradeArgs[]): Promise<GradeResult[]> {
  const key = liveOpenAiKey();
  if (key === 'test') {
    return tasks.map((task) =>
      gradingStubAllowed() ? stubGrade(task) : needsReview('stub_disabled_in_production', 'openai'),
    );
  }
  if (!envStoreSecretConfigured(OPENAI_ENV_KEY) || !key) {
    return tasks.map(() => needsReview('no_key', 'openai'));
  }
  return Promise.all(
    tasks.map((task) =>
      gradeViaChatCompletions(task, {
        url: OPENAI_URL,
        headers: { authorization: `Bearer ${key}` },
        model: OPENAI_MODEL,
        signal: AbortSignal.timeout(API_GRADING_TIMEOUT_MS),
        backend: 'openai',
        jsonMode: true,
      }),
    ),
  );
}

/**
 * The Chat Completions URL for an `EXAMIFY_LLM_BASE_URL` value (the same URL
 * generate's local transport builds), or `null` when it is blank or not an
 * http(s) address. The wizard and parent dashboard call the endpoint ready
 * only when this is not `null`, so a typo is never shown as marking.
 */
export function localChatCompletionsUrl(base: string | undefined): URL | null {
  const trimmed = base?.trim() ?? '';
  if (!trimmed) return null;
  try {
    const url = new URL('/v1/chat/completions', trimmed.endsWith('/') ? trimmed : `${trimmed}/`);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** The wizard's Local endpoint: `EXAMIFY_LLM_BASE_URL` + `EXAMIFY_LLM_MODEL`, no key. */
export async function gradeViaLocalEndpoint(
  tasks: readonly GradeArgs[],
  env: ProviderEnv,
): Promise<GradeResult[]> {
  const url = localChatCompletionsUrl(env.EXAMIFY_LLM_BASE_URL);
  const model = env[ingest.LOCAL_MODEL_ENV]?.trim() ?? '';
  if (!url || !model) return tasks.map(() => needsReview('no_endpoint', 'local-endpoint'));
  const signal = AbortSignal.timeout(LOCAL_GRADING_TIMEOUT_MS);
  return Promise.all(
    tasks.map((task) =>
      gradeViaChatCompletions(task, {
        url,
        headers: {},
        model,
        signal,
        backend: 'local-endpoint',
        jsonMode: false,
      }),
    ),
  );
}

/** A CLI run's typed failure → reason code (never its message). */
function cliFailureReason(error: unknown): NeedsReviewReason {
  if (error instanceof ingest.CliNotFoundError) return 'no_cli';
  if (error instanceof ingest.ProviderFailureError) {
    switch (error.kind) {
      case 'http':
        return `http_${error.status ?? 0}`;
      case 'timeout':
        return 'timeout';
      case 'auth':
        return 'cli_auth';
      case 'output':
        return 'bad_shape';
      case 'unreachable':
      case 'command':
        return 'cli_error';
    }
  }
  return 'cli_error';
}

/** The entry for answer `n` (1-based): by its `answer` number, else by position. */
function batchEntry(results: readonly unknown[], n: number, count: number): unknown {
  const numbered = results.find(
    (entry) =>
      typeof entry === 'object' && entry !== null && (entry as { answer?: unknown }).answer === n,
  );
  if (numbered !== undefined) return numbered;
  const unnumbered = results.every(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      (entry as { answer?: unknown }).answer === undefined,
  );
  return unnumbered && results.length === count ? results[n - 1] : undefined;
}

/**
 * One Claude Code / Codex run marks every answer. A run that fails marks none
 * of them; an answer missing from, or malformed in, the reply is not marked on
 * its own.
 */
export async function gradeViaAgentCli(
  tasks: readonly GradeArgs[],
  cli: ingest.AgentCli,
  env: ProviderEnv,
): Promise<GradeResult[]> {
  const backend: MarkingBackend = cli === 'claude' ? 'claude-cli' : 'codex-cli';
  const system = batchSystemPrompt();
  const user = batchUserPrompt(tasks, answerFence());
  const model = env[ingest.AGENT_CLI_MODEL_ENV[cli]]?.trim() ?? '';
  let text: string;
  try {
    text =
      cli === 'claude'
        ? await ingest.runClaudeCliText({
            systemPrompt: system,
            content: [{ type: 'text', text: user }],
            model,
            env,
            timeoutMs: CLI_GRADING_TIMEOUT_MS,
          })
        : await ingest.runCodexCliText({
            prompt: `${system}\n\n${user}`,
            images: [],
            model,
            env,
            timeoutMs: CLI_GRADING_TIMEOUT_MS,
          });
  } catch (error) {
    const reason = cliFailureReason(error);
    // Not signed in after all: the next page asks the CLI again.
    if (reason === 'cli_auth') forgetAgentCliSignIn(cli);
    return tasks.map(() => needsReview(reason, backend));
  }
  let parsed: unknown;
  try {
    parsed = ingest.extractJsonObject(text);
  } catch {
    return tasks.map(() => needsReview('bad_json', backend));
  }
  const results = (parsed as { results?: unknown }).results;
  if (!Array.isArray(results)) return tasks.map(() => needsReview('bad_shape', backend));
  return tasks.map((task, index) => {
    const verdict = toVerdict(batchEntry(results, index + 1, tasks.length), task.maxScore);
    return verdict ? { status: 'graded', verdict } : needsReview('bad_shape', backend);
  });
}
