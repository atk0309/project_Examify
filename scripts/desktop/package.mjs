#!/usr/bin/env node
/** Run after a native, frozen-lockfile production build. Never publishes a release. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertReleaseInventory, copyStandaloneRuntime, copyRuntimeTree } from './inventory.mjs';
import { writeDistribution, policyName, committedLockfileSha256 } from './distribution.mjs';
import { retainRuntimeLicenses } from './licenses.mjs';
import { createRuntimePolicy, standaloneConfig } from './distribution-policy.mjs';

const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const pins = JSON.parse(fs.readFileSync(path.join(repo, 'scripts/desktop/runtime.json'), 'utf8'));
const platform = `${process.platform}-${process.arch}`;
const pin = pins.platforms[platform];
const version = process.argv[2];
if (!version || !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(version))
  throw new Error('Pass an immutable release tag or ci-<full commit SHA>.');
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repo,
  encoding: 'utf8',
}).trim();
const localPreview = process.argv[3] === '--allow-dirty-preview' && version.startsWith('ci-');
if (!localPreview) {
  if (execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim())
    throw new Error('Release packaging requires a clean committed checkout.');
  const provenance = JSON.parse(
    fs.readFileSync(path.join(repo, '.next/desktop-build.json'), 'utf8'),
  );
  if (
    provenance.commit !== sourceCommit ||
    provenance.clean !== true ||
    provenance.imageOptimization !== 'disabled'
  )
    throw new Error('Run scripts/desktop/build.mjs for this exact source commit first.');
}
if (!pin) throw new Error(`No portable release is supported for ${platform}.`);
if (process.versions.node !== pins.version)
  throw new Error(`Build this release with Node ${pins.version}.`);
if (!fs.existsSync(path.join(repo, '.next/standalone/server.js')))
  throw new Error('Run the native production build first.');
const destination = path.join(repo, 'build', 'desktop', platform);
if (fs.existsSync(destination) && fs.readdirSync(destination).length)
  throw new Error(
    'Package output already exists; preserve the previous candidate and use a clean output directory.',
  );
fs.mkdirSync(destination, { recursive: true });
const stage = fs.mkdtempSync(path.join(destination, 'stage-'));
const app = path.join(stage, 'app');
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const copy = (source, target) => {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  copyRuntimeTree(source, target);
};
function command(binary, args) {
  execFileSync(binary, args, { cwd: repo, stdio: 'inherit' });
}
try {
  if (standaloneConfig(path.join(repo, '.next/standalone')).images?.unoptimized !== true)
    throw new Error('Only verified portable builds may omit optional image links.');
  copyStandaloneRuntime(path.join(repo, '.next/standalone'), app, {
    sourceNodeModules: path.join(repo, 'node_modules'),
    omitPortableImageLinks: true,
  });
  copy(path.join(repo, '.next/static'), path.join(app, '.next/static'));
  // Only committed sample content, never ignored study PDFs or family content.
  const trackedContent = execFileSync(
    'git',
    [
      'ls-tree',
      '-r',
      '--name-only',
      '-z',
      'HEAD',
      '--',
      'content',
      'public',
      'tools/examify-ingest/prompts',
    ],
    { cwd: repo, encoding: 'utf8' },
  )
    .split('\0')
    .filter(
      (name) =>
        name &&
        (!name.startsWith('tools/') ||
          /^tools\/examify-ingest\/prompts\/v[0-9]+\/generate-bank\.md$/.test(name)),
    );
  if (!trackedContent.some((name) => name.startsWith('tools/examify-ingest/prompts/')))
    throw new Error('Committed generation prompt assets are missing.');
  for (const name of trackedContent) {
    const target = path.join(app, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      execFileSync('git', ['show', `HEAD:${name}`], { cwd: repo, maxBuffer: 16 * 1024 * 1024 }),
    );
  }
  copy(path.join(repo, 'src/lib/db/migrations'), path.join(app, 'src/lib/db/migrations'));
  copy(path.join(repo, 'scripts/examify-data.mjs'), path.join(app, 'scripts/examify-data.mjs'));
  copy(path.join(repo, 'scripts/launcher.mjs'), path.join(app, 'scripts/launcher.mjs'));
  copy(
    path.join(repo, 'scripts/desktop/settings-loader.cjs'),
    path.join(app, 'scripts/desktop/settings-loader.cjs'),
  );
  copy(
    path.join(repo, 'scripts/desktop/private-path.ps1'),
    path.join(app, 'scripts/desktop/private-path.ps1'),
  );
  copy(
    path.join(repo, 'scripts/desktop/restore-links.mjs'),
    path.join(app, 'scripts/desktop/restore-links.mjs'),
  );
  for (const name of [
    'operation-lock.mjs',
    'dispatch.mjs',
    'install-release.mjs',
    'state-store.mjs',
    'inspect-state.ps1',
    'upgrade-probe.mjs',
    'worker-guard.cjs',
    'worker-runner.mjs',
  ])
    copy(path.join(repo, 'scripts/desktop', name), path.join(app, 'scripts/desktop', name));
  copy(path.join(repo, 'LICENSE'), path.join(app, 'LICENSE'));
  // tsx pins its esbuild dependency in pnpm-lock; avoid fetching a build-time tool.
  const esbuild = require(require.resolve('esbuild', { paths: [require.resolve('tsx')] }));
  const bundledInputs = [];
  const bundle = async (options) => {
    const result = await esbuild.build({ ...options, absWorkingDir: repo, metafile: true });
    bundledInputs.push(
      ...Object.keys(result.metafile.inputs).map((name) => path.resolve(repo, name)),
    );
  };
  await bundle({
    entryPoints: [path.join(repo, 'src/lib/db/migrate.ts')],
    outfile: path.join(app, 'scripts/migrate.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['better-sqlite3'],
    plugins: [
      {
        name: 'keep-data-cli-separate',
        setup(build) {
          build.onResolve({ filter: /examify-data\.mjs$/ }, () => ({
            path: './examify-data.mjs',
            external: true,
          }));
        },
      },
    ],
  });
  await bundle({
    entryPoints: [path.join(repo, 'src/lib/solo-preflight.ts')],
    outfile: path.join(app, 'scripts/solo-preflight.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['better-sqlite3'],
  });
  // Exercise the real runtime prompt loader without invoking any provider.
  await bundle({
    stdin: {
      contents:
        "import { loadGeneratePrompt } from './tools/examify-ingest/src/prompt.ts'; const prompt = loadGeneratePrompt(process.cwd()); if (!prompt.text.trim() || !prompt.hash) throw new Error('Invalid generation prompt asset.');",
      resolveDir: repo,
      sourcefile: 'verify-prompts.ts',
      loader: 'ts',
    },
    outfile: path.join(app, 'scripts/verify-prompts.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
  });
  const archive = path.join(stage, pin.file);
  const response = await fetch(`https://nodejs.org/download/release/v${pins.version}/${pin.file}`);
  if (!response.ok) throw new Error(`Node download failed (${response.status}).`);
  fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  if (sha256(archive) !== pin.sha256) throw new Error('Pinned Node archive checksum mismatch.');
  const unpacked = path.join(stage, 'node');
  fs.mkdirSync(unpacked);
  if (process.platform === 'win32') {
    command('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-File',
      path.join(repo, 'scripts/desktop/archive.ps1'),
      '-Operation',
      'extract',
      '-Source',
      archive,
      '-Destination',
      unpacked,
    ]);
  } else command('tar', ['-xzf', archive, '-C', unpacked]);
  const nodeRoot = path.join(
    unpacked,
    `node-v${pins.version}-${process.platform === 'win32' ? 'win' : 'linux'}-x64`,
  );
  const runtimeExe = process.platform === 'win32' ? 'node.exe' : 'bin/node';
  copy(path.join(nodeRoot, runtimeExe), path.join(app, 'runtime', runtimeExe));
  copy(path.join(nodeRoot, 'LICENSE'), path.join(app, 'runtime/LICENSE'));
  if (process.platform !== 'win32') fs.chmodSync(path.join(app, 'runtime', runtimeExe), 0o755);
  const identity = {
    version,
    platform,
    upgradeProtocol: 1,
    nodeVersion: pins.version,
    nodeArchiveSha256: pin.sha256,
    sourceCommit,
    localPreview,
    imageOptimization: 'disabled',
    lockfileSha256: committedLockfileSha256(repo),
    sourceDirty: Boolean(
      execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim(),
    ),
  };
  fs.writeFileSync(
    path.join(app, 'desktop-release.json'),
    `${JSON.stringify(identity, null, 2)}\n`,
  );
  const licenses = retainRuntimeLicenses(app, {
    sourceNodeModules: path.join(repo, 'node_modules'),
    bundledInputs,
  });
  for (const warning of licenses.warnings)
    console.warn(`License review note: ${warning.package}: ${warning.reason}`);
  const policy = createRuntimePolicy(app, identity, licenses);
  fs.writeFileSync(
    path.join(app, 'desktop-runtime-policy.json'),
    `${JSON.stringify(policy, null, 2)}\n`,
  );
  const inventory = assertReleaseInventory(app);
  fs.writeFileSync(
    path.join(app, 'release-inventory.json'),
    `${JSON.stringify(inventory, null, 2)}\n`,
  );
  const file = `examify-${version}-${platform}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`;
  const output = path.join(destination, file);
  if (fs.existsSync(output)) fs.unlinkSync(output);
  if (process.platform === 'win32') {
    command('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-File',
      path.join(repo, 'scripts/desktop/archive.ps1'),
      '-Operation',
      'create',
      '-Source',
      app,
      '-Destination',
      output,
    ]);
  } else command('tar', ['-czf', output, '-C', app, '.']);
  const digest = sha256(output);
  fs.writeFileSync(`${output}.sha256`, `${digest}  ${file}\n`);
  const installer = process.platform === 'win32' ? 'install.ps1' : 'install-solo.sh';
  const script = fs
    .readFileSync(path.join(repo, installer), 'utf8')
    .replaceAll('__EXAMIFY_VERSION__', version)
    .replaceAll('__EXAMIFY_SHA256__', digest);
  fs.writeFileSync(path.join(destination, installer), script);
  if (process.platform === 'win32') {
    const cmd = fs
      .readFileSync(path.join(repo, 'install.cmd'), 'utf8')
      .replaceAll('__EXAMIFY_VERSION__', version)
      .replaceAll('__EXAMIFY_INSTALL_PS_SHA256__', sha256(path.join(destination, installer)));
    fs.writeFileSync(path.join(destination, 'install.cmd'), cmd);
  }
  fs.rmSync(stage, { recursive: true, force: true });
  if (
    !localPreview &&
    (execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim() ||
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim() !==
        sourceCommit)
  )
    throw new Error('Source changed during packaging.');
  fs.writeFileSync(
    path.join(destination, policyName(platform)),
    `${JSON.stringify(policy, null, 2)}\n`,
  );
  writeDistribution(destination, identity);
  console.log(`Packaged ${file}; installer pins SHA-256 ${digest}`);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
