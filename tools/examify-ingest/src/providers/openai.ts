import { extractJsonObject } from '../json';
import { bankIrSchema, type BankIR } from '../schema';
import {
  readRequiredKey,
  userGenerateMessage,
  type GenerateProvider,
  type ProviderDeps,
  type ProviderRequest,
} from './types';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const KEY = 'OPENAI_API_KEY';

type OpenAiPart =
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

function buildUserContent(request: ProviderRequest): OpenAiPart[] {
  const parts: OpenAiPart[] = [{ type: 'text', text: userGenerateMessage(request) }];
  for (const source of request.sources) {
    if (source.kind === 'text') {
      parts.push({
        type: 'text',
        text: `Source ${source.relPath}:\n${source.bytes.toString('utf8')}`,
      });
    } else if (source.kind === 'image') {
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${source.mediaType};base64,${source.bytes.toString('base64')}` },
      });
    } else if (source.kind === 'pdf') {
      parts.push({
        type: 'text',
        text: `PDF attached as source ${source.relPath} (sha256=${source.sha256}). Prefer page images when present.`,
      });
    }
  }
  for (const page of request.pageImages) {
    parts.push({
      type: 'image_url',
      image_url: { url: `data:${page.mediaType};base64,${page.bytes.toString('base64')}` },
    });
  }
  return parts;
}

async function callOpenAi(request: ProviderRequest, deps: ProviderDeps): Promise<BankIR> {
  const key = readRequiredKey(deps.env, KEY);
  const fetchFn = deps.fetch ?? fetch;
  const res = await fetchFn(OPENAI_URL, {
    method: 'POST',
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
        { role: 'user', content: buildUserContent(request) },
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
  requireReady: (env) => {
    readRequiredKey(env, KEY);
  },
  generate: callOpenAi,
};
