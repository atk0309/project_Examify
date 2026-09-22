import { spawn, type ChildProcess } from 'node:child_process';
import type { BankIR } from '../schema';
import { UNTRUSTED_SOURCE_NOTE, buildOpenAiCompatibleUserContent } from './content';
import {
  GenerateAbortedError,
  PROVIDER_TIMEOUT_MS,
  ProviderConfigError,
  ProviderFailureError,
  isAbortError,
  parseProviderBankIr,
  providerHttpError,
  providerRequestSignal,
  throwIfAborted,
  withProviderSignal,
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
  const res = await withProviderSignal(deps.signal, (signal) =>
    fetchFn(url, {
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
    }),
  );
  if (!res.ok) {
    throw providerHttpError('local endpoint', res.status);
  }
  const payload = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = payload.choices?.[0]?.message?.content;
  if (!text) throw new ProviderFailureError('output', 'local endpoint returned no message content');
  return parseProviderBankIr(text);
}

const LOCAL_CMD_MAX_BUFFER = 10 * 1024 * 1024;
const LOCAL_CMD_KILL_GRACE_MS = 250;

function cmdAbortError(userSignal?: AbortSignal): Error {
  if (userSignal?.aborted) return new GenerateAbortedError();
  return new ProviderFailureError(
    'timeout',
    `local command timed out after ${PROVIDER_TIMEOUT_MS}ms`,
  );
}

/** Kill the spawned command and, on POSIX, its process group (descendants). */
function killLocalCmdTree(child: ChildProcess): ReturnType<typeof setTimeout> | undefined {
  const pid = child.pid;
  if (process.platform === 'win32') {
    if (pid) {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill();
    }
    return undefined;
  }
  if (pid) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        // Already exited.
      }
    }
    return setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already exited.
        }
      }
    }, LOCAL_CMD_KILL_GRACE_MS);
  }
  child.kill();
  return undefined;
}

function generateViaCmd(
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
  const requestSignal = providerRequestSignal(userSignal);
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
    let stdout = '';
    let settled = false;
    let killing = false;
    let escalate: ReturnType<typeof setTimeout> | undefined;
    let child: ChildProcess | undefined;
    const finish = (error: Error | null, text?: string) => {
      if (settled) return;
      settled = true;
      // Keep the SIGKILL timer after we start a tree kill so descendants
      // that ignore SIGTERM still die after the parent close settles.
      if (escalate && !killing) clearTimeout(escalate);
      if (error) {
        reject(error);
        return;
      }
      try {
        resolve(parseProviderBankIr(text ?? ''));
      } catch (parseError) {
        reject(parseError instanceof Error ? parseError : new Error(String(parseError)));
      }
    };

    const abortChild = () => {
      if (!child || killing) return;
      killing = true;
      escalate = killLocalCmdTree(child);
    };

    try {
      // Detached POSIX group so abort/timeout can SIGTERM then SIGKILL descendants.
      // stderr is ignored so a chatty wrapper cannot fill the pipe and hang (spawnSync drained it).
      child = spawn(cmd, parts.slice(1), {
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch (error) {
      if (isAbortError(error) || requestSignal.aborted) {
        finish(cmdAbortError(userSignal));
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      finish(new ProviderFailureError('unreachable', `local command failed to start: ${message}`));
      return;
    }

    if (requestSignal.aborted) {
      abortChild();
    } else {
      requestSignal.addEventListener('abort', abortChild, { once: true });
    }

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, 'utf8') > LOCAL_CMD_MAX_BUFFER) {
        abortChild();
        finish(new ProviderFailureError('output', 'local command exceeded maxBuffer'));
      }
    });
    child.stdin?.on('error', () => {
      // Child may exit before stdin closes (abort / early failure).
    });
    child.on('error', (error) => {
      if (isAbortError(error) || requestSignal.aborted) {
        finish(cmdAbortError(userSignal));
        return;
      }
      finish(
        new ProviderFailureError('unreachable', `local command failed to start: ${error.message}`),
      );
    });
    child.on('close', (status) => {
      if (requestSignal.aborted) {
        finish(cmdAbortError(userSignal));
        return;
      }
      if (status !== 0) {
        finish(new ProviderFailureError('command', `local command exited ${status ?? 'null'}`));
        return;
      }
      finish(null, stdout);
    });
    child.stdin?.end(payload);
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
