import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { privateDirectory, privateFile } from '../../scripts/launcher.mjs';
import { tryAcquireWorkerLock } from '../../scripts/desktop/operation-lock.mjs';

const runner = fileURLToPath(new URL('../../scripts/desktop/worker-runner.mjs', import.meta.url));
const guard = fileURLToPath(new URL('../../scripts/desktop/worker-guard.cjs', import.meta.url));
const targetFixture = fileURLToPath(new URL('./fixtures/worker-target.cjs', import.meta.url));
const supervisorFixture = fileURLToPath(
  new URL('./fixtures/worker-supervisor.cjs', import.meta.url),
);
const delayedFixture = fileURLToPath(new URL('./fixtures/delayed-worker.mjs', import.meta.url));
const options = (root) => ({ root, secureDirectory: privateDirectory, secureFile: privateFile });
const environment = (root) => ({
  ...process.env,
  EXAMIFY_MODE: 'solo',
  EXAMIFY_INSTALL_ROOT: root,
  EXAMIFY_LAUNCHER_PID: String(process.pid),
});
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-worker-'));
  privateDirectory(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, target: targetFixture };
}
function launch(t, root, target, args = [], env = {}) {
  const child = fork(runner, [target, ...args], {
    env: { ...environment(root), ...env },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let error = '';
  child.stderr.on('data', (chunk) => {
    error += chunk;
  });
  const exit = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exit;
  });
  return { child, exit, error: () => error };
}
async function message(child, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        cleanup();
        reject(new Error(`Worker never sent ${type}`));
      },
      process.platform === 'win32' ? 30000 : 10000,
    );
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
    };
    const onMessage = (value) => {
      if (value?.type === type) {
        cleanup();
        resolve(value);
      }
    };
    const onExit = () => {
      cleanup();
      reject(new Error('Worker exited before readiness'));
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
  });
}

test('worker lease precedes data access, holds through lifespan and releases on SIGKILL', async (t) => {
  const { root, target } = fixture(t);
  // Reused or dead PID markers are irrelevant: only the kernel lease is authority.
  fs.writeFileSync(path.join(root, 'running.json'), JSON.stringify({ pid: process.pid }));
  const { child, exit } = launch(t, root, target);
  await message(child, 'examify-worker-ready');
  assert.equal(fs.existsSync(path.join(root, 'opened')), false);
  assert.equal(await tryAcquireWorkerLock(options(root)), null);
  const opened = message(child, 'opened');
  child.send({ type: 'examify-worker-go' });
  await opened;
  assert.equal(await tryAcquireWorkerLock(options(root)), null);
  child.kill('SIGKILL');
  await exit;
  const release = await tryAcquireWorkerLock(options(root));
  assert.equal(typeof release, 'function');
  release();
  assert.equal(fs.existsSync(path.join(root, '.examify-operations', 'worker.sqlite')), true);
});

test('candidate data/config paths cannot change the stable worker lock namespace', async (t) => {
  const { root, target } = fixture(t);
  const release = await tryAcquireWorkerLock(options(root));
  const { exit } = launch(t, root, target, [], {
    EXAMIFY_CONFIG_DIR: path.join(root, 'candidate-config'),
    EXAMIFY_DATA_DIR: path.join(root, 'candidate-data'),
  });
  assert.equal((await exit)[0], 1);
  assert.equal(fs.existsSync(path.join(root, 'opened')), false);
  release();
});

test('disconnect before GO exits without reading settings or running migrations', async (t) => {
  const { root, target } = fixture(t);
  const { child, exit } = launch(t, root, target, ['--settings']);
  await message(child, 'examify-worker-ready');
  child.disconnect();
  await exit;
  assert.equal(fs.existsSync(path.join(root, 'opened')), false);
  const release = await tryAcquireWorkerLock(options(root));
  assert.equal(typeof release, 'function');
  release();
});

test('a standalone preload fails closed before reading any application state', (t) => {
  const { root, target } = fixture(t);
  const result = spawnSync(process.execPath, ['--require', guard, target], {
    env: environment(root),
  });
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(path.join(root, 'opened')), false);
});

