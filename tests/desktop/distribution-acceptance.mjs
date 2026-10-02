#!/usr/bin/env node
/**
 * Native download-path acceptance using a disposable, loopback HTTP release mirror.
 * Usage: node tests/desktop/distribution-acceptance.mjs ARTIFACT_DIRECTORY_OR_ARCHIVE
 *
 * The distribution and archive are verified before any copies are made. Only the
 * copied installers' literal origin/HTTPS requirements change for this fixture;
 * the copied Windows CMD must additionally pin the adapted PS bytes. Production
 * scripts, archive pins and published assets are never changed. This proves the
 * download layout, bootstrap and integrity/activation behavior, NOT real GitHub
 * HTTPS, redirects, certificates, download reputation or SmartScreen behavior.
 * Real login/browser coverage remains in acceptance.mjs.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnvironment } from '../../scripts/launcher.mjs';
import { assetNames, digest, verifyDistribution } from '../../scripts/desktop/distribution.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const platform = `${process.platform}-${process.arch}`;
assert.ok(['linux-x64', 'win32-x64'].includes(platform), 'Run on a supported native platform');
assert.ok(process.argv.length <= 3, 'Pass one artifact directory or native archive path');
const input = path.resolve(process.argv[2] || path.join(repo, 'build/desktop', platform));
const artifacts = fs.statSync(input).isDirectory() ? input : path.dirname(input);
const distribution = verifyDistribution(artifacts, platform);
const asset = assetNames(distribution.version, platform).find((name) =>
  /\.(zip|tar.gz)$/.test(name),
);
const archive = path.join(artifacts, asset);
if (input !== artifacts) assert.equal(input, archive, 'Argument names the verified native archive');
const archiveHash = digest(archive);
const windows = process.platform === 'win32';
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'Examify distribution acceptance '));
const children = new Set();
const httpErrors = [];
let server;
let scenario;

function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2, `Expected one fixture adaptation: ${before}`);
  return source.replace(before, after);
}

function systemTool(name) {
  const candidate = (process.env.PATH || '').split(path.delimiter).find((directory) => {
    try {
      fs.accessSync(path.join(directory, name), fs.constants.X_OK);
      return fs.statSync(path.join(directory, name)).isFile();
    } catch {
      return false;
    }
  });
  assert.ok(candidate, `Required standard system tool: ${name}`);
  return fs.realpathSync(path.join(candidate, name));
}

function environment() {
  const env = childEnvironment();
  // Avoid Windows' case-insensitive duplicate PATH keys, and never inherit user
  // curl/wget profiles, proxy settings, PowerShell profiles or app/provider keys.
  for (const key of Object.keys(env)) {
    if (/^(PATH|HOME|USERPROFILE|LOCALAPPDATA|APPDATA|TEMP|TMP|TMPDIR|XDG_.*)$/i.test(key)) {
      delete env[key];
    }
  }
  const home = path.join(fixture, 'Home');
  const temp = path.join(fixture, 'Temp');
  fs.mkdirSync(home);
  fs.mkdirSync(temp);
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: home,
    APPDATA: home,
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    XDG_CONFIG_HOME: home,
    XDG_CACHE_HOME: home,
    XDG_DATA_HOME: home,
  });
  if (windows) {
    const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
    assert.ok(systemRoot, 'Windows system directory is available');
    env.PATH = [
      path.join(systemRoot, 'System32'),
      path.join(systemRoot, 'System32/WindowsPowerShell/v1.0'),
    ].join(path.delimiter);
  } else {
    assert.notEqual(process.getuid(), 0, 'Run the real Linux installer as an ordinary user');
    const bin = path.join(fixture, 'System tools');
    fs.mkdirSync(bin);
    // Links to real installed OS binaries, not command shims. In particular no
    // host Node, npm, pnpm or Git can satisfy a missing private-runtime dependency.
    for (const name of [
      'bash',
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
      'curl',
    ]) {
      fs.symlinkSync(systemTool(name), path.join(bin, name));
    }
    env.PATH = bin;
  }
  return env;
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (windows) {
    const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
    await new Promise((resolve) => {
      const killer = spawn(
        path.join(systemRoot, 'System32/taskkill.exe'),
        ['/pid', String(child.pid), '/t', '/f'],
        { stdio: 'ignore', windowsHide: true },
      );
      killer.once('error', resolve);
      killer.once('close', resolve);
    });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
}

// Do not use execFileSync for the installer: this process must keep serving the
// mirror while the real curl/PowerShell child downloads its pinned assets.
async function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: fixture,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !windows,
    windowsHide: true,
    ...options,
  });
  children.add(child);
  let output = '';
  let timedOut = false;
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      output = (output + chunk).slice(-128 * 1024);
    });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    void stop(child);
  }, 300_000);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal, output }));
    });
    assert.equal(timedOut, false, `Native command exceeded five minutes:\n${output}`);
    return result;
  } finally {
    clearTimeout(timer);
    children.delete(child);
  }
}

function assertNoActivation(root) {
  // Even releases/bootstrap/state directories would mean unverified archive code
  // reached the coordinator. Failed download checks must leave only an empty root.
  assert.deepEqual(
    fs.existsSync(root) ? fs.readdirSync(root) : [],
    [],
    'No unverified activation or state',
  );
}

function assertRequests(expected) {
  assert.ok(scenario.requests.length, `${scenario.name}: native downloader reached the mirror`);
  assert.deepEqual(httpErrors, [], 'Mirror completed every response without an I/O error');
  for (const request of scenario.requests) {
    assert.equal(request.method, 'GET', 'Installer uses a real GET download');
    assert.ok(expected.includes(request.url), `Unexpected download path: ${request.url}`);
  }
  // Consecutive retries are fine; no fallback to moving/latest or a local archive.
  const observed = scenario.requests
    .map(({ url }) => url)
    .filter((url, index, urls) => !index || url !== urls[index - 1]);
  assert.deepEqual(observed, expected, `${scenario.name}: exact pinned release download layout`);
}

try {
  const env = environment();
  const source = path.join(fixture, 'Downloaded installer');
  fs.mkdirSync(source);
  const wrongFiles = path.join(fixture, 'Wrong release archive contents');
  fs.mkdirSync(wrongFiles);
  fs.writeFileSync(
    path.join(wrongFiles, 'desktop-release.json'),
    JSON.stringify({
      ...distribution,
      version: `${distribution.version}-different-release`,
    }),
  );
  // A structurally valid archive with a different release identity, rather than a
  // second arbitrary corrupt byte string. Its untrusted metadata is never executed.
  const wrongArchive = path.join(fixture, windows ? 'wrong-release.zip' : 'wrong-release.tar.gz');
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const packed = windows
    ? await run(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory(${quote(wrongFiles)}, ${quote(wrongArchive)})`,
        ],
        { env },
      )
    : await run('tar', ['-czf', wrongArchive, '-C', wrongFiles, '.'], { env });
  assert.equal(packed.code, 0, `Create a valid wrong-release archive:\n${packed.output}`);
  assert.notEqual(digest(wrongArchive), archiveHash);

  const downloadPrefix = `/atk0309/project_Examify/releases/download/${distribution.version}/`;
  const archivePath = `${downloadPrefix}${asset}`;
  const psPath = `${downloadPrefix}install.ps1`;
  let powershell;
  server = http.createServer((request, response) => {
    if (!scenario) {
      response.writeHead(503).end();
      return;
    }
    scenario.requests.push({ method: request.method, url: request.url });
    let body;
    let file;
    if (request.method === 'GET' && windows && request.url === psPath) {
      body =
        scenario.name === 'corrupt-powershell'
          ? Buffer.from(`${powershell}\n# corrupt download fixture\n`)
          : Buffer.from(powershell);
    } else if (
      request.method === 'GET' &&
      request.url === archivePath &&
      scenario.name !== 'missing-archive'
    ) {
      if (scenario.name === 'corrupt-archive')
        body = Buffer.from('deliberately corrupt archive bytes');
      else file = scenario.name === 'mismatched-archive' ? wrongArchive : archive;
    } else {
      response.writeHead(404).end('Release asset not found');
      return;
    }
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': body ? body.length : fs.statSync(file).size,
      'cache-control': 'no-store',
    });
    if (body) response.end(body);
    else {
      const stream = fs.createReadStream(file);
      stream.once('error', (error) => {
        httpErrors.push(error.message);
        response.destroy(error);
      });
      response.once('close', () => stream.destroy());
      stream.pipe(response);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const installerName = windows ? 'install.cmd' : 'install-solo.sh';
  const installer = path.join(source, installerName);
  if (windows) {
    const originalPs = path.join(artifacts, 'install.ps1');
    powershell = replaceOnce(fs.readFileSync(originalPs, 'utf8'), 'https://github.com', origin);
    const localPsHash = createHash('sha256').update(powershell).digest('hex');
    let cmd = replaceOnce(
      fs.readFileSync(path.join(artifacts, installerName), 'utf8'),
      'https://github.com',
      origin,
    );
    cmd = replaceOnce(
      cmd,
      `EXAMIFY_INSTALL_PS_SHA256=${digest(originalPs)}`,
      `EXAMIFY_INSTALL_PS_SHA256=${localPsHash}`,
    );
    fs.writeFileSync(installer, cmd);
  } else {
    let bash = replaceOnce(
      fs.readFileSync(path.join(artifacts, installerName), 'utf8'),
      'https://github.com',
      origin,
    );
    bash = replaceOnce(
      bash,
      "--proto '=https' --proto-redir '=https' --tlsv1.2",
      "--proto '=http' --proto-redir '=http'",
    );
    bash = replaceOnce(bash, 'wget --https-only ', 'wget ');
    fs.writeFileSync(installer, bash);
  }
  assert.deepEqual(
    fs.readdirSync(source),
    [installerName],
    'Start with the lone downloaded entrypoint',
  );
  const install = (root) =>
    windows
      ? run(
          process.env.ComSpec || process.env.COMSPEC || 'cmd.exe',
          ['/d', '/s', '/c', `""${installer}" -InstallRoot "${root}" -NoLaunch -NoShortcut"`],
          { env, windowsVerbatimArguments: true },
        )
      : run('bash', [installer, '--root', root, '--no-launch', '--no-shortcut'], { env });
  const expected = windows ? [psPath, archivePath] : [archivePath];
  for (const name of [
    'missing-archive',
    'corrupt-archive',
    'mismatched-archive',
    ...(windows ? ['corrupt-powershell'] : []),
  ]) {
    scenario = { name, requests: [] };
    const root = path.join(fixture, `Rejected ${name}`);
    const result = await install(root);
    assert.notEqual(result.code, 0, `${name} must fail`);
    assert.equal(result.signal, null, `${name} exits rather than crashing`);
    if (name !== 'missing-archive') {
      assert.match(
        result.output,
        name === 'corrupt-powershell'
          ? /Installer checksum mismatch/
          : /Download checksum mismatch/,
        `${name}: rejected by the pin before execution/extraction`,
      );
    }
    assertRequests(name === 'corrupt-powershell' ? [psPath] : expected);
    assertNoActivation(root);
    console.log(`Native download acceptance: ${name} rejected before activation.`);
  }

  scenario = { name: 'success', requests: [] };
  const root = path.join(fixture, 'Verified Examify');
  const result = await install(root);
  assert.equal(result.code, 0, `Real downloaded archive installs successfully:\n${result.output}`);
  assertRequests(expected);
  const marker = JSON.parse(fs.readFileSync(path.join(root, 'installation.json'), 'utf8'));
  assert.equal(marker.version, distribution.version);
  assert.equal(marker.protocol, 1);
  assert.ok(marker.release.startsWith(`releases/${distribution.version}-`));
  assert.equal(
    path.dirname(marker.release),
    'releases',
    'Activation points inside its release directory',
  );
  const app = path.join(root, marker.release);
  const release = JSON.parse(fs.readFileSync(path.join(app, 'desktop-release.json'), 'utf8'));
  for (const key of [
    'version',
    'platform',
    'sourceCommit',
    'lockfileSha256',
    'nodeVersion',
    'nodeArchiveSha256',
    'localPreview',
    'sourceDirty',
  ]) {
    assert.equal(
      release[key],
      distribution[key],
      `Installed ${key} matches the verified distribution`,
    );
  }
  const runtime = path.join(app, windows ? 'runtime/node.exe' : 'runtime/bin/node');
  const native = await run(runtime, ['--version'], { env });
  assert.equal(native.code, 0, 'Installed private Node runs without a host Node on PATH');
  assert.equal(native.output.trim(), `v${distribution.nodeVersion}`);
  assert.ok(fs.statSync(path.join(root, windows ? 'Examify.cmd' : 'Examify')).isFile());
  assert.deepEqual(
    fs.readdirSync(source),
    [installerName],
    'Bootstrap did not rely on a sibling archive or PowerShell file',
  );
  assert.deepEqual(
    verifyDistribution(artifacts, platform),
    distribution,
    'Original distribution is unchanged',
  );
  console.log(
    `Native ${platform} download acceptance passed: pinned release paths, ${windows ? 'lone CMD and verified downloaded PowerShell, ' : ''}real archive activation and private Node. No host Node/Git/pnpm on installer PATH.`,
  );
  console.log(
    'Loopback HTTP mirror only; GitHub HTTPS/redirects, download reputation/SmartScreen, shortcuts and browser/login behavior are not covered by this test.',
  );
} finally {
  await Promise.all([...children].map(stop));
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  fs.rmSync(fixture, { recursive: true, force: true });
}
