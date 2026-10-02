/** Retain upstream evidence; this inventory is not a legal compliance certification. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { relativeRuntimePath } from './inventory.mjs';
import { loadSupplementalNotices } from './supplemental-licenses.mjs';

const noticeName =
  /^(?:licen[sc]e|copying|copyright|notice|third[-_. ]party(?:[-_. ]notices)?)(?:$|[._ -])/i;
const legalSuffix = /\.(?:LEGAL|LICENSE|NOTICE)\.txt$/i;
const packageName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;
const version = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const posix = (value) => value.split(path.sep).join('/');
const moduleDirectory = (dir) => /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^@/.][^/]*$/.test(posix(dir));

function safeFile(root, file) {
  const relative = relativeRuntimePath(root, file);
  if (relative === null || !relative)
    throw new Error('License evidence is outside its permitted root.');
  // Check every ancestor before reading: even an in-tree symlink is not evidence.
  let cursor = root;
  for (const part of relative.split('/')) {
    cursor = path.join(cursor, part);
    if (fs.lstatSync(cursor).isSymbolicLink())
      throw new Error(`Linked license evidence is forbidden: ${relative}`);
  }
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024)
    throw new Error(`License evidence must be a regular file under 8 MiB: ${relative}`);
  return fs.readFileSync(file);
}

function readManifest(root, file) {
  try {
    return JSON.parse(safeFile(root, file).toString('utf8'));
  } catch (error) {
    throw new Error(`Cannot read a safe runtime package manifest: ${error.message}`);
  }
}

/**
 * Run against the fresh, link-free staging directory, after the helper bundles exist.
 * sourceNodeModules must be the native frozen-lockfile installation used for the build.
 * bundledInputs are absolute esbuild metafile input paths for shipped helpers only.
 * No source code, README or arbitrary checkout files are read by the generic collector.
 */
