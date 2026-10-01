#!/usr/bin/env node
/** Dependency-free supervisor and real loopback trust boundary for the solo app. */
import { spawn, spawnSync } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireOperationLock } from './desktop/operation-lock.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const secret = () => randomBytes(32).toString('hex');
const securedWindowsPaths = new Set();
function secureWindowsPath(file) {
  if (process.platform !== 'win32' || securedWindowsPaths.has(file)) return;
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(here, 'desktop', 'private-path.ps1'),
      '-Path',
      file,
    ],
    { stdio: 'ignore', windowsHide: true, timeout: 15000 },
  );
  if (result.status !== 0)
    throw new Error('Could not secure private Examify files for this Windows user.');
  securedWindowsPaths.add(file);
}
const SAFE_METHODS = new Set(['GET', 'HEAD']);
const HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export function assertExistingAncestors(dir) {
  const absolute = path.resolve(dir);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error('Unsafe installation path.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

export function privateDirectory(dir) {
  const absolute = path.resolve(dir);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error('Unsafe installation path.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try {
        fs.mkdirSync(current, { mode: 0o700 });
      } catch (creationError) {
        if (creationError.code !== 'EEXIST') throw creationError;
        const created = fs.lstatSync(current);
        if (created.isSymbolicLink() || !created.isDirectory())
          throw new Error('Unsafe installation path.');
      }
    }
  }
  const stat = fs.statSync(absolute);
  if (process.getuid && stat.uid !== process.getuid())
    throw new Error('Installation belongs to another user.');
  if (process.platform !== 'win32') fs.chmodSync(absolute, 0o700);
  else secureWindowsPath(absolute);
  return absolute;
}

export function privateFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new Error('Unsafe launcher state file.');
  if (process.getuid && stat.uid !== process.getuid())
    throw new Error('Launcher state belongs to another user.');
  if (process.platform === 'win32') secureWindowsPath(file);
  if (process.platform !== 'win32' && stat.mode & 0o077)
    throw new Error('Launcher state must be private to its owner.');
}

function readJson(file) {
  privateFile(file);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error('Private launcher state is invalid or unreadable. Restore it from a backup.');
  }
}

function writeJson(file, value, exclusive = false) {
  const target = exclusive ? file : `${file}.${process.pid}.tmp`;
  fs.writeFileSync(target, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
  if (!exclusive) fs.renameSync(target, file);
}

export function browserCapability(key) {
  const nonce = secret();
  return `${nonce}.${createHmac('sha256', key).update(nonce).digest('hex')}`;
}

function equalSecret(actual, expected) {
  return (
    typeof actual === 'string' &&
    /^[a-f0-9]{64}$/.test(actual) &&
    timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))
  );
}

export function loadSecrets(configDir) {
  const file = path.join(configDir, 'secrets.json');
  try {
    writeJson(file, { authSecret: secret(), setupSecret: secret() }, true);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const value = readJson(file);
  if (!/^[a-f0-9]{64}$/.test(value.authSecret) || !/^[a-f0-9]{64}$/.test(value.setupSecret)) {
    throw new Error(
      'Invalid saved launcher secrets. Restore the private configuration from a backup.',
    );
  }
  return value;
}

export function childEnvironment(host = process.env) {
  // NODE_OPTIONS, inherited API keys and all app settings are deliberately absent.
  const allowed =
    /^(PATH|HOME|USERPROFILE|LOCALAPPDATA|APPDATA|TEMP|TMP|TMPDIR|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|LANG|LC_[A-Z_]+|XDG_CONFIG_HOME|XDG_CACHE_HOME|XDG_DATA_HOME)$/i;
  return Object.fromEntries(
    Object.entries(host).filter(([key, value]) => allowed.test(key) && typeof value === 'string'),
  );
}

function loopback(address) {
  return address === '127.0.0.1' || address === '::ffff:127.0.0.1';
}

export function allowedRequest(request, origin) {
  if (!loopback(request.socket.localAddress) || !loopback(request.socket.remoteAddress))
    return false;
  if (request.headers.host !== new URL(origin).host) return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  if (request.headers.origin && request.headers.origin !== origin) return false;
  return SAFE_METHODS.has(request.method) || request.headers.origin === origin;
}

export function forwardHeaders(headers, transportSecret) {
  const dynamicHop = new Set(
    String(headers.connection || '')
      .toLowerCase()
      .split(',')
      .map((s) => s.trim()),
  );
  const clean = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      HOP_HEADERS.has(lower) ||
      dynamicHop.has(lower) ||
      lower === 'forwarded' ||
      lower.startsWith('x-forwarded-') ||
      lower === 'x-real-ip' ||
      lower === 'cf-connecting-ip' ||
      lower.startsWith('x-examify-')
    )
      continue;
    clean[name] = value;
  }
  clean['x-examify-solo-transport'] = transportSecret;
  return clean;
}

