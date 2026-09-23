import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export type FakeCliBehavior = (
  | { mode: 'success'; text: string }
  | { mode: 'agent-message-only'; text: string }
  | { mode: 'api-error'; status: number }
  | { mode: 'not-signed-in' }
  | { mode: 'crash'; stderr: string; code: number }
  | { mode: 'hang' }
) & {
  /** Codex only: what it writes to $CODEX_HOME/auth.json (a refreshed sign-in) before answering. */
  refreshAuth?: string;
};

export type FakeCliRecord = {
  argv: string[];
  cwd: string;
  cwdEntries: string[];
  env: { [key: string]: string };
  stdin: string;
  pid: number;
  images?: { path: string; exists: boolean; size: number; inCwd: boolean }[];
  /** Codex only: its CODEX_HOME as the run saw it. */
  codexHome?: { entries: string[]; auth: string | null; authMode: number | null };
};

/**
 * A fake `claude` / `codex` on disk. It records what it got (argv, cwd,
 * env, stdin) next to itself and answers the way `behavior.json` says. The
 * child env is allowlisted, so behaviour cannot come through env vars.
 */
export function fakeCli(name: 'claude' | 'codex', behavior: FakeCliBehavior) {
  const dir = mkdtempSync(path.join(tmpdir(), `examify-fake-${name}-`));
  const bin = path.join(dir, name);
  writeFileSync(path.join(dir, 'behavior.json'), JSON.stringify(behavior));
  const script = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const dir = __dirname;
const behavior = JSON.parse(fs.readFileSync(path.join(dir, 'behavior.json'), 'utf8'));
const name = path.basename(__filename);
const args = process.argv.slice(2);
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  const images = [];
  args.forEach((arg, i) => { if (arg === '--image') images.push(args[i + 1]); });
  fs.writeFileSync(path.join(dir, 'record.json'), JSON.stringify({
    argv: args,
    cwd: process.cwd(),
    cwdEntries: fs.readdirSync(process.cwd()),
    env: process.env,
    stdin,
    pid: process.pid,
    images: images.map((file) => ({
      path: file,
      exists: fs.existsSync(file),
      size: fs.existsSync(file) ? fs.statSync(file).size : -1,
      inCwd: path.dirname(file) === process.cwd(),
    })),
    codexHome: name === 'codex' && process.env.CODEX_HOME ? (() => {
      const home = process.env.CODEX_HOME;
      const auth = path.join(home, 'auth.json');
      const has = fs.existsSync(auth);
      return {
        entries: fs.existsSync(home) ? fs.readdirSync(home) : [],
        auth: has ? fs.readFileSync(auth, 'utf8') : null,
        authMode: has ? fs.statSync(auth).mode & 0o777 : null,
      };
    })() : undefined,
  }));
  if (name === 'codex' && behavior.refreshAuth !== undefined) {
    fs.writeFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), behavior.refreshAuth);
  }
  const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
  if (behavior.mode === 'hang') { setInterval(() => {}, 1000); return; }
  if (behavior.mode === 'crash') { process.stderr.write(behavior.stderr + '\\n'); process.exit(behavior.code); }
  if (name === 'claude') {
    emit({ type: 'system', subtype: 'init' });
    if (behavior.mode === 'success') {
      emit({ type: 'assistant', message: { content: [{ type: 'text', text: behavior.text }] } });
      emit({ type: 'result', subtype: 'success', is_error: false, result: behavior.text });
      process.exit(0);
    }
    if (behavior.mode === 'api-error') {
      emit({ type: 'result', subtype: 'success', is_error: true, api_error_status: behavior.status, result: 'API Error: ' + behavior.status });
      process.exit(1);
    }
    if (behavior.mode === 'not-signed-in') {
      emit({ type: 'result', subtype: 'success', is_error: true, api_error_status: null, result: 'Not logged in · Please run /login' });
      process.exit(1);
    }
  } else {
    const out = args[args.indexOf('--output-last-message') + 1];
    emit({ type: 'thread.started', thread_id: 't1' });
    emit({ type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Codex is ignoring 1 unrecognized configuration setting.' } });
    emit({ type: 'turn.started' });
    if (behavior.mode === 'success' || behavior.mode === 'agent-message-only') {
      emit({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: behavior.text } });
      if (behavior.mode === 'success') fs.writeFileSync(out, behavior.text);
      emit({ type: 'turn.completed', usage: {} });
      process.exit(0);
    }
    if (behavior.mode === 'api-error') {
      emit({ type: 'error', message: 'Reconnecting... 1/5 (unexpected status ' + behavior.status + ')' });
      emit({ type: 'turn.failed', error: { message: 'unexpected status ' + behavior.status + ' Unauthorized: Missing bearer' } });
      process.exit(1);
    }
    if (behavior.mode === 'not-signed-in') {
      emit({ type: 'turn.failed', error: { message: 'Not logged in. Run codex login first.' } });
      process.exit(1);
    }
  }
});
`;
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return {
    dir,
    bin,
    record: () => JSON.parse(readFileSync(path.join(dir, 'record.json'), 'utf8')) as FakeCliRecord,
  };
}
