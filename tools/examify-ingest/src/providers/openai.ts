import type { BankIR } from '../schema';
import { buildOpenAiCompatibleUserContent } from './content';
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
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: request.prompt },
          { role: 'user', content: buildOpenAiCompatibleUserContent(request) },
        ],
      }),
    });
    return readProviderJson<{ choices?: { message?: { content?: string } }[] }>(res, 'OpenAI');
  });
  const text = payload.choices?.[0]?.message?.content;
  if (!text) throw new ProviderFailureError('output', 'OpenAI returned no message content');
  return parseProviderBankIr(text);
}

export const openaiProvider: GenerateProvider = {
  id: 'openai',
  defaultModel: 'gpt-4o',
  keyEnv: KEY,
  seedHonored: true,
  requireReady: (env) => {
    readRequiredKey(env, KEY);
  },
  generate: callOpenAi,
};
