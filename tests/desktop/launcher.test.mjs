import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { observeChildProgress } from './child-progress.mjs';
import { observeLauncher } from './launcher-progress.mjs';
import {
  allowedRequest,
  childEnvironment,
  createGateway,
  forwardHeaders,
  loadSecrets,
  openBrowser,
  privateDirectory,
  privateFile,
  startLauncher,
} from '../../scripts/launcher.mjs';
import {
  acquireOperationLock,
  tryAcquireInstanceLock,
} from '../../scripts/desktop/operation-lock.mjs';

const lockOptions = (root) => ({
  root,
  secureDirectory: privateDirectory,
  secureFile: privateFile,
});

function request(headers = {}, method = 'GET', socket = {}) {
  return {
    headers: { host: '127.0.0.1:4400', ...headers },
    method,
    socket: { localAddress: '127.0.0.1', remoteAddress: '127.0.0.1', ...socket },
  };
}
const origin = 'http://127.0.0.1:4400';
test('trust is anchored to real loopback sockets, exact Host and Origin', () => {
  assert.equal(allowedRequest(request(), origin), true);
  assert.equal(allowedRequest(request({ origin }, 'POST'), origin), true);
  for (const bad of [
    request({ host: 'evil.example:4400' }),
    request({ host: 'localhost:4400' }),
    request({ origin: 'https://evil.example' }),
    request({ 'sec-fetch-site': 'cross-site' }),
    request({}, 'POST'),
    request({ origin: 'http://127.0.0.1:4401' }, 'POST'),
    request({}, 'GET', { remoteAddress: '192.168.1.2' }),
    request({}, 'GET', { localAddress: '0.0.0.0' }),
  ])
    assert.equal(allowedRequest(bad, origin), false);
});
test('forwarding removes spoofed identity, transport and connection-nominated headers', () => {
  assert.deepEqual(
    forwardHeaders(
      {
        host: '127.0.0.1:4400',
        cookie: 'session=existing',
        forwarded: 'for=evil',
        'x-forwarded-host': 'evil',
        'x-forwarded-for': 'evil',
        'x-real-ip': 'evil',
        'cf-connecting-ip': 'evil',
        'x-examify-solo-transport': 'evil',
        connection: 'keep-alive, x-hidden',
        'x-hidden': 'evil',
      },
      'trusted',
    ),
    { host: '127.0.0.1:4400', cookie: 'session=existing', 'x-examify-solo-transport': 'trusted' },
  );
});
test('host secrets, Node preload injection and app settings are not inherited', () => {
  assert.deepEqual(
    childEnvironment({
      PATH: '/bin',
      SystemRoot: 'C:\\Windows',
      HOME: '/home/me',
      OPENAI_API_KEY: 'private',
      NODE_OPTIONS: '--require bad',
      EXAMIFY_MODE: 'household',
      AUTH_SECRET: 'bad',
    }),
    {
      PATH: '/bin',
      SystemRoot: 'C:\\Windows',
      HOME: '/home/me',
    },
  );
});
test('browser opener waits for success and reports nonzero exits without private launch data', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-browser-opener-'));
  const script = path.join(directory, 'opener.mjs');
  const url = 'http://127.0.0.1:4321/solo/start#SYNTHETIC_PRIVATE_CAPABILITY';
  fs.writeFileSync(script, 'process.exit(Number(process.argv[2]));');
  try {
    for (const code of [0, 23]) {
      let received;
      const outcome = openBrowser(url, {
        timeout: 5000,
        spawn: (command, args, options) => {
          received = { command, args, options };
          return spawn(process.execPath, [script, String(code)], options);
        },
      });
      assert.equal(typeof outcome.then, 'function');
      if (code === 0) await outcome;
      else
        await assert.rejects(outcome, (error) => {
          assert.match(error.message, /Choose a default browser/);
          assert.doesNotMatch(error.message, /SYNTHETIC|127\.0\.0\.1|4321|exit|23/);
          return true;
        });
      assert.deepEqual(received, {
        command: process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open',
        args: process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url],
        options: { detached: true, stdio: 'ignore', windowsHide: true },
      });
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test('browser opener sanitizes synchronous and asynchronous spawn failures', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-browser-missing-'));
  const url = 'http://127.0.0.1:4321/solo/start#SYNTHETIC_PRIVATE_CAPABILITY';
  try {
    for (const startProcess of [
      () => {
        throw new Error(url);
      },
      (_command, _args, options) => spawn(path.join(directory, 'missing-opener'), [url], options),
    ])
      await assert.rejects(openBrowser(url, { spawn: startProcess }), (error) => {
        assert.match(error.message, /The browser could not open/);
        assert.doesNotMatch(error.message, /SYNTHETIC|127\.0\.0\.1|missing-opener/);
        return true;
      });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test('a long-lived browser opener detaches after the observation window without being killed', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-browser-running-'));
  const script = path.join(directory, 'opener.mjs');
  fs.writeFileSync(script, 'setInterval(() => {}, 1000);');
  let child;
  try {
    await openBrowser('http://127.0.0.1:4321/solo/start#disposable', {
      timeout: 50,
      spawn: (_command, _args, options) => {
        child = spawn(process.execPath, [script], options);
        return child;
      },
    });
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    assert.equal(child.killed, false);
    assert.doesNotThrow(() => process.kill(child.pid, 0));
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.ref();
      child.kill();
      await exited;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test('a browser opener failing after detachment reports a safe error', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-browser-delayed-'));
  const script = path.join(directory, 'opener.mjs');
  const url = 'http://127.0.0.1:4321/solo/start#SYNTHETIC_PRIVATE_CAPABILITY';
  fs.writeFileSync(script, 'setTimeout(() => process.exit(23), 200);');
  const originalError = console.error;
  const errors = [];
  let child;
  let exited;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    await openBrowser(url, {
      timeout: 50,
      spawn: (_command, _args, options) => {
        child = spawn(process.execPath, [script], options);
        exited = new Promise((resolve) => child.once('exit', resolve));
        return child;
      },
    });
    child.ref();
    await exited;
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Choose a default browser/);
    assert.doesNotMatch(errors[0], /SYNTHETIC|127\.0\.0\.1|4321|23/);
  } finally {
    console.error = originalError;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.ref();
      child.kill();
      await exited;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test('private generated secrets survive relaunch; malformed or linked files fail closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-launcher-'));
  try {
    privateDirectory(dir);
    const first = loadSecrets(dir);
    assert.equal(first.authSecret.length, 64);
    assert.notEqual(first.authSecret, first.setupSecret);
    assert.deepEqual(loadSecrets(dir), first);
    const file = path.join(dir, 'secrets.json');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.writeFileSync(file, '{}');
    assert.throws(() => loadSecrets(dir), /Invalid saved launcher/);
    fs.writeFileSync(file, '{"authSecret":SYNTHETIC_PRIVATE_SENTINEL}');
    assert.throws(
      () => loadSecrets(dir),
      (error) => {
        assert.match(error.message, /Private launcher state is invalid/);
        assert.doesNotMatch(error.message, /SYNTHETIC|authSecret/);
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('private paths can be secured repeatedly by fresh ordinary-user processes', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-repeat-private-'));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{}', { mode: 0o600 });
  const launcher = new URL('../../scripts/launcher.mjs', import.meta.url).href;
  const copiedScripts = path.join(
    dir,
    'Deep path with spaces',
    'releases',
    `ci-${'a'.repeat(40)}`,
    'scripts',
  );
  fs.mkdirSync(path.join(copiedScripts, 'desktop'), { recursive: true });
  for (const relative of [
    'launcher.mjs',
    'desktop/operation-lock.mjs',
    'desktop/state-store.mjs',
    'desktop/private-path.ps1',
  ]) {
    fs.copyFileSync(
      fileURLToPath(new URL(`../../scripts/${relative}`, import.meta.url)),
      path.join(copiedScripts, relative),
    );
  }
  const source = `try { const { privateDirectory, privateFile } = await import(process.argv[1]); privateDirectory(process.argv[2]); privateFile(process.argv[3]); } catch(error) { const code = /^EXAMIFY_ACL_(TIMEOUT|FAILED)_(SPAWN|ENTRY|METADATA|ACL_READ|ACL_WRITE|ACL_VERIFY|DONE)$/.test(error.code || '') ? error.code : 'UNKNOWN'; console.log(code); process.exitCode=1; }`;
  const env = childEnvironment();
  // Match the packaged launcher's clean-machine environment, including a PATH
  // without host Node, Git, pnpm or PowerShell module discovery configuration.
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  env.PATH =
    process.platform === 'win32'
      ? `${process.env.SystemRoot}\\system32;${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0`
      : '';
  try {
    if (process.platform === 'win32') {
      const startup = spawnSync(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "[Console]::WriteLine('EXAMIFY_POWERSHELL_READY')",
        ],
        {
          env,
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 15000,
          maxBuffer: 1024,
        },
      );
      assert.ok(
        startup.status === 0 && String(startup.stdout).trim() === 'EXAMIFY_POWERSHELL_READY',
        'Windows PowerShell itself starts with the minimal runtime environment before any helper/module executes',
      );
    }
    for (const [layout, entry] of [
      ['source', launcher],
      ['deep-copy', pathToFileURL(path.join(copiedScripts, 'launcher.mjs')).href],
    ]) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const result = spawnSync(
          process.execPath,
          ['--input-type=module', '-e', source, entry, dir, file],
          {
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 45000,
            maxBuffer: 1024,
            env,
          },
        );
        const output = String(result.stdout || '').trim();
        const diagnostic =
          /^EXAMIFY_ACL_(TIMEOUT|FAILED)_(SPAWN|ENTRY|METADATA|ACL_READ|ACL_WRITE|ACL_VERIFY|DONE)$/.test(
            output,
          )
            ? output
            : 'UNKNOWN';
        assert.equal(
          result.status,
          0,
          `${layout} fresh process ${attempt + 1} must secure private paths with minimal runtime env: ${diagnostic}`,
        );
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('gateway enforces its socket boundary on actual HTTP traffic', async () => {
  let calls = 0;
  const upstream = http.createServer((req, res) => {
    calls += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.headers));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const gateway = createGateway({
    internalPort: upstream.address().port,
    transportSecret: 'actual-secret',
    instanceId: 'instance',
  });
  const url = await gateway.listen();
  try {
    const response = await fetch(url, {
      headers: { 'x-examify-solo-transport': 'spoof', 'x-forwarded-for': 'evil' },
    });
    const headers = await response.json();
    assert.equal(headers['x-examify-solo-transport'], 'actual-secret');
    assert.equal(headers['x-forwarded-for'], undefined);
    assert.equal(response.headers.get('x-examify-launcher-id'), 'instance');
    assert.equal((await fetch(url, { method: 'POST' })).status, 403);
    assert.equal((await fetch(url, { headers: { origin: 'https://evil.test' } })).status, 403);
    assert.equal(
      await new Promise((resolve, reject) => {
        const req = http.get(url, { headers: { host: 'rebind.test' } }, (res) => {
          res.resume();
          resolve(res.statusCode);
        });
        req.once('error', reject);
      }),
      403,
    );
    assert.equal(calls, 1);
    assert.equal((await fetch(url, { method: 'POST', headers: { origin: url } })).status, 200);
    assert.equal(calls, 2);
  } finally {
    gateway.server.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => gateway.server.close(resolve)),
      new Promise((resolve) => upstream.close(resolve)),
    ]);
  }
});

test('release staging excludes checkout traces and inventory rejects nested secrets', async () => {
  const { copyStandaloneRuntime, assertReleaseInventory } =
    await import('../../scripts/desktop/inventory.mjs');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-inventory-'));
  try {
    const input = path.join(fixture, 'standalone');
    const output = path.join(fixture, 'release');
    for (const dir of [
      '.next/server',
      'node_modules/dependency',
      '.git',
      'tests/.tmp',
      'content/source-pdfs',
    ])
      fs.mkdirSync(path.join(input, dir), { recursive: true });
    for (const name of [
      'server.js',
      'package.json',
      '.next/server/app.js',
      'node_modules/dependency/index.js',
      '.git/config',
      'tests/.tmp/private.db',
      'content/source-pdfs/private.pdf',
      '.env',
    ])
      fs.writeFileSync(path.join(input, name), 'fixture');
    copyStandaloneRuntime(input, output);
    assert.deepEqual(assertReleaseInventory(output), [
      '.next/server/app.js',
      'node_modules/dependency/index.js',
      'package.json',
      'runtime-links.json',
      'server.js',
    ]);
    fs.writeFileSync(path.join(output, 'node_modules/dependency/.env.local'), 'secret');
    assert.throws(() => assertReleaseInventory(output), /Forbidden release entry/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('authenticated reopen issues fresh signed fragments without returning capability bytes', async () => {
  const { createHmac } = await import('node:crypto');
  const browserUrls = [];
  const launchToken = 'a'.repeat(64);
  const reopenSecret = 'b'.repeat(64);
  const gateway = createGateway({
    internalPort: 1,
    transportSecret: 'unused',
    instanceId: 'test',
    launchToken,
    reopenSecret,
    browser: (url) => browserUrls.push(url),
  });
  const url = await gateway.listen();
  const send = (headers = {}) => fetch(`${url}/__examify/reopen`, { method: 'POST', headers });
  try {
    assert.equal((await send({ origin: url })).status, 403);
    assert.equal((await send({ origin: url, 'x-examify-reopen': 'c'.repeat(64) })).status, 403);
    assert.equal(
      (await send({ origin: 'https://evil.test', 'x-examify-reopen': reopenSecret })).status,
      403,
    );
    assert.equal(browserUrls.length, 0);
    for (let i = 0; i < 2; i += 1) {
      const response = await send({ origin: url, 'x-examify-reopen': reopenSecret });
      assert.equal(response.status, 204);
      assert.equal(await response.text(), '');
      const token = new URL(browserUrls[i]).hash.slice(1);
      const [nonce, mac] = token.split('.');
      assert.equal(mac, createHmac('sha256', launchToken).update(nonce).digest('hex'));
    }
    assert.notEqual(browserUrls[0], browserUrls[1]);
  } finally {
    gateway.server.closeAllConnections();
    await new Promise((resolve) => gateway.server.close(resolve));
  }
});

test('portable links preserve pnpm dependency lookup without archive symlinks', async () => {
  const { copyStandaloneRuntime, assertReleaseInventory } =
    await import('../../scripts/desktop/inventory.mjs');
  const { restoreRuntimeLinks } = await import('../../scripts/desktop/restore-links.mjs');
  const { createRequire } = await import('node:module');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-links-'));
  try {
    const input = path.join(fixture, 'input');
    const output = path.join(fixture, 'output');
    const pkg = path.join(input, 'node_modules/.pnpm/parent/node_modules/parent');
    const dep = path.join(input, 'node_modules/.pnpm/child/node_modules/child');
    for (const dir of [pkg, dep, path.join(input, '.next')]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(input, 'server.js'), '');
    fs.writeFileSync(path.join(input, 'package.json'), '{}');
    fs.writeFileSync(path.join(pkg, 'index.js'), "module.exports = require('child');");
    fs.writeFileSync(path.join(dep, 'index.js'), "module.exports = 'dependency-resolved';");
    fs.symlinkSync(
      pkg,
      path.join(input, 'node_modules/parent'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    fs.symlinkSync(
      dep,
      path.join(pkg, '../child'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    copyStandaloneRuntime(input, output);
    assertReleaseInventory(output);
    restoreRuntimeLinks(output);
    restoreRuntimeLinks(output); // Repeat installation is idempotent.
    assert.equal(createRequire(path.join(output, 'package.json'))('parent'), 'dependency-resolved');
    const staged = path.join(fixture, 'staged');
    const published = path.join(fixture, 'published');
    copyStandaloneRuntime(input, staged);
    restoreRuntimeLinks(staged, { installedRoot: published });
    fs.renameSync(staged, published);
    assert.equal(
      createRequire(path.join(published, 'package.json'))('parent'),
      'dependency-resolved',
      'Prepared links remain valid after atomic publication',
    );
    fs.writeFileSync(
      path.join(output, 'runtime-links.json'),
      JSON.stringify([{ path: 'node_modules/escape', target: '../outside' }]),
    );
    assert.throws(() => restoreRuntimeLinks(output), /Unsafe runtime link/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('verified reinstall repairs tampered and partial releases, rolls back failure, and refuses live services', async () => {
  const { installRelease } = await import('../../scripts/desktop/install-release.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-repair-'));
  privateDirectory(root);
  const version = 'ci-fixture';
  const destination = path.join(root, 'releases', version);
  fs.mkdirSync(destination, { recursive: true });
  for (const name of ['data', 'config']) {
    fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, name, 'keep.txt'), 'preserve');
  }
  fs.writeFileSync(
    path.join(root, 'installation.json'),
    JSON.stringify({ app: 'examify-solo', version }),
    { mode: 0o600 },
  );
  function staged() {
    const directory = fs.mkdtempSync(path.join(root, '.install.'));
    const app = path.join(directory, 'app');
    fs.mkdirSync(app);
    fs.writeFileSync(
      path.join(app, 'desktop-release.json'),
      JSON.stringify({
        version,
        platform: `${process.platform}-${process.arch}`,
        nodeVersion: process.versions.node,
      }),
    );
    fs.writeFileSync(path.join(app, 'runtime-links.json'), '[]');
    fs.writeFileSync(path.join(app, 'payload.txt'), 'verified');
    return app;
  }
  try {
    fs.writeFileSync(path.join(destination, 'payload.txt'), 'tampered');
    await installRelease({ bootstrap: () => {}, root, staged: staged(), version });
    assert.equal(fs.readFileSync(path.join(destination, 'payload.txt'), 'utf8'), 'verified');
    fs.unlinkSync(path.join(destination, 'payload.txt'));
    await installRelease({ bootstrap: () => {}, root, staged: staged(), version });
    assert.equal(fs.readFileSync(path.join(destination, 'payload.txt'), 'utf8'), 'verified');
    await assert.rejects(
      installRelease({
        bootstrap: () => {},
        root,
        staged: staged(),
        version,
        prepare: () => {
          throw new Error('synthetic preparation failure');
        },
      }),
      /synthetic preparation failure/,
    );
    assert.equal(fs.readFileSync(path.join(destination, 'payload.txt'), 'utf8'), 'verified');
    const failedStage = staged();
    const rename = fs.renameSync;
    try {
      fs.renameSync = (from, to) => {
        if (from === failedStage && to === destination)
          throw new Error('synthetic publication failure');
        return rename(from, to);
      };
      await assert.rejects(
        installRelease({ bootstrap: () => {}, root, staged: failedStage, version }),
        /synthetic publication failure/,
      );
    } finally {
      fs.renameSync = rename;
    }
    assert.equal(
      fs.readFileSync(path.join(destination, 'payload.txt'), 'utf8'),
      'verified',
      'The previous release is rolled back if atomic publication fails',
    );
    const running = path.join(root, 'running.json');
    fs.writeFileSync(running, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
    fs.writeFileSync(path.join(destination, 'payload.txt'), 'tampered');
    await installRelease({ bootstrap: () => {}, root, staged: staged(), version });
    assert.equal(
      fs.readFileSync(path.join(destination, 'payload.txt'), 'utf8'),
      'verified',
      'A stale marker naming an unrelated live process must not block repair',
    );
    const releaseInstance = await tryAcquireInstanceLock(lockOptions(root));
    assert.equal(typeof releaseInstance, 'function');
    try {
      await assert.rejects(
        installRelease({ bootstrap: () => {}, root, staged: staged(), version }),
        /Examify is running/,
      );
      fs.unlinkSync(running);
      await assert.rejects(
        installRelease({ bootstrap: () => {}, root, staged: staged(), version }),
        /Examify is running/,
      );
    } finally {
      releaseInstance();
    }
    assert.equal(fs.readFileSync(path.join(destination, 'payload.txt'), 'utf8'), 'verified');
    for (const name of ['data', 'config'])
      assert.equal(fs.readFileSync(path.join(root, name, 'keep.txt'), 'utf8'), 'preserve');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('child progress rejects early exits and errors without leaking diagnostics or timers', async () => {
  for (const mode of ['exit', 'error', 'message', 'timeout', 'dispose']) {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    const observer = observeChildProgress(child, { timeout: 20 });
    const ready = observer.waitFor('acquired');
    child.emit('message', { phase: 'securing-file' });
    child.stderr.emit('data', Buffer.from('SYNTHETIC_PRIVATE_SENTINEL'.repeat(1000)));
    if (mode === 'exit') child.emit('exit', 7, null);
    if (mode === 'error')
      child.emit(
        'error',
        Object.assign(new Error('SYNTHETIC_PRIVATE_SENTINEL'), { code: 'EACCES' }),
      );
    if (mode === 'message')
      child.emit('message', {
        failure: true,
        phase: 'securing-file',
        code: 'ERR_SQLITE_ERROR',
        sqlite: 5,
      });
    if (mode === 'dispose') observer.dispose();
    await assert.rejects(ready, (error) => {
      assert.match(error.message, /phase=securing-file; stderrBytes=4096/);
      assert.equal(error.message.includes('SYNTHETIC'), false);
      if (mode === 'exit') assert.match(error.message, /exited code=7/);
      if (mode === 'error') assert.match(error.message, /spawn failed code=EACCES/);
      if (mode === 'message') assert.match(error.message, /failed code=ERR_SQLITE_ERROR sqlite=5/);
      return true;
    });
    observer.dispose();
    assert.equal(child.listenerCount('message'), 0);
    assert.equal(child.listenerCount('error'), 0);
    assert.equal(child.listenerCount('exit'), 0);
    assert.equal(child.stderr.listenerCount('data'), 0);
  }
});

test('packaged readiness rejects zero exits, signals, disconnects and failures with bounded phases', async () => {
  for (const mode of [
    'ready',
    'zero-exit',
    'signal-exit',
    'disconnect',
    'error',
    'failure',
    'timeout',
    'dispose',
  ]) {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    const reports = [];
    const observer = observeLauncher(child, {
      id: 1,
      timeout: 20,
      report: (value) => reports.push(value),
    });
    child.emit('message', { kind: 'phase', phase: 'migration' });
    child.emit('message', { kind: 'phase', phase: 'SYNTHETIC_PRIVATE_SENTINEL' });
    child.stderr.emit('data', Buffer.from('SYNTHETIC_PRIVATE_SENTINEL'.repeat(1000)));
    if (mode === 'ready') child.emit('message', { kind: 'ready', reused: false });
    if (mode === 'zero-exit') child.emit('exit', 0, null);
    if (mode === 'signal-exit') child.emit('exit', null, 'SIGKILL');
    if (mode === 'disconnect') child.emit('disconnect');
    if (mode === 'error') child.emit('error', new Error('SYNTHETIC_PRIVATE_SENTINEL'));
    if (mode === 'failure')
      child.emit('message', {
        kind: 'error',
        code: 'EXAMIFY_UNSAFE_DATA',
        message: 'SYNTHETIC_PRIVATE_SENTINEL',
      });
    if (mode === 'dispose') observer.dispose();
    if (mode === 'ready') assert.equal((await observer.ready).reused, false);
    else
      await assert.rejects(observer.ready, (error) => {
        assert.match(error.message, /launcher-1 phase=migration/);
        assert.match(error.message, /stderrBytes=4096/);
        assert.equal(error.message.includes('SYNTHETIC'), false);
        if (mode === 'zero-exit') assert.match(error.message, /exited before ready code=0/);
        if (mode === 'signal-exit') assert.match(error.message, /signal=SIGKILL/);
        if (mode === 'failure') assert.equal(error.code, 'EXAMIFY_UNSAFE_DATA');
        return true;
      });
    observer.dispose();
    assert.deepEqual(reports, ['Packaged launcher-1: migration.']);
    for (const event of ['message', 'error', 'exit', 'disconnect'])
      assert.equal(child.listenerCount(event), 0);
    assert.equal(child.stderr.listenerCount('data'), 0);
  }
});

test('root-stable cross-process lock ignores TMPDIR and releases after abrupt exit', async () => {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-lock-test-'));
  const source = fileURLToPath(new URL('./lock-child.mjs', import.meta.url));
  const children = [];
  const start = () => {
    const temporary = path.join(root, `alternate-temp-${children.length}`);
    fs.mkdirSync(temporary);
    const child = spawn(process.execPath, [source, root], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, TMPDIR: temporary, TEMP: temporary, TMP: temporary },
    });
    const observer = observeChildProgress(child);
    children.push({ child, observer });
    return { child, observer };
  };
  try {
    const first = start();
    await first.observer.waitFor('acquired');
    const second = start();
    const acquired = second.observer.waitFor('acquired');
    // Prove the second process reached SQLite contention, rather than sleeping
    // through Windows PowerShell startup and only testing sequential acquisition.
    await second.observer.waitFor('contended');
    assert.equal(
      second.observer.reached.has('acquired'),
      false,
      'Another process cannot enter the startup/install critical section',
    );
    const killed = new Promise((resolve) => first.child.once('exit', resolve));
    assert.equal(first.child.kill('SIGKILL'), true);
    await killed;
    await acquired;
    second.child.send('release');
  } finally {
    await Promise.all(
      children.map(
        ({ child }) =>
          new Promise((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            child.once('exit', resolve);
            child.kill();
          }),
      ),
    );
    for (const { observer } of children) observer.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent private-directory creation rechecks raced paths and still rejects links', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-directory-race-'));
  const target = path.join(fixture, 'created-concurrently');
  const linked = path.join(fixture, 'linked-concurrently');
  const mkdir = fs.mkdirSync;
  try {
    fs.mkdirSync = (directory, options) => {
      if (directory === target) {
        mkdir(directory, options);
        throw Object.assign(new Error('Already created'), { code: 'EEXIST' });
      }
      if (directory === linked) {
        fs.symlinkSync(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
        throw Object.assign(new Error('Already created'), { code: 'EEXIST' });
      }
      return mkdir(directory, options);
    };
    assert.equal(privateDirectory(target), target);
    assert.throws(() => privateDirectory(linked), /Unsafe installation path/);
  } finally {
    fs.mkdirSync = mkdir;
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('instance lock is nonblocking, independent of operations and released after abrupt exit', async () => {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-instance-lock-'));
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./lock-child.mjs', import.meta.url)), root, 'instance'],
    {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: childEnvironment(),
    },
  );
  const observer = observeChildProgress(child);
  try {
    await observer.waitFor('acquired');
    assert.equal(await tryAcquireInstanceLock(lockOptions(root)), null);
    const releaseOperation = await acquireOperationLock({ ...lockOptions(root), timeout: 0 });
    releaseOperation();
    const exited = new Promise((resolve) => child.once('exit', resolve));
    assert.equal(child.kill('SIGKILL'), true);
    await exited;
    const releaseInstance = await tryAcquireInstanceLock(lockOptions(root));
    assert.equal(typeof releaseInstance, 'function');
    releaseInstance();
    releaseInstance(); // Repeated cleanup must not touch a later holder.
    const next = await tryAcquireInstanceLock(lockOptions(root));
    releaseInstance();
    assert.equal(await tryAcquireInstanceLock(lockOptions(root)), null);
    next();
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    }
    observer.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('instance lock refuses linked files and linked coordination directories', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-unsafe-lock-'));
  const directory = privateDirectory(path.join(root, '.examify-operations'));
  const target = path.join(root, 'unrelated');
  fs.writeFileSync(target, 'preserve', { mode: 0o600 });
  const file = path.join(directory, 'instance.sqlite');
  try {
    fs.linkSync(target, file);
    await assert.rejects(tryAcquireInstanceLock(lockOptions(root)), /Unsafe launcher state file/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'preserve');
    fs.unlinkSync(file);
    fs.rmdirSync(directory);
    const elsewhere = fs.mkdtempSync(path.join(root, 'elsewhere-'));
    fs.symlinkSync(elsewhere, directory, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(tryAcquireInstanceLock(lockOptions(root)), /Unsafe installation path/);
    assert.deepEqual(fs.readdirSync(elsewhere), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A tiny HTTP child isolates supervisor lifetime behavior. Packaged acceptance
// separately exercises the actual migrations, SQLite database and first login.
function launcherFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-lifetime-'));
  const appDir = path.join(root, 'fixture-app');
  fs.mkdirSync(path.join(appDir, 'scripts', 'desktop'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'scripts', 'solo-preflight.mjs'), 'process.exit(0);');
  fs.writeFileSync(path.join(appDir, 'scripts', 'migrate.mjs'), 'process.exit(0);');
  for (const name of [
    'settings-loader.cjs',
    'worker-guard.cjs',
    'worker-runner.mjs',
    'private-path.ps1',
  ])
    fs.copyFileSync(
      new URL(`../../scripts/desktop/${name}`, import.meta.url),
      path.join(appDir, 'scripts', 'desktop', name),
    );
  fs.writeFileSync(
    path.join(appDir, 'server.js'),
    `
    const http = require('node:http');
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, pid: process.pid }));
      if (_request.url === '/stop') setTimeout(() => process.exit(23), 50);
    });
    server.listen(Number(process.env.PORT), '127.0.0.1');
  `,
  );
  return { root, appDir, browser: async () => {}, timeout: 5000 };
}

test('stale live-PID markers do not block startup, and healthy instances retain lifetime ownership through stop', async () => {
  const fixture = launcherFixture();
  const state = path.join(fixture.root, 'running.json');
  fs.writeFileSync(state, JSON.stringify({ pid: process.pid, instanceId: 'stale' }), {
    mode: 0o600,
  });
  let runtime;
  try {
    runtime = await startLauncher(fixture);
    assert.equal(runtime.reused, false);
    assert.equal(await tryAcquireInstanceLock(lockOptions(fixture.root)), null);
    const reopened = await startLauncher(fixture);
    assert.equal(reopened.reused, true);
    assert.equal(reopened.origin, runtime.origin);
    const { DatabaseSync } = await import('node:sqlite');
    const unlink = fs.unlinkSync;
    let cleanup;
    try {
      fs.unlinkSync = (file) => {
        if (file === state) {
          const probe = new DatabaseSync(
            path.join(fixture.root, '.examify-operations', 'instance.sqlite'),
          );
          let locked = false;
          try {
            probe.exec('BEGIN EXCLUSIVE');
            probe.exec('ROLLBACK');
          } catch (error) {
            locked = error.errcode === 5 || error.errcode === 6;
          } finally {
            probe.close();
          }
          cleanup = {
            childExited: runtime.child.exitCode !== null || runtime.child.signalCode !== null,
            instanceStillLocked: locked,
          };
        }
        return unlink(file);
      };
      const stop = runtime.stop();
      assert.equal(runtime.stop(), stop, 'Repeated stop waits for the same cleanup');
      await stop;
    } finally {
      fs.unlinkSync = unlink;
    }
    assert.deepEqual(cleanup, { childExited: true, instanceStillLocked: true });
    assert.equal(fs.existsSync(state), false);
    const release = await tryAcquireInstanceLock(lockOptions(fixture.root));
    assert.equal(typeof release, 'function');
    release();
  } finally {
    await runtime?.stop();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a server exiting while the browser opens rejects startup and releases lifetime ownership', async () => {
  const fixture = launcherFixture();
  let browserOpened = false;
  let workerExited = false;
  let runtime;
  fixture.browser = async (url) => {
    browserOpened = true;
    const response = await fetch(`${new URL(url).origin}/stop`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.ok, true);
    const { pid } = await response.json();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
        workerExited = true;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail('The disposable server did not exit while the browser callback was pending.');
  };
  try {
    await assert.rejects(
      startLauncher(fixture).then((value) => {
        runtime = value;
        return value;
      }),
      /Examify stopped during startup/,
    );
    assert.equal(browserOpened, true);
    assert.equal(workerExited, true);
    assert.equal(fs.existsSync(path.join(fixture.root, 'running.json')), false);
    const release = await tryAcquireInstanceLock(lockOptions(fixture.root));
    assert.equal(typeof release, 'function');
    release();
  } finally {
    await runtime?.stop();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('preflight and startup failure release lifetime ownership after preserving or cleaning state', async () => {
  for (const failure of ['preflight', 'migration', 'browser']) {
    const fixture = launcherFixture();
    const state = path.join(fixture.root, 'running.json');
    const stale = JSON.stringify({ pid: process.pid, instanceId: 'stale' });
    fs.writeFileSync(state, stale, { mode: 0o600 });
    fs.mkdirSync(path.join(fixture.root, 'data'));
    const data = path.join(fixture.root, 'data', 'app.db');
    fs.writeFileSync(data, 'synthetic household bytes', { mode: 0o600 });
    if (failure === 'preflight')
      fs.writeFileSync(
        path.join(fixture.appDir, 'scripts', 'solo-preflight.mjs'),
        'process.exit(1);',
      );
    if (failure === 'migration')
      fs.writeFileSync(path.join(fixture.appDir, 'scripts', 'migrate.mjs'), 'process.exit(1);');
    if (failure === 'browser')
      fixture.browser = async () => {
        throw new Error('synthetic browser failure');
      };
    try {
      await assert.rejects(
        startLauncher(fixture),
        failure === 'preflight'
          ? { code: 'EXAMIFY_UNSAFE_DATA' }
          : failure === 'migration'
            ? /could not prepare/
            : /synthetic browser failure/,
      );
      assert.equal(fs.readFileSync(data, 'utf8'), 'synthetic household bytes');
      if (failure === 'preflight') {
        assert.equal(fs.readFileSync(state, 'utf8'), stale);
        assert.equal(fs.existsSync(path.join(fixture.root, 'config')), false);
      } else assert.equal(fs.existsSync(state), false);
      const release = await tryAcquireInstanceLock(lockOptions(fixture.root));
      assert.equal(typeof release, 'function');
      release();
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});