test('worker preload refuses unsafe coordination files and directories', async (t) => {
  for (const kind of [
    'symlink-directory',
    'hardlink-file',
    'symlink-file',
    'public-file',
    'public-directory',
  ]) {
    if (process.platform === 'win32' && (kind.startsWith('public-') || kind === 'symlink-file'))
      continue;
    await t.test(kind, async (t) => {
      const { root, target } = fixture(t);
      const directory = path.join(root, '.examify-operations');
      const other = path.join(root, 'other');
      fs.writeFileSync(other, 'preserve', { mode: 0o600 });
      if (kind === 'symlink-directory') {
        const elsewhere = path.join(root, 'elsewhere');
        fs.mkdirSync(elsewhere, { mode: 0o700 });
        fs.symlinkSync(elsewhere, directory, process.platform === 'win32' ? 'junction' : 'dir');
      } else {
        fs.mkdirSync(directory, { mode: kind === 'public-directory' ? 0o755 : 0o700 });
        const file = path.join(directory, 'worker.sqlite');
        if (kind === 'hardlink-file') fs.linkSync(other, file);
        if (kind === 'symlink-file') fs.symlinkSync(other, file);
        if (kind === 'public-file') fs.writeFileSync(file, '', { mode: 0o644 });
      }
      const { exit } = launch(t, root, target);
      assert.equal((await exit)[0], 1);
      assert.equal(fs.existsSync(path.join(root, 'opened')), false);
      assert.equal(fs.readFileSync(other, 'utf8'), 'preserve');
    });
  }
});

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Permission errors or other failures are not evidence of termination.
    if (error.code !== 'ESRCH') throw error;
    return false;
  }
}
function killIfRunning(pid) {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}
async function waitUntil(predicate) {
  const deadline = Date.now() + 10000;
  while (!predicate() && Date.now() < deadline) await sleep(20);
  return predicate();
}
function supervisor(t, root, target, delayed = false) {
  const parent = fork(supervisorFixture, [runner, target, ...(delayed ? [delayedFixture] : [])], {
    env: { ...environment(root), EXAMIFY_TEST_WORKER_MODE: delayed ? '' : 'blocked' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const exited = once(parent, 'exit');
  t.after(async () => {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
    await exited;
  });
  return { parent, exited };
}

test('disconnect cannot release a live worker blocked in data access', async (t) => {
  const { root, target } = fixture(t);
  const { child, exit } = launch(t, root, target, [], { EXAMIFY_TEST_WORKER_MODE: 'blocked' });
  await message(child, 'examify-worker-ready');
  const blocked = message(child, 'blocked');
  child.send({ type: 'examify-worker-go' });
  await blocked;
  child.disconnect();
  assert.equal(processExists(child.pid), true);
  assert.equal(await tryAcquireWorkerLock(options(root)), null);
  child.kill('SIGKILL');
  await exit;
  const release = await tryAcquireWorkerLock(options(root));
  assert.equal(typeof release, 'function');
  release();
});

test('killed supervisor cannot release a still-running worker lease', async (t) => {
  const { root, target } = fixture(t);
  const { parent, exited } = supervisor(t, root, target);
  const { pid } = await message(parent, 'blocked');
  t.after(() => killIfRunning(pid));
  assert.equal(await tryAcquireWorkerLock(options(root)), null);
  parent.kill('SIGKILL');
  await exited;
  let release = await tryAcquireWorkerLock(options(root));
  if (release) {
    try {
      // Windows job objects can terminate descendants with their supervisor.
      // A free lease is safe only when the worker is independently proven dead.
      assert.equal(processExists(pid), false, 'free lease requires a dead worker');
    } finally {
      release();
    }
  } else {
    // POSIX normally leaves the blocked worker alive and its lease held.
    killIfRunning(pid);
    const deadline = Date.now() + 10000;
    while (!(release = await tryAcquireWorkerLock(options(root))) && Date.now() < deadline)
      await sleep(20);
    assert.equal(typeof release, 'function');
    release();
  }
});

test('a delayed child cannot open data after its launcher died and installer obtained the lease', async (t) => {
  const { root, target } = fixture(t);
  const gate = path.join(root, 'gate');
  const childExit = path.join(root, 'child-exit');
  const { parent, exited } = supervisor(t, root, target, true);
  const { pid } = await message(parent, 'waiting');
  t.after(() => killIfRunning(pid));
  assert.equal(fs.existsSync(path.join(root, 'opened')), false);
  parent.kill('SIGKILL');
  await exited;
  const release = await tryAcquireWorkerLock(options(root));
  assert.equal(typeof release, 'function');
  try {
    fs.writeFileSync(gate, 'start');
    // A force-killed descendant cannot execute JS exit hooks. Accept this only
    // with independent OS evidence of termination, never a missing sentinel alone.
    assert.equal(
      await waitUntil(() => fs.existsSync(childExit) || !processExists(pid)),
      true,
      'delayed child must exit or be confirmed terminated without GO',
    );
    if (fs.existsSync(childExit)) assert.equal(fs.readFileSync(childExit, 'utf8'), '1');
    assert.equal(fs.existsSync(path.join(root, 'opened')), false);
  } finally {
    release();
  }
  assert.equal(fs.existsSync(path.join(root, 'opened')), false);
});

test('an authorized migration can finish naturally while IPC remains connected', async (t) => {
  const { root, target } = fixture(t);
  const { child, exit } = launch(t, root, target, [], { EXAMIFY_TEST_WORKER_MODE: 'natural' });
  await message(child, 'examify-worker-ready');
  child.send({ type: 'examify-worker-go' });
  assert.equal((await exit)[0], 0);
  assert.equal(fs.readFileSync(path.join(root, 'opened'), 'utf8'), 'yes');
  const release = await tryAcquireWorkerLock(options(root));
  assert.equal(typeof release, 'function');
  release();
});
