import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { listCachedPageImages, listPagePngs, pagesCacheDir } from './cache';
import { sha256Bytes } from './hash';
import type { ResolvedSource } from './sources';
import { safeTempRoot } from './temp-root';

export const PAGE_RASTER_PROFILE = 'pdftoppm-png-r150';
export const PAGE_RASTER_DPI = 150;

export type PageImage = {
  sourceRelPath: string;
  page: number;
  absPath: string;
  sha256: string;
  bytes: Buffer;
  mediaType: 'image/png';
};

export type ResolvePageImagesOptions = {
  persist?: boolean;
  rasterize?: (pdfAbsPath: string, prefix: string) => boolean;
};

export function defaultRasterize(pdfAbsPath: string, prefix: string): boolean {
  const result = spawnSync(
    'pdftoppm',
    ['-png', '-r', String(PAGE_RASTER_DPI), pdfAbsPath, prefix],
    { encoding: 'utf8' },
  );
  return !result.error && result.status === 0;
}

export function pageImageHashesOf(pages: readonly PageImage[]): string[] {
  return pages.map((page) => `${page.sourceRelPath}#${page.page}=${page.sha256}`);
}

function pageFromPath(absPath: string): PageImage & { sourceRelPath: string } {
  const bytes = readFileSync(absPath);
  const page = Number(path.basename(absPath).slice('page-'.length, -'.png'.length));
  return {
    sourceRelPath: '',
    page,
    absPath,
    sha256: sha256Bytes(bytes),
    bytes,
    mediaType: 'image/png',
  };
}

/**
 * Rasterize a PDF with pdftoppm when available. Reuses
 * `.examify-ingest/cache/pages/<pdf-sha256>/` when a prior run finished.
 * `persist: false` (`--dry-run-ir`) still rasterizes missing pages into a
 * temp directory so the provider request matches a persist run, then deletes
 * that temp tree. It never writes `.examify-ingest/cache/pages/`.
 */
export function resolvePageImages(
  repoRoot: string,
  sources: readonly ResolvedSource[],
  options: ResolvePageImagesOptions = {},
): PageImage[] {
  const persist = options.persist !== false;
  const rasterize = options.rasterize ?? defaultRasterize;
  const pages: PageImage[] = [];
  for (const source of sources) {
    if (source.kind !== 'pdf') continue;
    const dir = pagesCacheDir(repoRoot, source.sha256);
    const cached = listCachedPageImages(dir);
    if (cached.length > 0) {
      for (const absPath of cached) {
        pages.push({ ...pageFromPath(absPath), sourceRelPath: source.relPath });
      }
      continue;
    }
    // Outside every checkout, even when TMPDIR points into one.
    const workDir = persist ? dir : mkdtempSync(path.join(safeTempRoot(), 'examify-pages-'));
    try {
      if (persist) mkdirSync(workDir, { recursive: true });
      const prefix = path.join(workDir, 'page');
      if (!rasterize(source.absPath, prefix)) continue;
      if (persist) writeFileSync(path.join(workDir, '.done'), 'ok\n', 'utf8');
      const paths = persist ? listCachedPageImages(workDir) : listPagePngs(workDir);
      for (const absPath of paths) {
        pages.push({ ...pageFromPath(absPath), sourceRelPath: source.relPath });
      }
    } finally {
      if (!persist) rmSync(workDir, { recursive: true, force: true });
    }
  }
  return pages;
}

/**
 * Commit in-memory rasters to `.examify-ingest/cache/pages/<pdf-sha256>/`.
 * Skips a PDF that already has a finished cache dir (read-only reuse).
 * Call only after generate's final abort checkpoint.
 */
export function persistPageImages(
  repoRoot: string,
  sources: readonly ResolvedSource[],
  pages: readonly PageImage[],
): void {
  for (const source of sources) {
    if (source.kind !== 'pdf') continue;
    const dir = pagesCacheDir(repoRoot, source.sha256);
    if (listCachedPageImages(dir).length > 0) continue;
    const mine = pages.filter((page) => page.sourceRelPath === source.relPath);
    if (mine.length === 0) continue;
    mkdirSync(dir, { recursive: true });
    for (const page of mine) {
      writeFileSync(path.join(dir, `page-${page.page}.png`), page.bytes);
    }
    writeFileSync(path.join(dir, '.done'), 'ok\n', 'utf8');
  }
}
