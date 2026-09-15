import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { listCachedPageImages, pagesCacheDir } from './cache';
import { sha256Bytes } from './hash';
import type { ResolvedSource } from './sources';

export type PageImage = {
  sourceRelPath: string;
  page: number;
  absPath: string;
  sha256: string;
  bytes: Buffer;
  mediaType: 'image/png';
};

function pdftoppmAvailable(): boolean {
  const result = spawnSync('pdftoppm', ['-v'], { encoding: 'utf8' });
  if (result.error) return false;
  return result.status === 0 || /pdftoppm/.test(`${result.stderr}${result.stdout}`);
}

/**
 * Rasterize a PDF with pdftoppm when available. Reuses
 * `.examify-ingest/cache/pages/<pdf-sha256>/` when a prior run finished.
 * `persist: false` (dry-run-ir) only reuses existing pages — no new writes.
 */
export function resolvePageImages(
  repoRoot: string,
  sources: readonly ResolvedSource[],
  options: { persist?: boolean } = {},
): PageImage[] {
  const persist = options.persist !== false;
  const pages: PageImage[] = [];
  for (const source of sources) {
    if (source.kind !== 'pdf') continue;
    const dir = pagesCacheDir(repoRoot, source.sha256);
    let files = listCachedPageImages(dir);
    if (files.length === 0) {
      if (!persist || !pdftoppmAvailable()) continue;
      mkdirSync(dir, { recursive: true });
      const prefix = path.join(dir, 'page');
      const result = spawnSync('pdftoppm', ['-png', '-r', '150', source.absPath, prefix], {
        encoding: 'utf8',
      });
      if (result.status !== 0) continue;
      writeFileSync(path.join(dir, '.done'), 'ok\n', 'utf8');
      files = listCachedPageImages(dir);
    }
    for (const absPath of files) {
      const bytes = readFileSync(absPath);
      const page = Number(path.basename(absPath).slice('page-'.length, -'.png'.length));
      pages.push({
        sourceRelPath: source.relPath,
        page,
        absPath,
        sha256: sha256Bytes(bytes),
        bytes,
        mediaType: 'image/png',
      });
    }
  }
  return pages;
}