export function retainRuntimeLicenses(app, { sourceNodeModules, bundledInputs = [] } = {}) {
  const staged = fs.realpathSync(app);
  const modules = fs.realpathSync(sourceNodeModules);
  const requestedModules = path.resolve(sourceNodeModules);
  const output = path.join(staged, 'licenses');
  const inventoryFile = path.join(staged, 'THIRD-PARTY-LICENSES.json');
  if (fs.existsSync(output) || fs.existsSync(inventoryFile))
    throw new Error('License retention requires a fresh staging destination.');
  const packages = new Map();
  const components = new Map();
  const pending = [];
  const warnings = [];

  function pinnedPackage(candidate, expected) {
    // Resolve only paths already inside the explicitly permitted installation.
    if (relativeRuntimePath(modules, candidate) === null)
      throw new Error('Runtime package is outside the permitted node_modules.');
    const real = fs.realpathSync(candidate);
    const relative = relativeRuntimePath(modules, real);
    const match = relative?.match(/^\.pnpm\/([^/]+)\/node_modules\/((?:@[^/]+\/)?[^/]+)$/);
    if (!match) throw new Error('Runtime licenses require an exact in-tree pnpm package.');
    const manifest = readManifest(modules, path.join(real, 'package.json'));
    const locator = `${manifest.name?.replace('/', '+')}@${manifest.version}`;
    if (
      !packageName.test(manifest.name ?? '') ||
      !version.test(manifest.version ?? '') ||
      manifest.name !== match[2] ||
      (match[1] !== locator && !match[1].startsWith(`${locator}_`)) ||
      (expected && (expected.name !== manifest.name || expected.version !== manifest.version))
    )
      throw new Error('Runtime license package identity does not match its pinned source.');
    if (!packages.has(relative)) {
      packages.set(relative, {
        name: manifest.name,
        version: manifest.version,
        declaredLicense: typeof manifest.license === 'string' ? manifest.license : null,
        sourcePackage: `node_modules/${relative}`,
        shippedPaths: new Set(),
        bundledInputs: new Set(),
        root: real,
        evidence: [],
      });
    }
    return packages.get(relative);
  }

  function compiledComponent(pkg, relative) {
    if (pkg.name !== 'next') return;
    const match = relative.match(/^dist\/compiled\/((?:@[^/]+\/)?[^@/][^/]*)(?:\/|$)/);
    if (!match) return;
    const component = match[1];
    const key = `${pkg.sourcePackage}/dist/compiled/${component}`;
    if (!components.has(key))
      components.set(key, {
        name: component,
        version: null,
        declaredLicense: null,
        sourcePackage: key,
        parentPackage: pkg.sourcePackage,
        root: path.join(pkg.root, 'dist/compiled', component),
        evidence: [],
      });
  }

  function walkStaged(dir, owner = null) {
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error('License collection requires link-free staged runtime directories.');
    const relative = relativeRuntimePath(staged, dir);
    if (moduleDirectory(dir)) {
      const metadata = readManifest(staged, path.join(dir, 'package.json'));
      const sourceRelative = relative.replace(/^(?:\.next\/)?node_modules\//, '');
      owner = pinnedPackage(path.join(modules, sourceRelative), metadata);
      owner.shippedPaths.add(relative);
    }
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink())
        throw new Error('License collection requires a link-free staged runtime.');
      if (owner) {
        const ownerPath = [...owner.shippedPaths].find(
          (base) => relativeRuntimePath(path.join(staged, base), file) !== null,
        );
        if (ownerPath)
          compiledComponent(owner, relativeRuntimePath(path.join(staged, ownerPath), file));
      }
      if (entry.isDirectory()) walkStaged(file, owner);
      else if (!entry.isFile()) throw new Error('Staged runtime contains a non-regular file.');
    }
  }

  for (const name of ['node_modules', '.next/node_modules']) {
    const dir = path.join(staged, name);
    if (fs.existsSync(dir)) walkStaged(dir);
  }

  for (const input of bundledInputs) {
    if (typeof input !== 'string' || !path.isAbsolute(input))
      throw new Error('Bundled license inputs must be absolute build metafile paths.');
    const relative =
      relativeRuntimePath(requestedModules, input) ?? relativeRuntimePath(modules, input);
    // Application/workspace source is covered by the application's own license.
    if (relative === null) continue;
    const real = fs.realpathSync(input);
    if (relativeRuntimePath(modules, real) === null)
      throw new Error('Bundled input escapes the permitted node_modules.');
    let dir = path.dirname(real);
    while (dir !== modules && !moduleDirectory(dir)) dir = path.dirname(dir);
    if (dir === modules) throw new Error('Bundled input has no pinned package root.');
    const pkg = pinnedPackage(dir);
    const packageRelative = relativeRuntimePath(pkg.root, real);
    pkg.bundledInputs.add(packageRelative);
    compiledComponent(pkg, packageRelative);
  }

  function retain(record, relative, kind) {
    const file = path.join(record.root, relative);
    const bytes = safeFile(modules, file);
    // Some Next .LEGAL.txt files are intentionally empty placeholders. Preserve the
    // upstream bytes, but never count them as actual license/attribution evidence.
    if (kind === 'notice' && !bytes.toString('utf8').trim()) kind = 'empty-notice';
    const id = digest(record.sourcePackage).slice(0, 20);
    const destination = `licenses/${id}/${posix(relative)}`;
    pending.push({ destination, bytes });
    record.evidence.push({
      kind,
      source: posix(relative),
      path: destination,
      sha256: digest(bytes),
    });
  }

  function collectNotices(record, dir = record.root) {
    // Validate directories before enumerating them, without following linked trees.
    const relative = relativeRuntimePath(modules, dir);
    if (relative === null || fs.lstatSync(dir).isSymbolicLink())
      throw new Error('License evidence directory escapes the permitted package.');
    let cursor = modules;
    for (const part of relative.split('/')) {
      cursor = path.join(cursor, part);
      if (fs.lstatSync(cursor).isSymbolicLink())
        throw new Error('Linked license source directories are forbidden.');
    }
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const file = path.join(dir, entry.name);
      const packageRelative = relativeRuntimePath(record.root, file);
      // Compiled Next units are included only when actually present in the staged tree
      // or in a shipped helper's bundler inputs, never all of Next's build tooling.
      if (record.name === 'next' && packageRelative === 'dist/compiled') continue;
      if (entry.isSymbolicLink()) throw new Error('Linked license source entries are forbidden.');
      if (entry.isDirectory()) collectNotices(record, file);
      else if (noticeName.test(entry.name) || legalSuffix.test(entry.name))
        retain(record, packageRelative, 'notice');
      else if (
        record.parentPackage &&
        entry.name === 'package.json' &&
        packageRelative !== 'package.json'
      )
        retain(record, packageRelative, 'manifest');
    }
  }

  for (const record of [...packages.values(), ...components.values()]) {
    if (fs.existsSync(path.join(record.root, 'package.json'))) {
      const manifest = readManifest(modules, path.join(record.root, 'package.json'));
      if (record.parentPackage) {
        record.name = typeof manifest.name === 'string' ? manifest.name : record.name;
        record.version = typeof manifest.version === 'string' ? manifest.version : null;
        record.declaredLicense = typeof manifest.license === 'string' ? manifest.license : null;
      }
      retain(record, 'package.json', 'manifest');
    }
    collectNotices(record);
    if (record.name === 'better-sqlite3') {
      const header = 'deps/sqlite3/sqlite3.h';
      if (fs.existsSync(path.join(record.root, header)))
        retain(record, header, 'native-source-notice');
      else
        warnings.push({
          package: record.sourcePackage,
          reason: 'Bundled SQLite source header with its upstream notice is missing.',
        });
    }
    if (!record.evidence.some((file) => file.kind === 'notice'))
      warnings.push({
        package: record.sourcePackage,
        reason:
          'No standalone upstream license/notice file was found. A manifest license identifier is not a substitute for its text; review is required.',
      });
  }

  const cleanRecord = ({ root: _root, shippedPaths, bundledInputs: inputs, ...record }) => ({
    ...record,
    ...(shippedPaths
      ? { shippedPaths: [...shippedPaths].sort(), bundledInputs: [...inputs].sort() }
      : {}),
    evidence: record.evidence.sort((a, b) => a.source.localeCompare(b.source)),
  });
  const supplemental = loadSupplementalNotices([...packages.values()]);
  pending.push(...supplemental.files);
  const inventory = {
    supplementalDocuments: supplemental.documents,
    schemaVersion: 1,
    scope:
      'Upstream manifests and notice files for staged pnpm runtime packages, shipped Next compiled components, and supplied helper-bundle inputs. Not a complete SBOM or a legal compliance certification; application/framework bundles can contain additional embedded code.',
    reviewRequired: warnings.length > 0,
    packages: [...packages.values()]
      .map(cleanRecord)
      .sort((a, b) => a.sourcePackage.localeCompare(b.sourcePackage)),
    compiledComponents: [...components.values()]
      .map(cleanRecord)
      .sort((a, b) => a.sourcePackage.localeCompare(b.sourcePackage)),
    warnings: warnings.sort(
      (a, b) => a.package.localeCompare(b.package) || a.reason.localeCompare(b.reason),
    ),
  };
  // Validate and read all evidence first. A source error leaves no partial notice set.
  for (const { destination, bytes } of pending) {
    const file = path.join(staged, destination);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes, { flag: 'wx' });
  }
  fs.writeFileSync(inventoryFile, `${JSON.stringify(inventory, null, 2)}\n`, { flag: 'wx' });
  return inventory;
}
