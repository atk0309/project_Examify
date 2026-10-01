import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  allowedRequest,
  childEnvironment,
  createGateway,
  forwardHeaders,
  loadSecrets,
  privateDirectory,
} from '../../scripts/launcher.mjs';

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
    fs.writeFileSync(
      path.join(output, 'runtime-links.json'),
      JSON.stringify([{ path: 'node_modules/escape', target: '../outside' }]),
    );
    assert.throws(() => restoreRuntimeLinks(output), /Unsafe runtime link/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
