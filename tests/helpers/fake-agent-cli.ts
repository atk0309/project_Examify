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
  /**
   * Codex only: what it writes to $CODEX_HOME/auth.json (a refreshed sign-in)
   * before answering, on a run and on its sign-in check.
   */
  refreshAuth?: string;
  /**
   * How it answers its sign-in check (`claude auth status` / `codex login
   * status`, after `claude auth --help` / `codex login --help` lists
   * `status`): `in` / `out` like a current CLI, `hang` never answers,
   * `orphan` never answers and starts a helper outside its process group
   * that keeps its output open (its pid is in `orphan.pid`), `old` is a CLI
   * without the subcommand: its help is the general help, and the status
   * command would be read as a prompt (an agent run, recorded as
   * `prompt-runs`), `help-fails` exits 1 on its help (a CLI that cannot
   * start). Default `in`.
   */
  signIn?: 'in' | 'out' | 'hang' | 'old' | 'orphan' | 'help-fails';
};

/** What one sign-in check (its help probe, or its status command) got. */
export type FakeCliStatusRecord = {
  argv: string[];
  cwd: string;
  cwdEntries: string[];
  env: { [key: string]: string };
  pid: number;
  /** Codex only: its CODEX_HOME as the check saw it. */
  codexHome?: { entries: string[]; auth: string | null };
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
const statusArgs = name === 'claude' ? ['auth', 'status'] : ['login', 'status'];
if (args.length === 2 && args[0] === statusArgs[0] && args[1] === '--help') {
  fs.appendFileSync(path.join(dir, 'help-calls'), 'x');
  const helpHome = process.env.CODEX_HOME;
  const helpAuth = helpHome ? path.join(helpHome, 'auth.json') : '';
  fs.writeFileSync(path.join(dir, 'help-record.json'), JSON.stringify({
    argv: args,
    cwd: process.cwd(),
    cwdEntries: fs.readdirSync(process.cwd()),
    env: process.env,
    pid: process.pid,
    codexHome: name === 'codex' && helpHome ? {
      entries: fs.existsSync(helpHome) ? fs.readdirSync(helpHome) : [],
      auth: fs.existsSync(helpAuth) ? fs.readFileSync(helpAuth, 'utf8') : null,
    } : undefined,
  }));
  if (behavior.signIn === 'help-fails') {
    process.stderr.write('error: could not start\\n');
    process.exit(1);
  }
  if (behavior.signIn === 'old') {
    // An old CLI's general help: "status" in prose, an option and a wrapped
    // description, but no status command in its Commands list.
    process.stdout.write([
      'Usage: ' + name + ' [options] [command] [prompt]',
      '',
      'Starts an interactive session by default; it can read git status and your files.',
      '',
      'Options:',
      '  -c, --continue  Continue the most recent conversation',
      '  status          Not a command: an option line',
      '',
      'Commands:',
      '  config          Manage configuration',
      '  mcp             Configure MCP servers and show their',
      '                  status in a list',
      '',
    ].join('\\n'));
  } else if (name === 'claude') {
    process.stdout.write('Usage: claude auth [options] [command]\\n\\nManage authentication\\n\\nCommands:\\n  login [options]   Sign in to your Anthropic account\\n  logout            Log out from your Anthropic account\\n  status [options]  Show authentication status\\n');
  } else {
    process.stdout.write('Manage login\\n\\nUsage: codex login [OPTIONS] [COMMAND]\\n\\nCommands:\\n  status  Show login status\\n  help    Print this message\\n');
  }
  process.exit(0);
}
if (args.length >= 2 && args[args.length - 2] === statusArgs[0] && args[args.length - 1] === statusArgs[1]) {
  const home = process.env.CODEX_HOME;
  const auth = home ? path.join(home, 'auth.json') : '';
  const record = {
    argv: args,
    cwd: process.cwd(),
    cwdEntries: fs.readdirSync(process.cwd()),
    env: process.env,
    pid: process.pid,
    codexHome: name === 'codex' && home ? {
      entries: fs.existsSync(home) ? fs.readdirSync(home) : [],
      auth: fs.existsSync(auth) ? fs.readFileSync(auth, 'utf8') : null,
    } : undefined,
  };
  fs.writeFileSync(path.join(dir, 'status-record.json'), JSON.stringify(record));
  fs.appendFileSync(path.join(dir, 'status-calls'), 'x');
  if (name === 'codex' && home && behavior.refreshAuth !== undefined) {
    fs.writeFileSync(auth, behavior.refreshAuth);
  }
  const signIn = behavior.signIn || 'in';
  if (signIn === 'hang') { setInterval(() => {}, 1000); return; }
  if (signIn === 'orphan') {
    const helper = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
    fs.writeFileSync(path.join(dir, 'orphan.pid'), String(helper.pid));
    setInterval(() => {}, 1000);
    return;
  }
  if (signIn === 'old') {
    // An old Claude Code reads "auth status" as a prompt: an agent run.
    fs.appendFileSync(path.join(dir, 'prompt-runs'), 'x');
    process.stdout.write('Invalid API key · Please run /login\\n');
    process.exit(1);
  }
  if (name === 'claude') {
    // The real one also prints the account's email and organisation.
    process.stdout.write(JSON.stringify({ loggedIn: signIn === 'in', authMethod: signIn === 'in' ? 'claude.ai' : 'none', email: 'parent@example.com' }, null, 2) + '\\n');
  } else {
    process.stderr.write(signIn === 'in' ? 'Logged in using ChatGPT\\n' : 'Not logged in\\n');
  }
  process.exit(signIn === 'in' ? 0 : 1);
}
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
  const count = (file: string) => {
    try {
      return readFileSync(path.join(dir, file), 'utf8').length;
    } catch {
      return 0;
    }
  };
  return {
    dir,
    bin,
    record: () => JSON.parse(readFileSync(path.join(dir, 'record.json'), 'utf8')) as FakeCliRecord,
    statusRecord: () =>
      JSON.parse(readFileSync(path.join(dir, 'status-record.json'), 'utf8')) as FakeCliStatusRecord,
    /** What its last help probe got. */
    helpRecord: () =>
      JSON.parse(readFileSync(path.join(dir, 'help-record.json'), 'utf8')) as FakeCliStatusRecord,
    /** Answer the next checks differently (the binary file stays the same). */
    setSignIn: (signIn: NonNullable<FakeCliBehavior['signIn']>) => {
      writeFileSync(path.join(dir, 'behavior.json'), JSON.stringify({ ...behavior, signIn }));
    },
    /** How many sign-in status commands ran. */
    statusCalls: () => count('status-calls'),
    /** How many subcommand help probes ran. */
    helpCalls: () => count('help-calls'),
    /** How many times an old CLI got its status command as a prompt. */
    promptRuns: () => count('prompt-runs'),
  };
}
