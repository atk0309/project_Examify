import { openAiBankIrResponseFormat } from './openai-schema';
import type { BankIR } from '../schema';
import { buildOpenAiUserContent } from './content';
import {
  ProviderFailureError,
  parseProviderBankIr,
  readProviderJson,
  readRequiredKey,
  withProviderSignal,
  type GenerateProvider,
  type ProviderDeps,
  type ProviderRequest,
} from './types';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const KEY = 'OPENAI_API_KEY';

async function callOpenAi(request: ProviderRequest, deps: ProviderDeps): Promise<BankIR> {
  const key = readRequiredKey(deps.env, KEY);
  const content = buildOpenAiUserContent(request);
  const fetchFn = deps.fetch ?? fetch;
  const payload = await withProviderSignal(deps.signal, async (signal) => {
    const res = await fetchFn(OPENAI_URL, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: request.model,
        temperature: 0,
        seed: request.seed,
        response_format: openAiBankIrResponseFormat(request.subject.id),
        messages: [
          { role: 'system', content: request.prompt },
          { role: 'user', content },
        ],
      }),
    });
    return readProviderJson<{
      choices?: { finish_reason?: string; message?: { content?: unknown; refusal?: unknown } }[];
    }>(res, 'OpenAI');
  });
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : undefined;
  if (choice?.message?.refusal != null)
    throw new ProviderFailureError('output', 'OpenAI declined generation', {
      outputDiagnostic: { category: 'refusal', fields: [] },
    });
  if (choice?.finish_reason !== 'stop')
    throw new ProviderFailureError('output', 'OpenAI generation did not complete', {
      outputDiagnostic: { category: 'incomplete', fields: [] },
    });
  const text = choice?.message?.content;
  if (typeof text !== 'string' || !text.trim())
    throw new ProviderFailureError('output', 'OpenAI returned no message content', {
      outputDiagnostic: { category: 'empty', fields: [] },
    });
  return parseProviderBankIr(text, true);
}

export const openaiProvider: GenerateProvider = {
  id: 'openai',
  defaultModel: 'gpt-4o',
  keyEnv: KEY,
  modelEnv: 'EXAMIFY_OPENAI_MODEL',
  seedHonored: true,
  requireReady: (env) => {
    readRequiredKey(env, KEY);
  },
  generate: callOpenAi,
};
