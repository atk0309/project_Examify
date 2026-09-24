import type { GenerateProviderId } from '../schema';
import { anthropicProvider } from './anthropic';
import { claudeCliProvider } from './claude-cli';
import { codexCliProvider } from './codex-cli';
import { localProvider } from './local';
import { openaiProvider } from './openai';
import { testProvider } from './test';
import { ProviderConfigError, type GenerateProvider } from './types';

export {
  CLI_PROVIDER_TIMEOUT_MS,
  CliNotFoundError,
  GenerateAbortedError,
  PROVIDER_TIMEOUT_MS,
  ProviderConfigError,
  ProviderFailureError,
  hasUsableKey,
  isAbortError,
  providerRequestSignal,
  providerTimeoutSignal,
  readRequiredKey,
  throwIfAborted,
  withProviderSignal,
} from './types';
export type { ProviderDeps, ProviderEnv, ProviderFailureKind, ProviderRequest } from './types';
export { UNTRUSTED_SOURCE_NOTE, fenceUntrustedText } from './content';
export { LOCAL_MODEL_ENV, localTransportEnv, splitCommandLine } from './local';
export {
  AGENT_CLI_BIN_ENV,
  AGENT_CLI_DEFAULT_MODEL,
  AGENT_CLI_MODEL_ENV,
  agentCliEnv,
  resolveAgentCliBinary,
  type AgentCli,
} from './agent-cli';
export { runClaudeCliText, type ClaudeCliTextRequest } from './claude-cli';
export { runCodexCliText, type CodexCliTextRequest } from './codex-cli';

const PROVIDERS: Record<GenerateProviderId, GenerateProvider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  local: localProvider,
  'claude-cli': claudeCliProvider,
  'codex-cli': codexCliProvider,
  test: testProvider,
};

export function getProvider(id: GenerateProviderId): GenerateProvider {
  const provider = PROVIDERS[id];
  if (!provider) throw new ProviderConfigError(`unknown provider ${id}`);
  return provider;
}
