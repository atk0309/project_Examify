import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stableJson } from './diff';
import { sha256Bytes, sortRecord } from './hash';
import { bankIrSchema, INGEST_STATE_DIR, type BankIR, type BankIrSubject } from './schema';
import { writeFileAtomic } from './write-atomic';

export function ingestStateDir(repoRoot: string): string {
  return path.join(repoRoot, INGEST_STATE_DIR);
}

export function irCachePath(repoRoot: string, cacheKey: string): string {
  return path.join(ingestStateDir(repoRoot), 'cache', 'ir', `${cacheKey}.json`);
}

export function runsDir(repoRoot: string): string {
  return path.join(ingestStateDir(repoRoot), 'runs');
}

export function pagesCacheDir(repoRoot: string, pdfSha256: string): string {
  return path.join(ingestStateDir(repoRoot), 'cache', 'pages', pdfSha256);
}

export function buildCacheKey(input: {
  promptVersion: string;
  promptHash: string;
  provider: string;
  model: string;
  seed: number;
  sourceHashes: Record<string, string>;
  subject: BankIrSubject;
  pageImageHashes: readonly string[];
  pageRasterProfile: string;
}): string {
  return sha256Bytes(
    stableJson({
      promptVersion: input.promptVersion,
      promptHash: input.promptHash,
      provider: input.provider,
      model: input.model,
      seed: input.seed,
      sourceHashes: sortRecord(input.sourceHashes),
      subject: input.subject,
      pageImageHashes: [...input.pageImageHashes],
      pageRasterProfile: input.pageRasterProfile,
    }),
  );
}

export function readCachedIr(repoRoot: string, cacheKey: string): BankIR | null {
  const abs = irCachePath(repoRoot, cacheKey);
  if (!existsSync(abs)) return null;
  try {
    const parsed = bankIrSchema.safeParse(JSON.parse(readFileSync(abs, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeCachedIr(repoRoot: string, cacheKey: string, bank: BankIR): void {
  writeFileAtomic(irCachePath(repoRoot, cacheKey), stableJson(bank));
}

export function writeRunManifest(
  repoRoot: string,
  cacheKey: string,
  timestamp: string,
  body: string,
): string {
  mkdirSync(runsDir(repoRoot), { recursive: true });
  const stamp = timestamp.replaceAll(':', '-').replaceAll('.', '-');
  const abs = path.join(runsDir(repoRoot), `${stamp}-${cacheKey.slice(0, 12)}.json`);
  writeFileSync(abs, body, 'utf8');
  return abs;
}

export function listPagePngs(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => /^page-\d+\.png$/.test(name))
      .sort((a, b) => Number(a.slice(5, -4)) - Number(b.slice(5, -4)))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

export function listCachedPageImages(dir: string): string[] {
  if (!existsSync(path.join(dir, '.done'))) return [];
  return listPagePngs(dir);
}
