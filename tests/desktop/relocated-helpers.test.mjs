import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const scripts = fileURLToPath(new URL('../../scripts/', import.meta.url));

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-relocated-helpers-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staged = path.join(root, '.install.fixture', 'app');
  fs.mkdirSync(staged, { recursive: true });
  fs.cpSync(scripts, path.join(staged, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(staged, 'desktop-release.json'),
    JSON.stringify({
      version: '0.2.0',
      platform: `${process.platform}-${process.arch}`,
      nodeVersion: process.versions.node,
      upgradeProtocol: 1,
    }),
  );
  for (const name of ['data', 'config']) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  fs.writeFileSync(path.join(root, 'data/app.db'), 'preserved database', { mode: 0o600 });
  fs.writeFileSync(path.join(root, 'config/secrets.json'), '{"secret":"fixture"}', { mode: 0o600 });
  const previous = {
    app: 'examify-solo',
    protocol: 1,
    version: '0.1.0',
    initialized: true,
    release: `releases/0.1.0-${'a'.repeat(32)}`,
  };
  fs.writeFileSync(path.join(root, 'installation.json'), JSON.stringify(previous), { mode: 0o600 });
  const { installRelease } = await import(
    pathToFileURL(path.join(staged, 'scripts/desktop/install-release.mjs'))
  );
  return { root, staged, previous, installRelease };
}

for (const realWindows of [false, true]) {
  test(
    `relocated installer uses live helpers for copied state and candidate locks (${realWindows ? 'real Windows' : 'injected Windows'})`,
    {
      skip: realWindows && process.platform !== 'win32',
    },
    async (t) => {
      const f = await fixture(t);
      const calls = [];
      let finalApp;
      const marker = await f.installRelease({
        root: f.root,
        staged: f.staged,
        version: '0.2.0',
        prepare() {},
        bootstrap() {},
        probe({ appDir, root }) {
          finalApp = appDir;
          assert.equal(fs.existsSync(f.staged), false);
          assert.equal(
            fs.readFileSync(path.join(root, 'data/app.db'), 'utf8'),
            'preserved database',
          );
        },
        helperOptions: {
          platform: 'win32',
          spawn(command, args, options) {
            const helper = args[args.indexOf('-File') + 1];
            const target = args[args.indexOf('-Path') + 1];
            const moved = !fs.existsSync(f.staged);
            assert.ok(fs.existsSync(helper), `Helper must still exist: ${helper}`);
            if (moved) assert.ok(helper.startsWith(path.join(f.root, 'releases') + path.sep));
            else assert.ok(helper.startsWith(f.staged + path.sep));
            calls.push({ helper, target, moved });
            return realWindows ? spawnSync(command, args, options) : { status: 0 };
          },
        },
      });
      const candidate = path.join(f.root, marker.state);
      const movedCalls = calls.filter(({ moved }) => moved);
      assert.ok(movedCalls.length > 0);
      assert.ok(movedCalls.every(({ helper }) => helper.startsWith(finalApp + path.sep)));
      const inventoryCalls = movedCalls.filter(
        ({ helper }) => path.basename(helper) === 'inspect-state.ps1',
      );
      assert.deepEqual(
        inventoryCalls.map(({ target }) => target),
        [f.root, f.root, candidate],
        'Source inventory, copy revalidation and candidate validation all use the relocated helper',
      );
      for (const name of ['instance.sqlite', 'worker.sqlite']) {
        assert.ok(
          movedCalls.some(
            ({ target }) => target === path.join(candidate, '.examify-operations', name),
          ),
          `Candidate ${name} must receive its ACL through the relocated helper`,
        );
      }
      assert.equal(fs.readFileSync(path.join(f.root, 'data/app.db'), 'utf8'), 'preserved database');
      assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(f.root, 'installation.json'), 'utf8')),
        marker,
      );
    },
  );
}

test('post-rename helper failure preserves the previous activation pointer', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.installRelease({
      root: f.root,
      staged: f.staged,
      version: '0.2.0',
      prepare() {},
      bootstrap() {},
      probe() {},
      helperOptions: {
        platform: 'win32',
        spawn(command, args) {
          const helper = args[args.indexOf('-File') + 1];
          assert.ok(fs.existsSync(helper));
          return { status: path.basename(helper) === 'inspect-state.ps1' ? 1 : 0 };
        },
      },
    }),
    /Study state must be owned/,
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(f.root, 'installation.json'), 'utf8')),
    f.previous,
  );
  assert.equal(fs.readFileSync(path.join(f.root, 'data/app.db'), 'utf8'), 'preserved database');
});
