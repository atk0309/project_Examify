import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { installRelease } from '../../scripts/desktop/install-release.mjs';
import { privateDirectory, privateFile, startLauncher } from '../../scripts/launcher.mjs';
import {
  tryAcquireInstanceLock,
  tryAcquireWorkerLock,
} from '../../scripts/desktop/operation-lock.mjs';
import { assertUpgradeVersion, validateInstallation } from '../../scripts/desktop/state-store.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-upgrade-unit-'));
  privateDirectory(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function staged(version = '0.1.0', protocol = 1) {
    const app = path.join(fs.mkdtempSync(path.join(root, '.install.')), 'app');
    fs.mkdirSync(app);
    fs.writeFileSync(
      path.join(app, 'desktop-release.json'),
      JSON.stringify({
        version,
        platform: `${process.platform}-${process.arch}`,
        nodeVersion: process.versions.node,
        upgradeProtocol: protocol,
      }),
    );
    fs.writeFileSync(path.join(app, 'payload'), `code-${version}`);
    return app;
  }
  const read = () => JSON.parse(fs.readFileSync(path.join(root, 'installation.json'), 'utf8'));
  const run = (version = '0.1.0', options = {}) =>
    installRelease({
      root,
      staged: staged(version),
      version,
      prepare() {},
      bootstrap() {},
      probe() {},
      ...options,
    });
  function seed() {
    for (const name of ['data', 'config']) privateDirectory(path.join(root, name));
    privateDirectory(path.join(root, 'data/content/generated'));
    for (const [name, bytes] of Object.entries({
      'data/app.db': 'offline database',
      'data/app.db-wal': 'committed WAL frames',
      'data/content/generated/bank.json': '{"questions":[{"id":"authored"}]}',
      'data/material.txt': 'Uploaded study material',
      'config/.env.local': 'EXAMIFY_LLM_MODEL=local-fixture\n',
      'config/secrets.json': '{"private":"preserve"}',
    }))
      fs.writeFileSync(path.join(root, name), bytes, { mode: 0o600 });
  }
  return { root, staged, read, run, seed };
}

test('fresh installs commit protocol 1 and immutable release without moving initial state', async (t) => {
  const f = fixture(t);
  f.seed();
  await f.run();
  const marker = f.read();
  assert.equal(marker.protocol, 1);
  assert.match(marker.release, /^releases\/0\.1\.0-[a-f0-9]{32}$/);
  assert.equal(marker.state, undefined);
  assert.equal(fs.readFileSync(path.join(f.root, 'data/app.db'), 'utf8'), 'offline database');
});

test('upgrade probes a complete independent state and commits its release/state together', async (t) => {
  const f = fixture(t);
  f.seed();
  await f.run();
  const before = f.read();
  let candidate;
  const phases = [];
  await f.run('0.2.0', {
    onPhase: (phase) => phases.push(phase),
    probe({ root, appDir, node }) {
      candidate = root;
      assert.notEqual(root, f.root);
      assert.deepEqual(f.read(), before, 'Marker is unchanged while migration runs');
      assert.equal(
        fs.readFileSync(path.join(root, 'data/app.db-wal'), 'utf8'),
        'committed WAL frames',
      );
      assert.equal(
        fs.readFileSync(path.join(root, 'config/.env.local'), 'utf8'),
        'EXAMIFY_LLM_MODEL=local-fixture\n',
      );
      assert.equal(fs.readFileSync(path.join(appDir, 'payload'), 'utf8'), 'code-0.2.0');
      assert.ok(node.startsWith(appDir + path.sep));
      fs.writeFileSync(path.join(root, 'data/app.db'), 'migrated database', { mode: 0o600 });
    },
  });
  const after = f.read();
  assert.equal(path.join(f.root, after.state), candidate);
  assert.equal(after.previous.release, before.release);
  assert.equal(after.version, '0.2.0');
  assert.deepEqual(phases, ['state-copied', 'before-activate', 'activated']);
  assert.equal(fs.readFileSync(path.join(f.root, 'data/app.db'), 'utf8'), 'offline database');
  assert.equal(fs.readFileSync(path.join(candidate, 'data/app.db'), 'utf8'), 'migrated database');
  assert.ok(fs.existsSync(path.join(candidate, 'backup-source.json')));
});

