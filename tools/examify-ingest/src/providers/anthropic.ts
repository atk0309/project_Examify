import { extractJsonObject } from '../json';
import { bankIrSchema, type BankIR } from '../schema';
import { fenceUntrustedText, untrustedCaption, userGenerateMessage } from './content';
import {
  readRequiredKey,
  withProviderSignal,
  type GenerateProvider,
  type ProviderDeps,
  type ProviderRequest,
} from './types';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const KEY = 'ANTHROPIC_API_KEY';

type ContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'document';
      source: { type: 'base64'; media_type: 'application/pdf'; data: string };
    }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: string; data: string };
    };

function buildContent(request: ProviderRequest): ContentBlock[] {
  const content: ContentBlock[] = [{ type: 'text', text: userGenerateMessage(request) }];
  for (const source of request.sources) {
    if (source.kind === 'text') {
      content.push({
        type: 'text',
        text: fenceUntrustedText(source.relPath, source.kind, source.bytes.toString('utf8')),
      });
    } else if (source.kind === 'pdf') {
      content.push({ type: 'text', text: untrustedCaption(source.relPath, source.kind) });
      content.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: source.bytes.toString('base64'),
        },
      });
    } else if (source.kind === 'image') {
      content.push({ type: 'text', text: untrustedCaption(source.relPath, source.kind) });
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: source.mediaType,
          data: source.bytes.toString('base64'),
        },
      });
    }
  }
  for (const page of request.pageImages) {
    content.push({
      type: 'text',
      text: untrustedCaption(page.sourceRelPath, 'page-image', `p${page.page}`),
    });
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: page.mediaType,
        data: page.bytes.toString('base64'),
      },
    });
  }
  return content;
}

async function callAnthropic(request: ProviderRequest, deps: ProviderDeps): Promise<BankIR> {
  const key = readRequiredKey(deps.env, KEY);
  const fetchFn = deps.fetch ?? fetch;
  const res = await withProviderSignal(deps.signal, (signal) =>
    fetchFn(ANTHROPIC_URL, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: 8192,
        temperature: 0,
        // Messages API has no seed field; seed is in the user message + cacheKey.
        system: request.prompt,
        messages: [{ role: 'user', content: buildContent(request) }],
      }),
    }),
  );
  if (!res.ok) {
    throw new Error(`Anthropic returned HTTP ${res.status}`);
  }
  const payload = (await res.json()) as { content?: { type?: string; text?: string }[] };
  const text = (payload.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
  if (!text.trim()) throw new Error('Anthropic returned no text content');
  return bankIrSchema.parse(extractJsonObject(text));
}

export const anthropicProvider: GenerateProvider = {
  id: 'anthropic',
  defaultModel: 'claude-sonnet-4-6',
  keyEnv: KEY,
  seedHonored: false,
  requireReady: (env) => {
    readRequiredKey(env, KEY);
  },
  generate: callAnthropic,
};
