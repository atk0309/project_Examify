import { spawn, type ChildProcess } from 'node:child_process';
import {
  GenerateAbortedError,
  PROVIDER_TIMEOUT_MS,
  ProviderFailureError,
  isAbortError,
  providerRequestSignal,
  throwIfAborted,
} from './types';

export const COMMAND_MAX_BUFFER = 10 * 1024 * 1024;
const COMMAND_KILL_GRACE_MS = 250;
const STDERR_TAIL_CHARS = 2048;

export type ProviderCommand = {
  cmd: string;
  args: readonly string[];
  stdin: string;
  /** Names the command in error text: `local command`, `claude`, `codex`. */
  label: string;
  userSignal?: AbortSignal;
  timeoutMs?: number;
  cwd?: string;
  /** Child environment (replaces, not extends). Omit to inherit this process's environment. */
  env?: Record<string, string>;
  maxBuffer?: number;
  /** Keep the last 2 KiB of stderr (drained, so a chatty tool cannot fill the pipe). */
  captureStderr?: boolean;
};

export type ProviderCommandResult = {
  status: number | null;
  stdout: string;
  stderrTail: string;
};

function abortError(label: string, timeoutMs: number, userSignal?: AbortSignal): Error {
  if (userSignal?.aborted) return new GenerateAbortedError();
  return new ProviderFailureError('timeout', `${label} timed out after ${timeoutMs}ms`);
}

/** Kill the spawned command and, on POSIX, its process group (descendants). */
function killCommandTree(child: ChildProcess): ReturnType<typeof setTimeout> | undefined {
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
    }, COMMAND_KILL_GRACE_MS);
  }
  child.kill();
  return undefined;
}

/**
 * Run a provider command: write `stdin`, collect stdout, resolve with the exit
 * status (the caller decides what a non-zero exit means). A caller cancel is
 * `GenerateAbortedError`; the deadline is a `timeout` failure; a command that
 * cannot start is `unreachable`; stdout over `maxBuffer` is `output`. Abort and
 * deadline kill the whole process group (SIGTERM, then SIGKILL).
 */
export function runProviderCommand(options: ProviderCommand): Promise<ProviderCommandResult> {
  const timeoutMs = options.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  const maxBuffer = options.maxBuffer ?? COMMAND_MAX_BUFFER;
  const { label, userSignal } = options;
  throwIfAborted(userSignal);
  const requestSignal = providerRequestSignal(userSignal, timeoutMs);

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderrTail = '';
    let settled = false;
    let killing = false;
    let escalate: ReturnType<typeof setTimeout> | undefined;
    let child: ChildProcess | undefined;

    const abortChild = () => {
      if (!child || killing) return;
      killing = true;
      escalate = killCommandTree(child);
    };
    const finish = (error: Error | null, status: number | null = null) => {
      if (settled) return;
      settled = true;
      requestSignal.removeEventListener('abort', abortChild);
      // Keep the SIGKILL timer after we start a tree kill so descendants
      // that ignore SIGTERM still die after the parent close settles.
      if (escalate && !killing) clearTimeout(escalate);
      if (error) {
        reject(error);
        return;
      }
      resolve({ status, stdout, stderrTail });
    };

    try {
      // Detached POSIX group so abort/timeout can SIGTERM then SIGKILL descendants.
      child = spawn(options.cmd, [...options.args], {
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', options.captureStderr ? 'pipe' : 'ignore'],
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.env ? { env: options.env as NodeJS.ProcessEnv } : {}),
      });
    } catch (error) {
      if (isAbortError(error) || requestSignal.aborted) {
        finish(abortError(label, timeoutMs, userSignal));
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      finish(new ProviderFailureError('unreachable', `${label} failed to start: ${message}`));
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
      if (Buffer.byteLength(stdout, 'utf8') > maxBuffer) {
        abortChild();
        finish(new ProviderFailureError('output', `${label} exceeded maxBuffer`));
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.stdin?.on('error', () => {
      // Child may exit before stdin closes (abort / early failure).
    });
    child.on('error', (error) => {
      if (isAbortError(error) || requestSignal.aborted) {
        finish(abortError(label, timeoutMs, userSignal));
        return;
      }
      finish(new ProviderFailureError('unreachable', `${label} failed to start: ${error.message}`));
    });
    child.on('close', (status) => {
      if (requestSignal.aborted) {
        finish(abortError(label, timeoutMs, userSignal));
        return;
      }
      finish(null, status);
    });
    child.stdin?.end(options.stdin);
  });
}
