import type { PageImage } from '../pages';
import type { BankIR, BankIrSubject, GenerateProviderId } from '../schema';
import type { ResolvedSource } from '../sources';

export class ProviderConfigError extends Error {
  readonly code = 'PROVIDER_CONFIG';

  constructor(message: string) {
    super(message);
    this.name = 'ProviderConfigError';
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

export function providerTimeoutSignal(): AbortSignal {
  return AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
}

/** 180s deadline, optionally combined with a caller AbortSignal. */
export function providerRequestSignal(userSignal?: AbortSignal): AbortSignal {
  const timeout = providerTimeoutSignal();
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
    throw error;
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