for (const phase of ['preparation', 'migration', 'before-activate']) {
  test(`${phase} failure leaves old release and state selected and unchanged`, async (t) => {
    const f = fixture(t);
    f.seed();
    await f.run();
    const before = f.read();
    const fail = () => {
      throw new Error('Injected failure');
    };
    const options =
      phase === 'preparation'
        ? { prepare: fail }
        : phase === 'migration'
          ? {
              probe({ root }) {
                fs.writeFileSync(path.join(root, 'data/app.db'), 'failed migration');
                fail();
              },
            }
          : {
              onPhase(value) {
                if (value === phase) fail();
              },
            };
    await assert.rejects(f.run('0.2.0', options), /Injected failure/);
    assert.deepEqual(f.read(), before);
    assert.equal(
      fs.readFileSync(path.join(f.root, before.release, 'payload'), 'utf8'),
      'code-0.1.0',
    );
    assert.equal(fs.readFileSync(path.join(f.root, 'data/app.db'), 'utf8'), 'offline database');
    await f.run('0.2.0');
    assert.equal(f.read().version, '0.2.0', 'Failed transaction releases its locks for retry');
  });
}

test('same-version repair creates immutable code/state slots and retains old matched pair', async (t) => {
  const f = fixture(t);
  f.seed();
  await f.run();
  const before = f.read();
  await assert.rejects(
    f.run('0.1.0', {
      onPhase(phase) {
        if (phase === 'before-activate') throw new Error('Crash boundary');
      },
    }),
    /Crash boundary/,
  );
  assert.deepEqual(f.read(), before);
  assert.ok(fs.existsSync(path.join(f.root, before.release, 'payload')));
  await f.run();
  const after = f.read();
  assert.notEqual(after.release, before.release);
  assert.equal(after.previous.release, before.release);
  assert.ok(fs.existsSync(path.join(f.root, before.release, 'payload')));
});

test('legacy repair stays legacy and cross-version legacy upgrade is refused', async (t) => {
  const f = fixture(t);
  f.seed();
  const legacy = { app: 'examify-solo', version: '0.1.0' };
  fs.writeFileSync(path.join(f.root, 'installation.json'), JSON.stringify(legacy), { mode: 0o600 });
  fs.mkdirSync(path.join(f.root, 'releases/0.1.0'), { recursive: true });
  await f.run();
  assert.deepEqual(f.read(), legacy);
  await assert.rejects(f.run('0.2.0'), /cannot be upgraded/);
  assert.deepEqual(f.read(), legacy);
});

test('live launcher and orphaned database worker both refuse upgrade before copying state', async (t) => {
  const f = fixture(t);
  f.seed();
  await f.run();
  const before = f.read();
  for (const acquire of [tryAcquireInstanceLock, tryAcquireWorkerLock]) {
    const release = await acquire({
      root: f.root,
      secureDirectory: privateDirectory,
      secureFile: privateFile,
    });
    try {
      await assert.rejects(f.run('0.2.0'), /Examify is running/);
    } finally {
      release();
    }
    assert.deepEqual(f.read(), before);
    assert.equal(fs.existsSync(path.join(f.root, 'states')), false);
  }
});

test('linked private state is rejected rather than following or omitting it', async (t) => {
  const f = fixture(t);
  f.seed();
  await f.run();
  const before = f.read();
  fs.linkSync(
    path.join(f.root, 'data/material.txt'),
    path.join(f.root, 'data/linked-material.txt'),
  );
  await assert.rejects(f.run('0.2.0'), /Unsafe/);
  assert.deepEqual(f.read(), before);
});

