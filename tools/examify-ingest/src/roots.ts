import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { resolveCliDataPaths } from '../../../src/lib/data-dir';

/**
 * Which generated layer a CLI run reads and writes:
 * - `committed`: the checkout (`content/…` tracked in git, plus the
 *   `src/lib/exam/generated-*.ts` registrars on emit);
 * - `family`: the family data folder (`EXAMIFY_DATA_DIR`, default `./data`),
 *   the same tree `/onboarding` writes. Never registrars.
 */
export type IngestLayer = 'committed' | 'family';

export type IngestRoot = {
  layer: IngestLayer;
  /** Content root for this run: the checkout, or the family data folder. */
  root: string;
  /** Checkout root. `.env` / `.env.local` (API keys) are read from here in both layers. */
  repoRoot: string;
  dataDir: string;
  /** How to name the data folder from the checkout root (see {@link formatDataDirDisplay}). */
  dataDirDisplay: string;
};

const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

/** realpath of the nearest existing ancestor + the not-yet-created rest. */
function canonical(absPath: string): string {
  let existing = path.resolve(absPath);
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  let real = existing;
  try {
    real = realpathSync.native(existing);
  } catch {
    // keep the lexical path
  }
  const joined = path.join(real, ...rest);
  return CASE_INSENSITIVE_FS ? joined.toLowerCase() : joined;
}

function contains(parent: string, child: string): boolean {
  if (child === parent) return true;
  const withSep = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
  return child.startsWith(withSep);
}

/**
 * The family data folder as the CLI hints name it from the checkout root:
 * `data` for the default, `data/<sub>` (or another relative path) when it is
 * inside the checkout, else the absolute path.
 */
export function formatDataDirDisplay(repoRoot: string, dataDir: string): string {
  // Lexical on purpose: name the folder the way it was configured.
  const rel = path.relative(path.resolve(repoRoot), path.resolve(dataDir));
  if (rel === '') return '.';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return dataDir;
  return rel.split(path.sep).join('/');
}

/** `content/subjects` of a layer as a shell argument run from the checkout root. */
export function subjectsArgFor(ingest: Pick<IngestRoot, 'layer' | 'dataDirDisplay'>): string {
  const base =
    ingest.layer === 'committed' || ingest.dataDirDisplay === '.'
      ? 'content/subjects'
      : `${ingest.dataDirDisplay}/content/subjects`;
  return /\s/.test(base) ? `'${base}'` : base;
}

/** The one stderr line every validate / emit / generate run prints first. */
export function formatLayerLine(ingest: Pick<IngestRoot, 'layer' | 'dataDirDisplay'>): string {
  return ingest.layer === 'family'
    ? `layer: family (${ingest.dataDirDisplay})`
    : 'layer: committed (checkout)';
}

/**
 * Pick the layer from the positional paths. Each is realpathed and tested
 * against the family data folder first (the default `./data` is inside the
 * checkout), then the checkout. A path in neither, or paths in both, is an
 * error. The data folder comes from the same resolver as the app
 * (`resolveCliDataPaths`: env, then the checkout's env files).
 */
export function resolveIngestRoot(
  inputs: readonly string[],
  cwd: string,
  env: Record<string, string | undefined>,
): IngestRoot {
  const paths = resolveCliDataPaths(cwd, env);
  const repo = canonical(paths.repoRoot);
  const data = canonical(paths.dataDir);
  const defaultData = canonical(path.join(paths.repoRoot, 'data'));
  const layers = new Set<IngestLayer>();
  for (const input of inputs) {
    const abs = canonical(path.resolve(cwd, input));
    if (contains(data, abs)) layers.add('family');
    else if (contains(defaultData, abs)) {
      // A leftover ./data after EXAMIFY_DATA_DIR moved elsewhere is family
      // content: never treat it as committed (an emit would write its keys
      // into tracked files and rewrite the registrars).
      const display = formatDataDirDisplay(paths.repoRoot, paths.dataDir);
      throw new Error(
        `this path is under ./data, but the family data folder is ${display}; use ${display}/content/…: ${input}`,
      );
    } else if (contains(repo, abs)) layers.add('committed');
    else throw new Error(`path is outside the checkout and the family data folder: ${input}`);
  }
  if (layers.size > 1) {
    throw new Error('inputs span the family data folder and the checkout; run them separately');
  }
  const layer: IngestLayer = layers.has('family') ? 'family' : 'committed';
  return {
    layer,
    root: layer === 'family' ? paths.dataDir : paths.repoRoot,
    repoRoot: paths.repoRoot,
    dataDir: paths.dataDir,
    dataDirDisplay: formatDataDirDisplay(paths.repoRoot, paths.dataDir),
  };
}
