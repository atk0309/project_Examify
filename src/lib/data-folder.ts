import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR_MARKER, type DataPaths } from './data-dir';

// Relative imports only and no `server-only`: `db:migrate` (tsx) and the
// e2e prepare script load this without the `@/` alias.
// `scripts/examify-data.mjs` `init` mirrors these steps.

/** Layout version recorded in the data-folder marker. */
export const DATA_FOLDER_LAYOUT = 1;

export type DataFolderMarker = {
  layout: number;
  createdAt: string;
  migrations: unknown[];
};

/** Create `file` with `body` unless something already exists there (never clobbers). */
function writeIfMissing(file: string, body: string, mode: number): void {
  try {
    writeFileSync(file, body, { flag: 'wx', mode });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

/**
 * Initialise the family data folder: create it 0700 (and tighten it to
 * 0700 when this user owns it), then add a `.gitignore` (`*`, so the folder
 * is never committed by accident wherever it lives) and the marker. Existing
 * files are kept. Idempotent.
 */
export function initDataFolder(
  paths: Pick<DataPaths, 'dataDir'>,
  options: { warn?: (line: string) => void; now?: () => Date } = {},
): { created: boolean } {
  const { dataDir } = paths;
  const warn = options.warn ?? ((line: string) => console.warn(line));
  const created = !existsSync(dataDir);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (typeof process.getuid === 'function') {
    if (statSync(dataDir).uid === process.getuid()) {
      chmodSync(dataDir, 0o700);
    } else {
      warn(
        '[data] the family data folder belongs to another user; its permissions were left as is',
      );
    }
  }
  writeIfMissing(path.join(dataDir, '.gitignore'), '*\n', 0o600);
  const marker: DataFolderMarker = {
    layout: DATA_FOLDER_LAYOUT,
    createdAt: (options.now?.() ?? new Date()).toISOString(),
    migrations: [],
  };
  writeIfMissing(path.join(dataDir, DATA_DIR_MARKER), `${JSON.stringify(marker)}\n`, 0o600);
  return { created };
}