test('version ordering is numeric and unsupported or downward transitions fail closed', () => {
  for (const pair of [
    ['0.9.0', '0.10.0'],
    ['v1.0.0', 'v2.0.0'],
    ['9.99.99', '10.0.0'],
  ])
    assert.doesNotThrow(() => assertUpgradeVersion(...pair));
  for (const pair of [
    ['0.2.0', '0.1.0'],
    ['1.0.0', '1.0.0'],
    ['ci-old', 'ci-new'],
    ['1.0.0', '1.1.0-beta'],
    ['1.0.0', '01.1.0'],
  ])
    assert.throws(() => assertUpgradeVersion(...pair));
  for (const fields of [
    { protocol: 2 },
    { protocol: 1, release: '../../elsewhere' },
    { protocol: 1, release: `releases/0.1.0-${'a'.repeat(32)}`, state: 'states/../../private' },
  ])
    assert.throws(() => validateInstallation({ app: 'examify-solo', version: '0.1.0', ...fields }));
});

for (const missing of ['', 'data', 'data/app.db', 'config', 'config/secrets.json']) {
  test(`missing committed state ${missing || 'generation'} cannot turn an upgrade into a fresh profile`, async (t) => {
    const f = fixture(t);
    f.seed();
    await f.run();
    await f.run('0.2.0');
    const before = f.read();
    fs.rmSync(path.join(f.root, before.state, missing), { recursive: true, force: true });
    await assert.rejects(f.run('0.3.0'));
    assert.deepEqual(f.read(), before);
  });
}

test('insufficient copy/migration disk reserve preserves committed marker and data', async (t) => {
  const f = fixture(t);
  f.seed();
  await f.run();
  const before = f.read();
  const statfs = fs.statfsSync;
  try {
    fs.statfsSync = () => ({ bavail: 0n, bsize: 4096n });
    await assert.rejects(f.run('0.2.0'), /Not enough free space/);
  } finally {
    fs.statfsSync = statfs;
  }
  assert.deepEqual(f.read(), before);
  assert.equal(fs.readFileSync(path.join(f.root, 'data/app.db'), 'utf8'), 'offline database');
});

test('successful probe cannot activate an incomplete migrated state', async (t) => {
  const f = fixture(t);
  f.seed();
  await f.run();
  const before = f.read();
  await assert.rejects(
    f.run('0.2.0', {
      probe({ root }) {
        fs.unlinkSync(path.join(root, 'config/secrets.json'));
      },
    }),
  );
  assert.deepEqual(f.read(), before);
  assert.equal(
    fs.readFileSync(path.join(f.root, 'config/secrets.json'), 'utf8'),
    '{"private":"preserve"}',
  );
});

test('inactive release cannot open or reuse a live upgraded installation', async (t) => {
  const f = fixture(t);
  f.seed();
  await f.run();
  const oldApp = path.join(f.root, f.read().release);
  await f.run('0.2.0');
  const lease = await tryAcquireInstanceLock({
    root: f.root,
    secureDirectory: privateDirectory,
    secureFile: privateFile,
  });
  const phases = [];
  try {
    await assert.rejects(
      startLauncher({
        root: f.root,
        appDir: oldApp,
        timeout: 100,
        onPhase: (phase) => phases.push(phase),
        browser() {
          throw new Error('Must not open');
        },
      }),
      /not active/,
    );
    assert.equal(phases.includes('reuse'), false);
    assert.equal(phases.includes('preflight'), false);
  } finally {
    lease();
  }
});

for (const missing of ['', 'data', 'config', 'data/app.db', 'config/secrets.json']) {
  test(`launcher gives private recovery guidance for missing selected ${missing || 'generation'}`, async (t) => {
    const f = fixture(t);
    f.seed();
    await f.run();
    await f.run('0.2.0');
    const selected = f.read();
    fs.rmSync(path.join(f.root, selected.state, missing), { recursive: true });
    await assert.rejects(
      startLauncher({
        root: f.root,
        appDir: path.join(f.root, selected.release),
        browser() {
          throw new Error('Must not open');
        },
      }),
      (error) => {
        assert.match(error.message, /active study state is missing/);
        assert.match(error.message, /Restore the complete private backup/);
        assert.equal(error.message.includes(f.root), false);
        assert.equal(error.message.includes('ENOENT'), false);
        return true;
      },
    );
    assert.deepEqual(f.read(), selected);
    assert.equal(fs.readFileSync(path.join(f.root, 'data/app.db'), 'utf8'), 'offline database');
  });
}
