import fs from 'node:fs';
import path from 'node:path';

export const STANDALONE_RUNTIME_ENTRIES = ['server.js', 'package.json', '.next', 'node_modules'];

export function copyRuntimeTree(
  source,
  destination,
  allowedRoot = fs.realpathSync(source),
  ancestors = new Set(),
) {
  const real = fs.realpathSync(source);
  if (real !== allowedRoot && !real.startsWith(allowedRoot + path.sep))
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
export function copyStandaloneRuntime(standalone, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const root = fs.realpathSync(standalone);
  const links = [];
  function copy(source, target) {
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) {
      const real = fs.realpathSync(source);
      if (!real.startsWith(root + path.sep))
        throw new Error('Runtime link escapes the source tree.');
      if (fs.statSync(source).isDirectory()) {
        links.push({
          path: path.relative(root, source).split(path.sep).join('/'),
          target: path.relative(root, real).split(path.sep).join('/'),
        });
      } else copyRuntimeTree(source, target, root);
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
      if (
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
        ].includes(entry.name) ||
        entry.name === '.env' ||
        entry.name.startsWith('.env.') ||
        /\.(db|sqlite|sqlite3)(-wal|-shm|-journal)?$/i.test(entry.name) ||
        /^(data|config|tests|docs|content\/source-pdfs|\.examify-ingest)(\/|$)/.test(relative)
      ) {
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
