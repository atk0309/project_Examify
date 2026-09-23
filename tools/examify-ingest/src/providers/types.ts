import { extractJsonObject } from '../json';
import type { PageImage } from '../pages';
import { bankIrSchema, type BankIR, type BankIrSubject, type GenerateProviderId } from '../schema';
import type { ResolvedSource } from '../sources';

export class ProviderConfigError extends Error {
  readonly code: string = 'PROVIDER_CONFIG';

  constructor(message: string) {
    super(message);
    this.name = 'ProviderConfigError';
  }
}

/** The AI command-line tool a provider runs (`claude`, `codex`) is not installed where we look. */
export class CliNotFoundError extends ProviderConfigError {
  override readonly code = 'CLI_NOT_FOUND';
  readonly cli: 'claude' | 'codex';

  constructor(cli: 'claude' | 'codex', message: string) {
    super(message);
    this.name = 'CliNotFoundError';
    this.cli = cli;
  }
}

/**
 * How a configured provider failed. `http`: a non-2xx answer (`status` set).
 * `timeout`: the provider deadline. `unreachable`: no answer at all (network, or a
 * local command that could not start). `output`: an answer that is not usable
 * BankIR. `command`: a local command that exited non-zero, or an AI
 * command-line tool refused before it ran (its own folder is inside the
 * checkout). `auth`: an AI command-line tool (Claude Code, Codex) is not
 * signed in, or its sign-in was refused, with no HTTP status to report.
 */
export type ProviderFailureKind =
  'http' | 'timeout' | 'unreachable' | 'output' | 'command' | 'auth';

/** Typed provider failure so callers can react without parsing messages. CLI text is unchanged. */
export class ProviderFailureError extends Error {
  readonly code = 'PROVIDER_FAILURE';
  readonly kind: ProviderFailureKind;
  readonly status: number | undefined;

  constructor(
    kind: ProviderFailureKind,
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderFailureError';
    this.kind = kind;
    this.status = options.status;
  }
}

export function providerHttpError(label: string, status: number): ProviderFailureError {
  return new ProviderFailureError('http', `${label} returned HTTP ${status}`, { status });
}

/** Model text → BankIR. Anything unusable is an `output` failure (same message as before). */
export function parseProviderBankIr(text: string): BankIR {
  try {
    return bankIrSchema.parse(extractJsonObject(text));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProviderFailureError('output', message, { cause: error });
  }
}

/** Fail-closed cancel: generate writes no IR/cache/manifest after this. */
export class GenerateAbortedError extends Error {
  readonly code = 'GENERATE_ABORTED';

  constructor(message = 'generate aborted') {
    super(message);
    this.name = 'GenerateAbortedError';
  }
}

export type ProviderEnv = Record<string, string | undefined>;

export type ProviderRequest = {
  provider: GenerateProviderId;
  model: string;
  seed: number;
  temperature: 0;
  prompt: string;
  promptVersion: string;
  subject: BankIrSubject;
  sources: readonly ResolvedSource[];
  pageImages: readonly PageImage[];
};

export const PROVIDER_TIMEOUT_MS = 180_000;

/**
 * Claude Code / Codex deadline. An agent CLI starts up, then answers at its
 * own pace (Codex reasons before it writes), so it gets longer than an API call.
 */
export const CLI_PROVIDER_TIMEOUT_MS = 600_000;

export function providerTimeoutSignal(timeoutMs = PROVIDER_TIMEOUT_MS): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

/** Provider deadline (180s by default), optionally combined with a caller AbortSignal. */
export function providerRequestSignal(
  userSignal?: AbortSignal,
  timeoutMs = PROVIDER_TIMEOUT_MS,
): AbortSignal {
  const timeout = providerTimeoutSignal(timeoutMs);
  if (!userSignal) return timeout;
  return AbortSignal.any([userSignal, timeout]);
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof GenerateAbortedError) return true;
  return error instanceof Error && error.name === 'AbortError';
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new GenerateAbortedError();
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}

/**
 * Run the provider request. `work` is the whole exchange — the HTTP call and
 * reading its body (use {@link readProviderJson}) — because the deadline and a
 * cancel can land while the body is still arriving. A caller cancel is
 * `GenerateAbortedError`; a `ProviderFailureError` from `work` passes through;
 * the 180s deadline is a `timeout` failure; any other throw means the answer
 * never fully arrived (`unreachable`).
 */
export async function withProviderSignal<T>(
  userSignal: AbortSignal | undefined,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  throwIfAborted(userSignal);
  const signal = providerRequestSignal(userSignal);
  try {
    return await work(signal);
  } catch (error) {
    throwIfAborted(userSignal);
    if (error instanceof ProviderFailureError) throw error;
    if (signal.aborted || isTimeoutError(error)) {
      throw new ProviderFailureError(
        'timeout',
        `provider request timed out after ${PROVIDER_TIMEOUT_MS}ms`,
        { cause: error },
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ProviderFailureError('unreachable', message, { cause: error });
  }
}

/**
 * Non-2xx → `http` failure; a complete body that is not JSON → `output`
 * failure. A body that stops arriving (deadline, cancel, dropped connection)
 * rethrows as-is so {@link withProviderSignal} classifies it — call this
 * inside `work`.
 */
export async function readProviderJson<T>(res: Response, label: string): Promise<T> {
  if (!res.ok) throw providerHttpError(label, res.status);
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    // No parser text: it quotes the body.
    throw new ProviderFailureError('output', `${label} returned a body that is not JSON`, {
      cause: error,
    });
  }
}

export type ProviderDeps = {
  env: ProviderEnv;
  fetch?: typeof fetch;
  signal?: AbortSignal;
};

export type GenerateProvider = {
  id: GenerateProviderId;
  defaultModel: string;
  /** Env var naming the model when `--model` is not given (before `defaultModel`). */
  modelEnv?: string;
  /**
   * Which of the provider's transports this env selects, when it has more than
   * one. Part of the cacheKey, so one transport never serves another's cached IR.
   */
  transport?: (env: ProviderEnv) => string;
  keyEnv: string | null;
  /** True when the provider request includes a seed the API will honor. */
  seedHonored: boolean;
  requireReady: (env: ProviderEnv) => void;
  generate: (request: ProviderRequest, deps: ProviderDeps) => Promise<BankIR>;
};

const SENTINEL = 'test';

export function readRequiredKey(env: ProviderEnv, name: string): string {
  const value = env[name]?.trim() ?? '';
  if (!value) {
    throw new ProviderConfigError(
      `missing ${name}; ${name} is required for this provider (do not pass keys on the CLI)`,
    );
  }
  if (value === SENTINEL) {
    throw new ProviderConfigError(
      `${name} is the '${SENTINEL}' sentinel; use --provider test for CI fixtures (this provider does not invent stub output)`,
    );
  }
  return value;
}

export function hasUsableKey(env: ProviderEnv, name: string): boolean {
  const value = env[name]?.trim() ?? '';
  return value !== '' && value !== SENTINEL;
}
