#!/usr/bin/env node
/** Native, disposable upgrade acceptance. Never modifies the distributed archive. */
import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { childEnvironment } from '../../scripts/launcher.mjs';
import { observeLauncher } from './launcher-progress.mjs';

const self = fileURLToPath(import.meta.url);
const repo = path.resolve(path.dirname(self), '../..');
if (process.argv[2] === '--install-worker') {
  const [root, staged, version, killPhase] = process.argv.slice(3);
  const { installRelease } = await import(
    pathToFileURL(path.join(staged, 'scripts/desktop/install-release.mjs'))
  );
  await installRelease({
    root,
    staged,
    version,
    onPhase(phase) {
      if (phase === killPhase) {
        fs.writeSync(1, `kill-boundary:${phase}\n`);
        process.kill(process.pid, 'SIGKILL');
      }
    },
  });
} else {
  await acceptance();
}
async function acceptance() {
  const platform = `${process.platform}-${process.arch}`;
  const artifacts = path.resolve(process.argv[2] || path.join(repo, 'build/desktop', platform));
  const asset = fs
    .readdirSync(artifacts)
    .find((name) => name.endsWith(process.platform === 'win32' ? '.zip' : '.tar.gz'));
  assert.ok(asset, 'Native packaged archive exists');
  const archive = path.join(artifacts, asset);
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'Examify upgrade acceptance '));
  const root = path.join(fixture, 'Private Examify');
  fs.mkdirSync(root, { mode: 0o700 });
  const env = {
    ...childEnvironment(),
    PATH:
      process.platform === 'win32'
        ? `${process.env.SystemRoot}\\system32;${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0`
        : '',
  };
  const children = new Set();
  const browserWaiters = [];
  let sequence = 0;
  let node;
  function marker() {
    return JSON.parse(fs.readFileSync(path.join(root, 'installation.json'), 'utf8'));
  }
  function stage(version, failure) {
    const temp = fs.mkdtempSync(path.join(root, '.install.'));
    const app = path.join(temp, 'app');
    fs.mkdirSync(app);
    if (process.platform === 'win32') {
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(repo, 'scripts/desktop/archive.ps1'),
          '-Operation',
          'extract',
          '-Source',
          archive,
          '-Destination',
          app,
        ],
        { stdio: 'pipe' },
      );
    } else execFileSync('tar', ['-xzf', archive, '-C', app], { stdio: 'pipe' });
    const manifest = JSON.parse(fs.readFileSync(path.join(app, 'desktop-release.json'), 'utf8'));
    // This is a disposable fixture derived from the actual native archive, not a
    // release publication. Distinct SQL below proves a real migration occurred.
    fs.writeFileSync(
      path.join(app, 'desktop-release.json'),
      JSON.stringify({ ...manifest, version, upgradeProtocol: 1 }),
    );
    if (version !== '0.1.0') {
      const migrations = path.join(app, 'src/lib/db/migrations');
      const journalPath = path.join(migrations, 'meta/_journal.json');
      const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
      const last = journal.entries.at(-1);
      const tag = `${String(last.idx + 1).padStart(4, '0')}_native_upgrade_fixture`;
      journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1000, tag });
      fs.writeFileSync(journalPath, JSON.stringify(journal));
      fs.writeFileSync(
        path.join(migrations, `${tag}.sql`),
        failure === 'migration'
          ? 'THIS IS DELIBERATELY INVALID SQL;'
          : "ALTER TABLE exam_attempts ADD COLUMN upgrade_fixture TEXT NOT NULL DEFAULT 'migrated-v2';",
      );
      if (failure === 'startup') fs.writeFileSync(path.join(app, 'server.js'), 'process.exit(71);');
    }
    return app;
  }
  function install(staged, version, killPhase = '') {
    const bundledRuntime = path.join(
      staged,
      process.platform === 'win32' ? 'runtime/node.exe' : 'runtime/bin/node',
    );
    // Like the real installer, run a fresh copy outside the app that gets moved
    // and synced. Windows locks a running executable against those operations.
    // Each stage has a unique parent; retain its runtime until fixture cleanup
    // so interrupted workers never cause a later install to overwrite it.
    const runtime = path.join(
      path.dirname(staged),
      process.platform === 'win32' ? 'install-node.exe' : 'install-node',
    );
    fs.copyFileSync(bundledRuntime, runtime, fs.constants.COPYFILE_EXCL);
    execFileSync(runtime, [self, '--install-worker', root, staged, version, killPhase], {
      env,
      stdio: 'pipe',
      timeout: 180000,
    });
  }
  function snapshot(directory) {
    const entries = {};
    function visit(dir, prefix = '') {
      for (const name of fs.readdirSync(dir).sort()) {
        const file = path.join(dir, name),
          key = `${prefix}${name}`;
        const stat = fs.lstatSync(file);
        assert.ok(!stat.isSymbolicLink(), 'Private state contains no links');
        if (stat.isDirectory()) visit(file, `${key}/`);
        else entries[key] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      }
    }
    visit(directory);
    return entries;
  }
  function launch(appDir, targetRoot = root) {
    const proc = fork(path.join(repo, 'tests/desktop/launcher-child.mjs'), [appDir, targetRoot], {
      execPath: node,
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.add(proc);
    proc.stdout.resume();
    proc.stderr.resume();
    proc.once('exit', () => children.delete(proc));
    // A reused launch asks the original launcher to open its browser, so its
    // capability arrives over the original child's IPC, not the reused child's.
    const browserUrl = new Promise((resolve, reject) => {
      const waiter = {
        finish(error, url) {
          clearTimeout(timer);
          const index = browserWaiters.indexOf(waiter);
          if (index !== -1) browserWaiters.splice(index, 1);
          if (error) reject(error);
          else resolve(url);
        },
      };
      const timer = setTimeout(() => waiter.finish(new Error('Browser callback timed out')), 90000);
      timer.unref();
      browserWaiters.push(waiter);
    });
    proc.on('message', (message) => {
      if (message.kind === 'browser') browserWaiters[0]?.finish(undefined, message.url);
    });
    void browserUrl.catch(() => {});
    const observer = observeLauncher(proc, { id: ++sequence });
    proc.once('exit', () => observer.dispose());
    return { proc, ready: observer.ready, browserUrl };
  }
  async function stop(proc) {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => proc.kill('SIGKILL'), 5000);
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      if (proc.connected) proc.send('stop', () => {});
      else proc.kill();
    });
  }
  function sql(appDir, dataRoot, code) {
    return execFileSync(
      node,
      [
        '--input-type=module',
        '-e',
        `import { createRequire } from 'node:module'; import path from 'node:path'; const require = createRequire(path.join(process.argv[1], 'package.json')); const Database = require('better-sqlite3'); const db = new Database(process.argv[2]); ${code}`,
        appDir,
        path.join(dataRoot, 'data/app.db'),
      ],
      { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  }
  async function usable(appDir, targetRoot = root) {
    const running = launch(appDir, targetRoot);
    try {
      const ready = await running.ready;
      const url = new URL(await running.browserUrl);
      const session = await fetch(`${ready.origin}/api/solo/session`, {
        method: 'POST',
        headers: { origin: ready.origin, 'content-type': 'application/json' },
        body: JSON.stringify({ token: url.hash.slice(1) }),
      });
      assert.equal(session.status, 200);
      const cookie = session.headers.get('set-cookie').split(';')[0];
      const home = await fetch(ready.origin, { headers: { cookie } });
      assert.equal(home.status, 200);
      assert.match(await home.text(), /3 done/);
      const reopened = launch(appDir, targetRoot);
      assert.equal(
        (await reopened.ready).reused,
        true,
        'Reopen uses the selected state signing secrets',
      );
      const fresh = new URL(await reopened.browserUrl);
      const freshSession = await fetch(`${ready.origin}/api/solo/session`, {
        method: 'POST',
        headers: { origin: ready.origin, 'content-type': 'application/json' },
        body: JSON.stringify({ token: fresh.hash.slice(1) }),
      });
      assert.equal(
        freshSession.status,
        200,
        'Reopened upgraded app issues a usable fresh capability',
      );
    } finally {
      await stop(running.proc);
    }
  }
  try {
    install(stage('0.1.0'), '0.1.0');
    const old = marker();
    assert.equal(old.protocol, 1);
    const oldApp = path.join(root, old.release);
    node = path.join(
      oldApp,
      process.platform === 'win32' ? 'runtime/node.exe' : 'runtime/bin/node',
    );
    const first = launch(oldApp);
    const ready = await first.ready;
    const { verifyBrowser } = await import('./browser-checks.mjs');
    await verifyBrowser({
      origin: ready.origin,
      browserUrl: await first.browserUrl,
      reopen: async () => {
        const reopened = launch(oldApp);
        await reopened.ready;
        return reopened.browserUrl;
      },
    });
    await stop(first.proc);
    assert.equal(
      JSON.parse(
        sql(
          oldApp,
          root,
          "console.log(JSON.stringify(db.prepare('SELECT count(*) n FROM exam_attempts').get())); db.close();",
        ),
      ).n,
      3,
    );
    // Exit without db.close(): committed WAL frames must be copied, not dropped.
    sql(
      oldApp,
      root,
      "db.pragma('journal_mode=WAL'); db.pragma('wal_autocheckpoint=0'); db.prepare('UPDATE exam_attempts SET score_pct=37 WHERE id=(SELECT min(id) FROM exam_attempts)').run(); process.exit(0);",
    );
    assert.ok(fs.statSync(path.join(root, 'data/app.db-wal')).size > 0);
    const savedData = snapshot(path.join(root, 'data'));
    const savedConfig = snapshot(path.join(root, 'config'));
    assert.ok(
      Object.keys(savedData).some((file) => file.includes('content/')),
      'Authored material and bank exist',
    );
    assert.ok(
      Object.keys(savedConfig).some((file) => file.startsWith('.env')),
      'Saved provider settings exist',
    );
    const savedMarker = fs.readFileSync(path.join(root, 'installation.json'));
    function preserved() {
      assert.deepEqual(fs.readFileSync(path.join(root, 'installation.json')), savedMarker);
      assert.deepEqual(
        snapshot(path.join(root, 'data')),
        savedData,
        'Original database, WAL, materials, banks and results remain byte-identical',
      );
      assert.deepEqual(
        snapshot(path.join(root, 'config')),
        savedConfig,
        'Original secrets and provider settings remain byte-identical',
      );
      assert.ok(fs.existsSync(path.join(oldApp, 'server.js')));
    }
    assert.throws(
      () => install(stage('0.1.0'), '0.1.0', 'before-activate'),
      (error) => String(error.stdout).includes('kill-boundary:before-activate'),
    );
    preserved();
    for (const failure of ['migration', 'startup']) {
      assert.throws(
        () => install(stage('0.2.0', failure), '0.2.0'),
        (error) => /Upgrade migration or startup verification failed/.test(String(error.stderr)),
      );
      preserved();
    }
    for (const phase of ['state-copied', 'before-activate']) {
      assert.throws(
        () => install(stage('0.2.0'), '0.2.0', phase),
        (error) => String(error.stdout).includes(`kill-boundary:${phase}`),
      );
      preserved();
    }
    install(stage('0.2.0'), '0.2.0');
    const upgraded = marker();
    assert.equal(upgraded.version, '0.2.0');
    assert.notEqual(upgraded.release, old.release);
    assert.equal(upgraded.previous.release, old.release);
    assert.match(upgraded.state, /^states\/[a-f0-9]{32}$/);
    assert.deepEqual(snapshot(path.join(root, 'data')), savedData);
    assert.deepEqual(snapshot(path.join(root, 'config')), savedConfig);
    const newApp = path.join(root, upgraded.release);
    const newState = path.join(root, upgraded.state);
    const rows = JSON.parse(
      sql(
        newApp,
        newState,
        "console.log(JSON.stringify(db.prepare('SELECT score_pct, upgrade_fixture FROM exam_attempts ORDER BY id').all())); db.close();",
      ),
    );
    assert.equal(rows.length, 3);
    assert.equal(rows[0].score_pct, 37, 'Committed WAL frame survives upgrade');
    assert.ok(
      rows.every((row) => row.upgrade_fixture === 'migrated-v2'),
      'New packaged SQL migration actually ran',
    );
    assert.deepEqual(snapshot(path.join(newState, 'config')), savedConfig);
    const copiedData = snapshot(path.join(newState, 'data'));
    for (const [file, hash] of Object.entries(savedData)) {
      if (!/^app\.db(?:-|$)/.test(file))
        assert.equal(copiedData[file], hash, 'Every authored material and bank is preserved');
    }
    await usable(newApp);
    // Verify the rollback pair in a disposable independent root, without changing
    // the committed pointer or ever launching old code against migrated state.
    const rollback = path.join(fixture, 'Rollback verification');
    fs.mkdirSync(rollback, { mode: 0o700 });
    for (const name of ['data', 'config'])
      fs.cpSync(path.join(root, name), path.join(rollback, name), { recursive: true });
    await usable(oldApp, rollback);
    console.log(
      'Native upgrade acceptance passed: authored study state, real schema migration, committed WAL, migration/startup failure, hard-kill recovery, immutable rollback pair and authenticated relaunch.',
    );
  } finally {
    for (const waiter of [...browserWaiters]) waiter.finish(new Error('Acceptance stopped'));
    await Promise.all([...children].map(stop));
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}