export function createGateway({
  internalPort,
  transportSecret,
  instanceId,
  reopenSecret,
  launchToken,
  browser,
}) {
  let origin;
  const server = http.createServer((request, response) => {
    if (!allowedRequest(request, origin)) {
      response.writeHead(403, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      response.end('This Examify session is only available from its local browser window.');
      return;
    }
    if (request.url === '/__examify/reopen') {
      if (
        request.method !== 'POST' ||
        !reopenSecret ||
        !equalSecret(request.headers['x-examify-reopen'], reopenSecret)
      ) {
        response.writeHead(403).end();
        return;
      }
      Promise.resolve(browser(`${origin}/solo/start#${browserCapability(launchToken)}`)).then(
        () => response.writeHead(204).end(),
        () => response.writeHead(500).end(),
      );
      request.resume();
      return;
    }
    const upstream = http.request(
      {
        hostname: '127.0.0.1',
        port: internalPort,
        method: request.method,
        path: request.url,
        headers: forwardHeaders(request.headers, transportSecret),
      },
      (incoming) => {
        const headers = { ...incoming.headers, 'x-examify-launcher-id': instanceId };
        for (const name of HOP_HEADERS) delete headers[name];
        response.writeHead(incoming.statusCode || 502, headers);
        incoming.pipe(response);
      },
    );
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(503, { 'content-type': 'text/plain' });
      response.end('Examify is starting. Try again in a moment.');
    });
    request.on('aborted', () => upstream.destroy());
    response.on('close', () => upstream.destroy());
    request.pipe(upstream);
  });
  server.on('upgrade', (_request, socket) => socket.destroy());
  server.headersTimeout = 15000;
  server.requestTimeout = 120000;
  return {
    server,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      origin = `http://127.0.0.1:${server.address().port}`;
      return origin;
    },
  };
}

async function unusedPort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function healthy(origin, instanceId) {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/')
      return false;
    const response = await fetch(`${origin}/api/health`, {
      signal: AbortSignal.timeout(1500),
      redirect: 'error',
    });
    return (
      response.ok &&
      response.headers.get('x-examify-launcher-id') === instanceId &&
      (await response.json()).ok === true
    );
  } catch {
    return false;
  }
}

export function openBrowser(url) {
  const command = process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () =>
    console.error(
      'The browser could not open. Keep this window open and launch Examify again after choosing a default browser.',
    ),
  );
  child.unref();
}

