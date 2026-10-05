#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

/** Restore only validated package-directory links, after verified extraction to its final path. */
export function restoreRuntimeLinks(root, { installedRoot = root } = {}) {
  root = fs.realpathSync(root);
  installedRoot = path.resolve(installedRoot);
  const links = JSON.parse(fs.readFileSync(path.join(root, 'runtime-links.json'), 'utf8'));
  if (!Array.isArray(links) || links.length > 10000)
    throw new Error('Invalid runtime link manifest.');
  function safeRelative(value) {
    return (
      typeof value === 'string' &&
      /^(node_modules|\.next\/node_modules)\//.test(value) &&
      !value.split('/').some((part) => !part || part === '.' || part === '..') &&
      !/[\\:\r\n]/.test(value)
    );
  }
  for (const link of links) {
    if (!link || !safeRelative(link.path) || !safeRelative(link.target))
      throw new Error('Unsafe runtime link.');
    const file = path.join(root, link.path);
    const target = path.join(root, link.target);
    const canonical = fs.realpathSync(target);
    if (!canonical.startsWith(root + path.sep) || !fs.statSync(target).isDirectory())
      throw new Error('Runtime link target is outside the package.');
    let parent = path.dirname(file);
    while (parent !== root) {
      if (fs.lstatSync(parent).isSymbolicLink())
        throw new Error('Runtime link parent must be a real directory.');
      parent = path.dirname(parent);
    }
    try {
      const old = fs.lstatSync(file);
      if (!old.isSymbolicLink() || fs.realpathSync(file) !== canonical)
        throw new Error('Runtime dependency path already contains another file.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // Junctions work for ordinary Windows accounts without Developer Mode/admin.
      fs.symlinkSync(
        process.platform === 'win32'
          ? path.join(installedRoot, link.target)
          : path.relative(path.dirname(file), target),
        file,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    }
  }
}
