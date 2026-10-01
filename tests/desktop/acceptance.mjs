#!/usr/bin/env node
/** Installs and runs the actual archive with no host Node/Git/pnpm on runtime PATH. */
import assert from 'node:assert/strict';
import { fork, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnvironment } from '../../scripts/launcher.mjs';
import { observeLauncher } from './launcher-progress.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const platform = `${process.platform}-${process.arch}`;
const artifacts = path.resolve(process.argv[2] || path.join(repo, 'build/desktop', platform));
const httpOnly = process.argv.includes('--http-only');
const asset = fs
  .readdirSync(artifacts)
  .find((name) => name.endsWith(platform === 'win32-x64' ? '.zip' : '.tar.gz'));
assert.ok(asset, 'Built archive exists');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'Examify acceptance '));
const root = path.join(fixture, 'Private Examify');
const archive = path.join(artifacts, asset);
function install(targetRoot, sourceArchive, stdio = 'inherit') {
  if (process.platform === 'win32') {
    execFileSync(
      process.env.ComSpec || 'cmd.exe',
      [
        '/d',
        '/s',
        '/c',
        `""${path.join(artifacts, 'install.cmd')}" -InstallRoot "${targetRoot}" -ArchivePath "${sourceArchive}" -NoLaunch -NoShortcut"`,
      ],
      { stdio, windowsVerbatimArguments: true },
    );
  } else {
    execFileSync(
      'bash',
      [
        path.join(artifacts, 'install-solo.sh'),
        '--root',
        targetRoot,
        '--archive',
        sourceArchive,
        '--no-launch',
        '--no-shortcut',
      ],
      { stdio },
    );
  }
}
let appDir;
let node;
try {
  const corrupt = path.join(fixture, 'corrupt.archive');
  const refusedRoot = path.join(fixture, 'Rejected download');
  fs.writeFileSync(corrupt, 'deliberately corrupted download');
  assert.throws(
    () => install(refusedRoot, corrupt, 'pipe'),
    'Installer rejects a checksum mismatch',
  );
  assert.equal(fs.existsSync(path.join(refusedRoot, 'data')), false);
  assert.equal(fs.existsSync(path.join(refusedRoot, 'installation.json')), false);
  install(root, archive);
  const marker = JSON.parse(fs.readFileSync(path.join(root, 'installation.json'), 'utf8'));
  appDir = path.join(root, 'releases', marker.version);
  node = path.join(appDir, process.platform === 'win32' ? 'runtime/node.exe' : 'runtime/bin/node');
} catch (error) {
  fs.rmSync(fixture, { recursive: true, force: true });
  throw error;
}
const env = {
  ...childEnvironment(),
  PATH:
    process.platform === 'win32'
      ? `${process.env.SystemRoot}\\system32;${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0`
      : '',
  OPENAI_API_KEY: 'must-not-be-inherited',
  EXAMIFY_MODE: 'household',
  NODE_OPTIONS: '',
};
const children = new Set();
const observers = new Set();
let launchSequence = 0;
const urls = [];
const waiters = [];
let child;
function takeUrl() {
  if (urls.length) return Promise.resolve(urls.shift());
  const ready = new Promise((resolve, reject) => {
    const waiter = {
      finish(error, url) {
        clearTimeout(timer);
        const index = waiters.indexOf(waiter);
        if (index !== -1) waiters.splice(index, 1);
        if (error) reject(error);
        else resolve(url);
      },
    };
    const timer = setTimeout(
      () => waiter.finish(new Error('Browser-open callback timed out.')),
      15000,
    );
    waiters.push(waiter);
  });
  void ready.catch(() => {});
  return ready;
}
function launch(targetRoot = root) {
  const proc = fork(path.join(repo, 'tests/desktop/launcher-child.mjs'), [appDir, targetRoot], {
    execPath: node,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.add(proc);
  proc.on('error', () => {});
  // Never echo child output, which may contain browser capabilities after a regression.
  proc.stdout.resume();
  proc.stderr.resume();
  proc.on('message', (message) => {
    if (message.kind === 'browser') {
      const waiter = waiters.shift();
      if (waiter) waiter.finish(undefined, message.url);
      else urls.push(message.url);
    }
  });
  const observer = observeLauncher(proc, { id: ++launchSequence, report: console.log });
  observers.add(observer);
  proc.once('exit', () => children.delete(proc));
  const ready = observer.ready;

  return { proc, ready };
}
async function bootstrap(url) {
  const parsed = new URL(url);
  const response = await fetch(`${parsed.origin}/api/solo/session`, {
    method: 'POST',
    headers: { origin: parsed.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ token: parsed.hash.slice(1) }),
  });
  assert.equal(response.status, 200, 'One-use browser capability establishes a solo session');
  return response.headers.get('set-cookie').split(';')[0];
}
try {
  execFileSync(node, [path.join(appDir, 'scripts/verify-prompts.mjs')], {
    cwd: appDir,
    env,
    stdio: 'pipe',
  });
  const concurrent = [launch(), launch()];
  const states = await Promise.all(concurrent.map((item) => item.ready));
  assert.equal(
    states.filter((state) => !state.reused).length,
    1,
    'Concurrent first launches share one initialized server',
  );
  assert.equal(states[0].origin, states[1].origin);
  const primary = states.findIndex((state) => !state.reused);
  child = concurrent[primary].proc;
  const ready = states[primary];
  const url = await takeUrl();
  await takeUrl(); // A second fresh capability was opened by the simultaneous launcher.
  assert.equal(ready.reused, false);
  async function probeInternal(route) {
    return new Promise((resolve, reject) => {
      const request = http.get(
        {
          hostname: '127.0.0.1',
          port: ready.internalPort,
          path: route,
          headers: { host: new URL(ready.origin).host, origin: ready.origin },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.once('error', reject);
    });
  }
  assert.equal(
    await probeInternal('/'),
    403,
    'Direct inner listener rejects forged public Host/Origin without transport proof',
  );
  assert.equal(await probeInternal('/api/health'), 403);
  const startHtml = await fetch(`${ready.origin}/solo/start`).then((response) => response.text());
  const protectedAsset = startHtml.match(/\/(?:_next\/static\/)[^"\s<>]+\.(?:js|css)/)?.[0];
  assert.ok(protectedAsset, 'Solo start includes a real build asset');
  assert.equal(
    await probeInternal(protectedAsset),
    403,
    'Static assets cannot bypass inner listener transport proof',
  );

  assert.equal((await fetch(`${ready.origin}/api/health`).then((r) => r.json())).ok, true);
  assert.equal((await fetch(`${ready.origin}/api/solo/session`, { method: 'POST' })).status, 403);
  assert.equal(
    (await fetch(ready.origin, { headers: { origin: 'https://evil.example' } })).status,
    403,
  );
  const reopen = async () => {
    const next = launch();
    assert.equal((await next.ready).reused, true, 'Second launch reuses the existing server');
    return takeUrl();
  };
  if (httpOnly) {
    const cookie = await bootstrap(url);
    const home = await fetch(ready.origin, { headers: { cookie } });
    assert.equal(home.status, 200, 'Solo Home renders successfully');
    const html = await home.text();
    for (const marker of [
      'data-testid="solo-quick-start"',
      'Try a sample exam',
      'Create your question bank',
    ]) {
      assert.ok(
        html.includes(marker),
        'Solo Home renders the real sample and question-bank controls',
      );
    }
    for (const [route, markers] of [
      ['/onboarding', ['data-testid="wizard-welcome"', 'Add your own study material']],
      ['/settings/ai', ['data-testid="ai-settings"', 'data-testid="ai-settings-save"']],
    ]) {
      const response = await fetch(`${ready.origin}${route}`, { headers: { cookie } });
      assert.equal(response.status, 200, 'Solo setup/settings render successfully');
      const body = await response.text();
      assert.ok(
        markers.every((marker) => body.includes(marker)),
        'Solo setup/settings display usable controls, not an error fallback',
      );
    }
    const assetPath = html.match(/\/(?:_next\/static\/)[^"\s<>]+\.(?:js|css)/)?.[0];
    assert.ok(assetPath, 'Built HTML references a static runtime asset');
    assert.equal(
      (await fetch(`${ready.origin}${assetPath}`)).status,
      200,
      'Standalone static assets load',
    );
    assert.equal(
      (
        await fetch(`${ready.origin}/api/solo/session`, {
          method: 'POST',
          headers: { origin: ready.origin, 'content-type': 'application/json' },
          body: JSON.stringify({ token: new URL(url).hash.slice(1) }),
        })
      ).status,
      409,
      'A consumed token cannot be replayed',
    );
    const fresh = await reopen();
    assert.ok(fresh !== url, 'Reopen issues a fresh capability');
    await bootstrap(fresh);
    console.log(
      'Packaged HTTP acceptance passed: native SQLite migration, solo bootstrap, cookie, HTML/static assets, token replay rejection and authenticated fresh relaunch. Browser interactions were not run.',
    );
  } else {
    const { verifyBrowser } = await import('./browser-checks.mjs');
    await verifyBrowser({ origin: ready.origin, browserUrl: url, reopen });
    console.log('Packaged browser acceptance passed.');
  }
  const secrets = fs.readFileSync(path.join(root, 'config/secrets.json'));
  const originalServer = fs.readFileSync(path.join(appDir, 'server.js'));
  assert.throws(() => install(root, archive, 'pipe'), 'Repair refuses to replace a live app');
  assert.ok(fs.readFileSync(path.join(appDir, 'server.js')).equals(originalServer));
  await new Promise((resolve) => {
    child.once('exit', resolve);
    child.send('stop', () => {});
  });
  fs.writeFileSync(
    path.join(appDir, 'server.js'),
    'tampered bytes with unchanged release manifest',
  );
  install(root, archive);
  assert.ok(
    fs.readFileSync(path.join(appDir, 'server.js')).equals(originalServer),
    'Verified reinstall replaces modified code even with an unchanged manifest',
  );
  fs.unlinkSync(node);
  install(root, archive);
  assert.ok(
    fs.existsSync(node),
    'Verified reinstall repairs a partially missing release without executing its old runtime',
  );
  assert.ok(
    fs.readFileSync(path.join(root, 'config/secrets.json')).equals(secrets),
    'Repeat installation preserves private configuration',
  );
  const again = launch();
  child = again.proc;
  const restarted = await again.ready;
  assert.equal(restarted.reused, false);
  await bootstrap(await takeUrl());
  assert.ok(
    fs.readFileSync(path.join(root, 'config/secrets.json')).equals(secrets),
    'Relaunch retains private signing secrets',
  );
  assert.ok(fs.statSync(path.join(root, 'data/app.db')).size > 0);
  console.log(
    'Stop/restart preserves the solo profile and private data. Runtime PATH contains no host Node, Git or pnpm.',
  );
  const householdRoot = path.join(fixture, 'Existing household');
  const householdData = path.join(householdRoot, 'data');
  fs.mkdirSync(householdData, { recursive: true, mode: 0o700 });
  const householdDb = path.join(householdData, 'app.db');
  execFileSync(
    node,
    [
      '--input-type=module',
      '-e',
      `import { createRequire } from 'node:module'; import path from 'node:path'; const require = createRequire(path.join(process.argv[1], 'package.json')); const Database = require('better-sqlite3'); const db = new Database(process.argv[2]); db.exec('CREATE TABLE users(id INTEGER PRIMARY KEY); INSERT INTO users VALUES(1)'); db.close();`,
      appDir,
      householdDb,
    ],
    { env, stdio: 'pipe' },
  );
  const original = fs.readFileSync(householdDb);
  const originalMode = fs.statSync(householdDb).mode;
  await assert.rejects(launch(householdRoot).ready, { code: 'EXAMIFY_UNSAFE_DATA' });
  assert.ok(
    fs.readFileSync(householdDb).equals(original),
    'Rejected household database bytes remain unchanged',
  );
  assert.equal(fs.statSync(householdDb).mode, originalMode);
  assert.deepEqual(
    fs.readdirSync(householdData),
    ['app.db'],
    'No migration metadata or SQLite sidecars created',
  );
  assert.equal(fs.existsSync(path.join(householdRoot, 'config')), false);
  assert.equal(fs.existsSync(path.join(householdRoot, 'running.json')), false);
  console.log(
    'Corrupt downloads are rejected; repeat install preserves data; household data is refused before any mutation.',
  );
} finally {
  for (const observer of observers) observer.dispose();
  for (const waiter of [...waiters]) waiter.finish(new Error('Acceptance fixture stopped.'));
  await Promise.all(
    [...children].map(
      (proc) =>
        new Promise((resolve) => {
          if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
          const timer = setTimeout(() => proc.kill('SIGKILL'), 5000);
          timer.unref();
          proc.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
          if (proc.connected) proc.send('stop', () => {});
          else proc.kill();
        }),
    ),
  );
  fs.rmSync(fixture, { recursive: true, force: true });
}