export async function startLauncher({
  root,
  appDir = path.dirname(here),
  browser = openBrowser,
  node = process.execPath,
  timeout = 60000,
  onPhase = () => {},
}) {
  if (!['linux', 'win32'].includes(process.platform) || process.arch !== 'x64') {
    throw new Error('This preview supports Windows x64 and Linux x64 only.');
  }
  root = path.resolve(root);
  const configDir = path.join(root, 'config');
  const dataDir = path.join(root, 'data');
  const stateFile = path.join(root, 'running.json');
  assertExistingAncestors(root);
  assertExistingAncestors(configDir);
  assertExistingAncestors(dataDir);
  onPhase('lock');
  const releaseOperation = await acquireOperationLock({
    root,
    secureDirectory: privateDirectory,
    secureFile: privateFile,
    onContended: () => onPhase('lock-wait'),
  });
  try {
    onPhase('existing');
    async function reuse(running) {
      if (
        !alive(running.pid) ||
        !running.origin ||
        !(await healthy(running.origin, running.instanceId))
      )
        return false;
      const { authSecret } = readJson(path.join(configDir, 'secrets.json'));
      const response = await fetch(`${running.origin}/__examify/reopen`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        headers: {
          origin: running.origin,
          'x-examify-reopen': createHmac('sha256', authSecret)
            .update(`reopen:${running.instanceId}`)
            .digest('hex'),
        },
      });
      if (!response.ok)
        throw new Error('Could not reopen the current Examify browser. Stop it and launch again.');
      return true;
    }
    let previous;
    async function readPrevious() {
      try {
        return readJson(stateFile);
      } catch (error) {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      }
    }
    previous = await readPrevious();
    const waitStarted = Date.now();
    while (previous && alive(previous.pid)) {
      onPhase('reuse');
      if (await reuse(previous))
        return { reused: true, origin: previous.origin, stop: async () => {} };
      if (Date.now() - waitStarted >= timeout)
        throw new Error(
          'Another Examify launcher is still starting. Wait for it to finish or stop it before retrying.',
        );
      await sleep(250);
      previous = await readPrevious();
    }
    // Validate existing bytes before any data/config initialisation or permission change.
    onPhase('preflight');
    const preflight = spawnSync(
      node,
      [path.join(appDir, 'scripts', 'solo-preflight.mjs'), path.join(dataDir, 'app.db')],
      {
        cwd: appDir,
        env: childEnvironment(),
        stdio: 'ignore',
        windowsHide: true,
        timeout: 30000,
      },
    );
    if (preflight.status !== 0)
      throw Object.assign(
        new Error(
          'This folder is not a safe solo installation. Existing files were not changed; use a new dedicated folder.',
        ),
        { code: 'EXAMIFY_UNSAFE_DATA' },
      );
    onPhase('permissions');
    privateDirectory(root);
    const instanceId = secret();
    // The OS-backed operation lock serializes stale-marker recovery, preflight,
    // migration and startup. A crashed process releases it automatically.
    if (previous) fs.unlinkSync(stateFile);
    writeJson(stateFile, { pid: process.pid, instanceId }, true);
    let child;
    let gateway;
    let stopped = false;
    let spawnError = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      if (gateway) {
        gateway.server.closeAllConnections();
        await new Promise((resolve) => gateway.server.close(resolve));
      }
      if (child && child.exitCode === null) {
        child.kill();
        await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(3000)]);
        if (child.exitCode === null) child.kill('SIGKILL');
      }
      try {
        if (readJson(stateFile).instanceId === instanceId) fs.unlinkSync(stateFile);
      } catch {
        /* Already gone. */
      }
    };
    try {
      privateDirectory(configDir);
      privateDirectory(dataDir);
      for (const name of ['.env', '.env.local']) {
        try {
          privateFile(path.join(configDir, name));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      const { authSecret, setupSecret } = loadSecrets(configDir);
      const transportSecret = secret();
      const launchToken = secret();
      const internalPort = await unusedPort();
      gateway = createGateway({
        internalPort,
        transportSecret,
        instanceId,
        launchToken,
        browser,
        reopenSecret: createHmac('sha256', authSecret).update(`reopen:${instanceId}`).digest('hex'),
      });
      const origin = await gateway.listen();
      const env = {
        ...childEnvironment(),
        NODE_ENV: 'production',
        NEXT_TELEMETRY_DISABLED: '1',
        EXAMIFY_MODE: 'solo',
        EXAMIFY_CONFIG_DIR: configDir,
        EXAMIFY_DATA_DIR: dataDir,
        DATABASE_URL: `file:${path.join(dataDir, 'app.db')}`,
        AUTH_SECRET: authSecret,
        SETUP_BOOTSTRAP_SECRET: setupSecret,
        EXAMIFY_SOLO_LAUNCH_TOKEN: launchToken,
        EXAMIFY_SOLO_TRANSPORT_SECRET: transportSecret,
        HOSTNAME: '127.0.0.1',
        PORT: String(internalPort),
        SITE_URL: origin,
        AUTH_MODE: 'password',
        MAIL_TRANSPORT: 'outbox',
        ALLOW_LOCAL_OUTBOX: '1',
        TURNSTILE_ENABLED: '0',
      };
      onPhase('migration');
      const migration = spawn(node, [path.join(appDir, 'scripts', 'migrate.mjs')], {
        cwd: appDir,
        env,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
      // Never print migration output: it can contain private paths or SQL data.
      migration.stderr.resume();
      const migrationCode = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => migration.kill(), 60000);
        migration.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        migration.once('exit', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      if (migrationCode !== 0)
        throw new Error('Examify could not prepare its data. Existing files have been preserved.');
      onPhase('server');
      child = spawn(
        node,
        [
          '--require',
          path.join(appDir, 'scripts', 'desktop', 'settings-loader.cjs'),
          path.join(appDir, 'server.js'),
        ],
        {
          cwd: appDir,
          env,
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          windowsHide: true,
        },
      );
      child.once('error', () => {
        spawnError = true;
      });
      const start = Date.now();
      onPhase('health');
      while (!(await healthy(origin, instanceId))) {
        if (spawnError || child.exitCode !== null)
          throw new Error(
            'Examify did not start. Check that this release supports your operating system.',
          );
        if (Date.now() - start > timeout)
          throw new Error(
            'Examify took too long to start. Close other Examify windows and try again.',
          );
        await sleep(250);
      }
      privateFile(stateFile);
      writeJson(stateFile, { pid: process.pid, instanceId, origin });
      onPhase('browser');
      await browser(`${origin}/solo/start#${browserCapability(launchToken)}`);
      child.once('exit', () => {
        if (!stopped) {
          console.error(
            'Examify stopped unexpectedly. Your saved work is still in the private data folder.',
          );
          process.exitCode = 1;
          void stop();
        }
      });
      return { origin, internalPort, reused: false, stop, child };
    } catch (error) {
      await stop();
      throw error;
    }
  } finally {
    releaseOperation();
  }
}

async function main() {
  const args = process.argv.slice(2);
  let root = path.resolve(here, '..', '..', '..');
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--root' && args[index + 1]) root = path.resolve(args[++index]);
    else throw new Error('Usage: Examify [--root <private installation folder>]');
  }
  const runtime = await startLauncher({ root });
  if (!runtime.reused) {
    console.log(`Examify is ready at ${runtime.origin}`);
    console.log(
      'Keep this window open. Press Ctrl+C to stop. Your progress is saved automatically.',
    );
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => {
        void runtime.stop();
      });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Examify could not start.');
    process.exitCode = 1;
  });
}
