import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

// Real archive, checksum tools and runtime, with a minimal payload coordinator.
// This tests installer selection/integrity only, not the app or locked activation.
const source = fs.readFileSync(path.resolve(import.meta.dirname, '../../install-solo.sh'), 'utf8');
const version = '0.1.0-installer-fixture';
const asset = `examify-${version}-linux-x64.tar.gz`;
let fixture;
let archive;
let sha256;
let bash;

function systemTool(name) {
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate);
    } catch {
      // Try the next PATH entry when this candidate is absent or inaccessible.
    }
  }
  throw new Error(`Required standard system tool: ${name}`);
}

describe('Linux solo installer archive selection', { skip: process.platform !== 'linux' }, () => {
  before(() => {
    assert.notEqual(process.getuid(), 0, 'Run the installer tests as an ordinary user');
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'Examify installer fixtures '));
    const app = path.join(fixture, 'Fixture package');
    fs.mkdirSync(path.join(app, 'runtime/bin'), { recursive: true });
    fs.mkdirSync(path.join(app, 'scripts/desktop'), { recursive: true });
    fs.copyFileSync(process.execPath, path.join(app, 'runtime/bin/node'));
    fs.chmodSync(path.join(app, 'runtime/bin/node'), 0o700);
    fs.writeFileSync(path.join(app, 'scripts/launcher.mjs'), '// Completeness fixture only.\n');
    fs.writeFileSync(
      path.join(app, 'scripts/desktop/install-release.mjs'),
      "import fs from 'node:fs'; import path from 'node:path';\n" +
        'const [root, staged, version] = process.argv.slice(2);\n' +
        "fs.writeFileSync(path.join(root, 'payload.json'), JSON.stringify({version, node: process.version, staged}));\n",
    );
    archive = path.join(fixture, asset);
    execFileSync(systemTool('tar'), ['-czf', archive, '-C', app, '.'], {
      env: { PATH: path.dirname(systemTool('gzip')), LANG: 'C' },
      timeout: 60_000,
    });
    sha256 = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    bash = systemTool('bash');
  });
  after(() => {
    if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
  });

  function scenario(t, { download = false, pinned = true } = {}) {
    const directory = fs.mkdtempSync(path.join(fixture, 'Extracted preview with spaces '));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const installer = path.join(directory, 'install-solo.sh');
    fs.writeFileSync(
      installer,
      pinned
        ? source.replaceAll('__EXAMIFY_VERSION__', version).replaceAll('__EXAMIFY_SHA256__', sha256)
        : source,
    );
    const bin = path.join(directory, 'System tools');
    const home = path.join(directory, 'Home');
    fs.mkdirSync(bin);
    fs.mkdirSync(home);
    for (const name of [
      'tar',
      'gzip',
      'sha256sum',
      'mktemp',
      'uname',
      'id',
      'dirname',
      'ls',
      'mkdir',
      'chmod',
      'cp',
      'rm',
    ])
      fs.symlinkSync(systemTool(name), path.join(bin, name));
    const requests = path.join(directory, 'download-arguments.txt');
    // A bounded downloader fixture: never connects to a network. Every other
    // command is a real OS binary, including archive extraction and checksum.
    fs.writeFileSync(
      path.join(bin, 'curl'),
      '#!/bin/bash\nprintf "%s\\n" "$@" > "$FIXTURE_REQUESTS"\n' +
        (download
          ? 'while [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then cp -- "$FIXTURE_ARCHIVE" "$2"; exit; fi; shift; done\nexit 91\n'
          : 'exit 90\n'),
      { mode: 0o700 },
    );
    const root = path.join(directory, 'Installed fixture');
    const run = (...args) => {
      const result = spawnSync(
        bash,
        [installer, '--root', root, '--no-launch', '--no-shortcut', ...args],
        {
          cwd: fixture,
          env: {
            PATH: bin,
            HOME: home,
            XDG_DATA_HOME: home,
            LANG: 'C',
            FIXTURE_REQUESTS: requests,
            FIXTURE_ARCHIVE: archive,
          },
          encoding: 'utf8',
          timeout: 60_000,
        },
      );
      assert.ifError(result.error);
      assert.equal(result.signal, null, result.stderr);
      return result;
    };
    return { directory, root, requests, run };
  }

  function assertPayload(root) {
    const payload = JSON.parse(fs.readFileSync(path.join(root, 'payload.json'), 'utf8'));
    assert.equal(payload.version, version);
    assert.equal(payload.node, process.version);
    assert.match(path.relative(root, payload.staged), /^\.install\.[^/]+\/app$/);
    assert.deepEqual(fs.readdirSync(root), ['payload.json'], 'Temporary staging is cleaned up');
  }

  test('uses the exact sibling archive from a folder with spaces and a different working directory', (t) => {
    const { directory, root, requests, run } = scenario(t);
    fs.copyFileSync(archive, path.join(directory, asset));
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assertPayload(root);
    assert.equal(fs.existsSync(requests), false, 'No download when the pinned sibling is present');
  });

  test('explicit --archive takes precedence over an invalid sibling', (t) => {
    const { directory, root, requests, run } = scenario(t);
    fs.writeFileSync(path.join(directory, asset), 'Wrong sibling bytes');
    const result = run('--archive', archive);
    assert.equal(result.status, 0, result.stderr);
    assertPayload(root);
    assert.equal(fs.existsSync(requests), false);
  });

  test('an explicit missing archive fails instead of falling back to the sibling or download', (t) => {
    const { directory, root, requests, run } = scenario(t);
    fs.copyFileSync(archive, path.join(directory, asset));
    const result = run('--archive', path.join(directory, 'Missing explicit archive'));
    assert.notEqual(result.status, 0);
    assert.deepEqual(fs.readdirSync(root), []);
    assert.equal(fs.existsSync(requests), false);
  });

  test('a mismatched sibling checksum stops before extraction or payload execution', (t) => {
    const { directory, root, requests, run } = scenario(t);
    fs.copyFileSync(archive, path.join(directory, asset));
    fs.appendFileSync(path.join(directory, asset), 'Tampered bytes');
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Download checksum mismatch/);
    assert.deepEqual(fs.readdirSync(root), [], 'No extracted or executed payload remains');
    assert.equal(fs.existsSync(requests), false, 'Corruption does not trigger a download fallback');
  });

  test('an absent pinned sibling uses the exact HTTPS release URL and ignores other archives', (t) => {
    const { directory, root, requests, run } = scenario(t, { download: true });
    fs.writeFileSync(
      path.join(directory, 'examify-other-version-linux-x64.tar.gz'),
      'Unpinned bytes',
    );
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assertPayload(root);
    const args = fs.readFileSync(requests, 'utf8').trimEnd().split('\n');
    assert.deepEqual(args.slice(0, -2), [
      '--fail',
      '--location',
      '--proto',
      '=https',
      '--proto-redir',
      '=https',
      '--tlsv1.2',
      '--retry',
      '2',
      `https://github.com/atk0309/project_Examify/releases/download/${version}/${asset}`,
    ]);
    assert.equal(args.at(-2), '-o');
    assert.ok(args.at(-1).startsWith(root + path.sep));
    assert.ok(args.at(-1).endsWith('/package.tar.gz'));
  });

  test('the unpinned source template refuses even when a sibling archive exists', (t) => {
    const { directory, root, requests, run } = scenario(t, { pinned: false });
    fs.copyFileSync(archive, path.join(directory, asset));
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /installer source template/);
    assert.equal(fs.existsSync(root), false);
    assert.equal(fs.existsSync(requests), false);
  });
});
