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

export type ProviderDeps = {
  env: ProviderEnv;
  fetch?: typeof fetch;
};

export type GenerateProvider = {
  id: GenerateProviderId;
  defaultModel: string;
  keyEnv: string | null;
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

export function userGenerateMessage(request: ProviderRequest): string {
  const sourceList = request.sources
    .map((source) => `- ${source.relPath} (${source.kind}, sha256=${source.sha256})`)
    .join('\n');
  const pages =
    request.pageImages.length === 0
      ? 'none (PDF page images were not rasterized; use attached PDFs/text)'
      : request.pageImages
          .map((page) => `- ${page.sourceRelPath} p${page.page} (${page.sha256})`)
          .join('\n');
  return [
    `Subject metadata (use exactly): ${JSON.stringify(request.subject)}`,
    `Seed: ${request.seed}`,
    `Prompt version: ${request.promptVersion}`,
    `Sources:\n${sourceList || '(none)'}`,
    `Cached page images:\n${pages}`,
    'Return only the BankIR JSON object.',
  ].join('\n\n');
}
