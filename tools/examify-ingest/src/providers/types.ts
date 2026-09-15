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

export type ProviderDeps = {
  env: ProviderEnv;
  fetch?: typeof fetch;
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
