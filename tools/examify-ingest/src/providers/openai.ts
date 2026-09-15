import { extractJsonObject } from '../json';
import { bankIrSchema, type BankIR } from '../schema';
import { buildOpenAiCompatibleUserContent } from './content';
import {
  providerTimeoutSignal,
  readRequiredKey,
  type GenerateProvider,
  type ProviderDeps,
  type ProviderRequest,
} from './types';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const KEY = 'OPENAI_API_KEY';

async function callOpenAi(request: ProviderRequest, deps: ProviderDeps): Promise<BankIR> {
  const key = readRequiredKey(deps.env, KEY);
  const fetchFn = deps.fetch ?? fetch;
  const res = await fetchFn(OPENAI_URL, {
    method: 'POST',
    signal: providerTimeoutSignal(),
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
  if (!res.ok) {
    throw new Error(`OpenAI returned HTTP ${res.status}`);
  }
  const payload = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = payload.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenAI returned no message content');
  return bankIrSchema.parse(extractJsonObject(text));
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
