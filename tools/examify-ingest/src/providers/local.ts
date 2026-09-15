import { spawn } from 'node:child_process';
import { extractJsonObject } from '../json';
import { bankIrSchema, type BankIR } from '../schema';
import { UNTRUSTED_SOURCE_NOTE, buildOpenAiCompatibleUserContent } from './content';
import {
  PROVIDER_TIMEOUT_MS,
  ProviderConfigError,
  abortError,
  providerRequestSignal,
  throwIfAborted,
  type GenerateProvider,
  type ProviderDeps,
  type ProviderEnv,
  type ProviderRequest,
} from './types';

const LOCAL_CMD = 'EXAMIFY_INGEST_LOCAL_CMD';
const LOCAL_URL = 'EXAMIFY_LLM_BASE_URL';

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
  const res = await fetchFn(url, {
    method: 'POST',
    signal: providerRequestSignal(deps.signal),
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
  if (!res.ok) {
    throw new Error(`local endpoint returned HTTP ${res.status}`);
  }
  const payload = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = payload.choices?.[0]?.message?.content;
  if (!text) throw new Error('local endpoint returned no message content');
  return bankIrSchema.parse(extractJsonObject(text));
}

const LOCAL_CMD_MAX_BUFFER = 10 * 1024 * 1024;

async function generateViaCmd(
  request: ProviderRequest,
  cmdLine: string,
  signal?: AbortSignal,
): Promise<BankIR> {
  const parts = splitCommandLine(cmdLine);
  const cmd = parts[0];
  if (!cmd) {
    throw new ProviderConfigError(`${LOCAL_CMD} is empty`);
  }
  throwIfAborted(signal);
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

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, parts.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let settled = false;
    const finish = (error?: Error, bank?: BankIR) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (!child.killed) child.kill('SIGTERM');
      if (error) reject(error);
      else resolve(bank!);
    };
    const onAbort = () => finish(abortError(signal));
    const timer = setTimeout(() => {
      finish(new Error(`local command timed out after ${PROVIDER_TIMEOUT_MS}ms`));
    }, PROVIDER_TIMEOUT_MS);
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > LOCAL_CMD_MAX_BUFFER) {
        finish(new Error('local command exceeded maxBuffer'));
      }
    });
    child.on('error', (error) => {
      finish(new Error(`local command failed to start: ${error.message}`));
    });
    child.on('close', (status) => {
      if (settled) return;
      if (status !== 0) {
        finish(new Error(`local command exited ${status ?? 'null'}`));
        return;
      }
      try {
        finish(undefined, bankIrSchema.parse(extractJsonObject(stdout)));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stdin.end(payload);
  });
}

export const localProvider: GenerateProvider = {
  id: 'local',
  defaultModel: 'local',
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
