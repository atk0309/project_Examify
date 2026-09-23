import type { BankIR, LocalTransport } from '../schema';
import { runProviderCommand } from './command';
import { UNTRUSTED_SOURCE_NOTE, buildOpenAiCompatibleUserContent } from './content';
import {
  ProviderConfigError,
  ProviderFailureError,
  parseProviderBankIr,
  readProviderJson,
  throwIfAborted,
  withProviderSignal,
  type GenerateProvider,
  type ProviderDeps,
  type ProviderEnv,
  type ProviderRequest,
} from './types';

const LOCAL_CMD = 'EXAMIFY_INGEST_LOCAL_CMD';
const LOCAL_URL = 'EXAMIFY_LLM_BASE_URL';
/** Model name sent to the OpenAI-compatible endpoint (Ollama needs a pulled model's name). */
export const LOCAL_MODEL_ENV = 'EXAMIFY_LLM_MODEL';

/**
 * The env for one chosen transport. The provider runs EXAMIFY_INGEST_LOCAL_CMD
 * whenever it is set, so `endpoint` drops it; `command` drops the URL and the
 * endpoint's model name (the command never gets it). Without this, a host with
 * both settings always runs the command.
 */
export function localTransportEnv(env: ProviderEnv, transport: LocalTransport): ProviderEnv {
  const out = { ...env };
  if (transport === 'endpoint') {
    delete out[LOCAL_CMD];
  } else {
    delete out[LOCAL_URL];
    delete out[LOCAL_MODEL_ENV];
  }
  return out;
}

function requireLocalReady(env: ProviderEnv): void {
  const cmd = env[LOCAL_CMD]?.trim() ?? '';
  const url = env[LOCAL_URL]?.trim() ?? '';
  if (!cmd && !url) {
    throw new ProviderConfigError(
      `local provider needs ${LOCAL_CMD} (quoted executable + args) or ${LOCAL_URL} (OpenAI-compatible endpoint with multimodal user content); no cloud key required`,
    );
  }
  if (url) {
    try {
      new URL(url);
    } catch {
      throw new ProviderConfigError(`${LOCAL_URL} must be an absolute URL`);
    }
  }
}

/** Split a command line with double/single quotes so paths with spaces stay one argv. */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (quote) {
    throw new ProviderConfigError(`unclosed quote in ${LOCAL_CMD}`);
  }
  if (cur) out.push(cur);
  return out;
}

async function generateViaHttp(
  request: ProviderRequest,
  deps: ProviderDeps,
  baseUrl: string,
): Promise<BankIR> {
  const fetchFn = deps.fetch ?? fetch;
  const url = new URL('/v1/chat/completions', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const payload = await withProviderSignal(deps.signal, async (signal) => {
    const res = await fetchFn(url, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
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
    return readProviderJson<{ choices?: { message?: { content?: string } }[] }>(
      res,
      'local endpoint',
    );
  });
  const text = payload.choices?.[0]?.message?.content;
  if (!text) throw new ProviderFailureError('output', 'local endpoint returned no message content');
  return parseProviderBankIr(text);
}

async function generateViaCmd(
  request: ProviderRequest,
  cmdLine: string,
  userSignal?: AbortSignal,
): Promise<BankIR> {
  const parts = splitCommandLine(cmdLine);
  const cmd = parts[0];
  if (!cmd) {
    throw new ProviderConfigError(`${LOCAL_CMD} is empty`);
  }
  throwIfAborted(userSignal);
  const payload = JSON.stringify({
    prompt: request.prompt,
    promptVersion: request.promptVersion,
    subject: request.subject,
    seed: request.seed,
    temperature: 0,
    untrusted: UNTRUSTED_SOURCE_NOTE,
    sources: request.sources.map((source) => ({
      path: source.relPath,
      sha256: source.sha256,
      kind: source.kind,
      untrusted: true,
      mediaType: source.mediaType,
      text: source.kind === 'text' ? source.bytes.toString('utf8') : undefined,
      dataBase64: source.kind === 'text' ? undefined : source.bytes.toString('base64'),
    })),
    pageImages: request.pageImages.map((page) => ({
      path: page.sourceRelPath,
      page: page.page,
      sha256: page.sha256,
      untrusted: true,
      mediaType: page.mediaType,
      dataBase64: page.bytes.toString('base64'),
    })),
  });

  // stderr is ignored so a chatty wrapper cannot fill the pipe and hang.
  const { status, stdout } = await runProviderCommand({
    cmd,
    args: parts.slice(1),
    stdin: payload,
    label: 'local command',
    userSignal,
  });
  if (status !== 0) {
    throw new ProviderFailureError('command', `local command exited ${status ?? 'null'}`);
  }
  return parseProviderBankIr(stdout);
}

export const localProvider: GenerateProvider = {
  id: 'local',
  defaultModel: 'local',
  modelEnv: LOCAL_MODEL_ENV,
  // Same precedence as generate below: the command wins when both are set.
  transport: (env): LocalTransport => (env[LOCAL_CMD]?.trim() ? 'command' : 'endpoint'),
  keyEnv: null,
  seedHonored: true,
  requireReady: requireLocalReady,
  generate: async (request, deps) => {
    requireLocalReady(deps.env);
    const cmd = deps.env[LOCAL_CMD]?.trim() ?? '';
    if (cmd) return generateViaCmd(request, cmd, deps.signal);
    const url = deps.env[LOCAL_URL]?.trim() ?? '';
    return generateViaHttp(request, deps, url);
  },
};
