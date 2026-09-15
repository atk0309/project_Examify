import type { GenerateProviderId } from '../schema';
import { anthropicProvider } from './anthropic';
import { localProvider } from './local';
import { openaiProvider } from './openai';
import { testProvider } from './test';
import { ProviderConfigError, type GenerateProvider } from './types';

export { ProviderConfigError, hasUsableKey, readRequiredKey } from './types';
export type { ProviderDeps, ProviderEnv, ProviderRequest } from './types';

const PROVIDERS: Record<GenerateProviderId, GenerateProvider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  local: localProvider,
  test: testProvider,
};

export function getProvider(id: GenerateProviderId): GenerateProvider {
  const provider = PROVIDERS[id];
  if (!provider) throw new ProviderConfigError(`unknown provider ${id}`);
  return provider;
}
