import fs from 'node:fs';
import path from 'node:path';

export const STANDALONE_RUNTIME_ENTRIES = ['server.js', 'package.json', '.next', 'node_modules'];

/** Compare canonical paths with native Windows drive/UNC casing and namespace rules. */
export function relativeRuntimePath(root, target, paths = path) {
  const normalize = (value) =>
    paths === path.win32
      ? value.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\(?=[a-z]:\\)/i, '')
      : value;
  const relative = paths.relative(normalize(root), normalize(target));
  if (relative === '..' || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative))
    return null;
  return relative.split(paths.sep).join('/');
}

function isModulePath(value) {
  return (
    typeof value === 'string' &&
    /^(node_modules|\.next\/node_modules)\//.test(value) &&
    !value.split('/').some((part) => !part || part === '.' || part === '..') &&
    !/[\\:\r\n]/.test(value)
  );
}

function forbiddenEntry(relative) {
  return (
    relative
      .toLowerCase()
      .split('/')
      .some(
        (name) =>
          [
            '.git',
            '.hg',
            '.svn',
            '.ssh',
            '.aws',
            '.codex',
            '.agents',
            'secrets.json',
            'running.json',
          ].includes(name) ||
          name === '.env' ||
          name.startsWith('.env.') ||
          /\.(db|sqlite|sqlite3)(-wal|-shm|-journal)?$/i.test(name),
      ) || /^(data|config|tests|docs|content\/source-pdfs|\.examify-ingest)(\/|$)/i.test(relative)
  );
}

export function copyRuntimeTree(
  source,
  destination,
  allowedRoot = fs.realpathSync(source),
  ancestors = new Set(),
) {
  const real = fs.realpathSync(source);
  if (relativeRuntimePath(allowedRoot, real) === null)
    throw new Error('Runtime link escapes the permitted source tree.');
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    if (ancestors.has(real)) throw new Error('Runtime trace contains a circular link.');
    const next = new Set(ancestors).add(real);
    fs.mkdirSync(destination, { recursive: true });
    for (const name of fs.readdirSync(source))
      copyRuntimeTree(path.join(source, name), path.join(destination, name), allowedRoot, next);
  } else if (stat.isFile()) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, stat.mode & 0o777);
  } else throw new Error('Runtime trace contains a non-regular file.');
}

/** Preserve pnpm's module graph without putting symlinks in the download archive. */
export function copyStandaloneRuntime(
  standalone,
  destination,
  { sourceNodeModules, omitPortableImageLinks = false } = {},
) {
  fs.mkdirSync(destination, { recursive: true });
  const root = fs.realpathSync(standalone);
  const modules = sourceNodeModules ? fs.realpathSync(sourceNodeModules) : null;
  const links = [];
  function rejectLink(source, reason) {
    // Never log the external target: it may contain a private host path or data filename.
    const relative = relativeRuntimePath(root, source);
    throw new Error(
      `Runtime link escapes the source tree: ${JSON.stringify(relative)} (${reason}).`,
    );
  }
  function rebaseModule(source, real) {
    const relative = modules && relativeRuntimePath(modules, real);
    // Next copies Windows junctions verbatim, retaining their absolute checkout targets.
    // Rebase only an exact pinned pnpm package to its already-traced standalone copy.
    // Never read/copy the checkout target or fill in missing traced files from it.
    const match = relative?.match(
      /^\.pnpm\/([^/]+)\/node_modules\/((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)$/i,
    );
    if (!match) rejectLink(source, 'target is not a trusted pnpm package');
    const mapped = path.join(root, 'node_modules', relative);
    let metadata;
    try {
      if (
        !fs.lstatSync(mapped).isDirectory() ||
        relativeRuntimePath(mapped, fs.realpathSync(mapped)) !== ''
      )
        rejectLink(source, 'traced counterpart is not a real directory');
      const manifest = path.join(mapped, 'package.json');
      if (!fs.lstatSync(manifest).isFile())
        rejectLink(source, 'traced package manifest is not a regular file');
      metadata = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    } catch {
      rejectLink(source, 'traced package counterpart is missing or unsafe');
    }
    const version = metadata?.version;
    const locator = `${match[2].replace('/', '+')}@${version}`;
    if (
      metadata?.name !== match[2] ||
      typeof version !== 'string' ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version) ||
      (match[1] !== locator && !match[1].startsWith(`${locator}_`))
    )
      rejectLink(source, 'traced package identity does not match its pinned pnpm locator');
    return relativeRuntimePath(root, mapped);
  }
  function copy(source, target) {
    const relative = relativeRuntimePath(root, source);
    if (forbiddenEntry(relative)) throw new Error(`Forbidden release entry: ${relative}`);
    const stat = fs.lstatSync(source);
    // Next retains dependency-graph links even when their optional package files
    // were explicitly excluded from tracing. Drop only these declared links;
    // real image package contents still fail closed instead of being concealed.
    if (omitPortableImageLinks && /(?:^|\/)node_modules\/(?:sharp|@img\/[^/]+)$/.test(relative)) {
      if (!stat.isSymbolicLink())
        throw new Error('Image package files remain despite portable tracing exclusions.');
      return;
    }
    if (stat.isSymbolicLink()) {
      const real = fs.realpathSync(source);
      let resolved = relativeRuntimePath(root, real);
      if (fs.statSync(source).isDirectory()) {
        if (resolved === null) resolved = rebaseModule(source, real);
        if (!isModulePath(relative) || !isModulePath(resolved) || forbiddenEntry(resolved))
          rejectLink(source, 'directory links must stay in packaged runtime modules');
        links.push({ path: relative, target: resolved });
      } else {
        if (resolved === null) rejectLink(source, 'file target is outside the standalone tree');
        if (forbiddenEntry(resolved)) rejectLink(source, 'file target is forbidden');
        copyRuntimeTree(source, target, root);
      }
    } else if (stat.isDirectory()) {
      fs.mkdirSync(target, { recursive: true });
      for (const name of fs.readdirSync(source))
        copy(path.join(source, name), path.join(target, name));
    } else if (stat.isFile()) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      fs.chmodSync(target, stat.mode & 0o777);
    } else throw new Error('Runtime trace contains a non-regular file.');
  }
  for (const name of STANDALONE_RUNTIME_ENTRIES)
    copy(path.join(root, name), path.join(destination, name));
  // Every link must resolve inside the staged archive, without relying on build-machine files.
  const stagedRoot = fs.realpathSync(destination);
  for (const link of links) {
    const target = path.join(stagedRoot, link.target);
    if (
      !fs.statSync(target).isDirectory() ||
      relativeRuntimePath(stagedRoot, fs.realpathSync(target)) === null
    )
      throw new Error(
        `Runtime link has no packaged directory target: ${JSON.stringify(link.path)}.`,
      );
  }
  fs.writeFileSync(
    path.join(destination, 'runtime-links.json'),
    `${JSON.stringify(links, null, 2)}\n`,
  );
}

export function assertReleaseInventory(root) {
  const files = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const relative = path.relative(root, file).split(path.sep).join('/');
      if (entry.isSymbolicLink())
        throw new Error(`Release contains an unresolved link: ${relative}`);
      if (forbiddenEntry(relative)) {
        throw new Error(`Forbidden release entry: ${relative}`);
      }
      if (entry.isDirectory()) visit(file);
      else if (!entry.isFile()) throw new Error('Release contains a non-regular file.');
      else files.push(relative);
    }
  }
  visit(root);
  return files.sort();
}
