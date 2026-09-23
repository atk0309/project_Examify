// Types for scripts/examify-data.mjs (plain ESM so an older checkout can run
// the upstream copy). Keep in step with its exports.

type EnvLike = Record<string, string | undefined>;

export declare const EXIT: Readonly<{
  OK: 0;
  UNEXPECTED: 1;
  USAGE: 2;
  UNSAFE_DATA_DIR: 3;
  LEGACY_CONTENT: 4;
  REFUSED: 5;
  VERIFY_FAILED: 6;
}>;

export declare class CliError extends Error {
  readonly exitCode: number;
  readonly code: string;
  readonly extra: Record<string, unknown>;
  constructor(exitCode: number, code: string, message: string, extra?: Record<string, unknown>);
}

export type DataDirSource = 'EXAMIFY_DATA_DIR' | 'DATABASE_URL' | 'default';
export type UnsafeDataDirReason = 'bad_value' | 'checkout_root' | 'inside_checkout';

export type DataPaths = {
  repoRoot: string;
  dataDir: string;
  dataDirSource: DataDirSource;
  familyRoot: string;
  databaseUrl: string;
  databaseUrlExplicit: boolean;
  dbPath: string;
  outboxDir: string;
};

export declare class UnsafeDataDirError extends Error {
  readonly code: 'UNSAFE_DATA_DIR';
  readonly reason: UnsafeDataDirReason;
  constructor(reason: UnsafeDataDirReason, message: string);
}

export declare const DEFAULT_DATA_DIR: string;
export declare const DATA_DIR_MARKER: string;
export declare const DB_FILE: string;
export declare const EXAMIFY_PACKAGE_NAME: string;
export declare const DATA_ENV_KEYS: readonly string[];
export declare const PRODUCTION_ENV_FILES: readonly string[];
export declare const USAGE: string;

export declare function parseEnvFile(contents: string): Record<string, string>;
export declare function readEnvFile(absPath: string): Record<string, string>;
export declare function envFileValue(
  files: ReadonlyArray<Record<string, string>>,
  key: string,
): string | undefined;
export declare function readProductionEnvFiles(repoRoot: string): Array<Record<string, string>>;
export declare function findRepoRoot(startDir: string): string;
export declare function sqlitePathFromUrl(databaseUrl: string, repoRoot: string): string;
export declare function assertDataDirValue(value: string): void;
export declare function assertSafeDataDir(repoRoot: string, dataDir: string): void;
export declare function resolveDataPaths(input: { repoRoot: string; env: EnvLike }): DataPaths;
export declare function resolveRepoDataPaths(repoRoot: string, processEnv?: EnvLike): DataPaths;
export declare function resolveCliDataPaths(cwd?: string, processEnv?: EnvLike): DataPaths;
export declare function isJunkName(name: string): boolean;
export declare function initDataFolder(
  paths: Pick<DataPaths, 'dataDir'>,
  options?: {
    geteuid?: () => number | undefined;
    warn?: (line: string) => void;
    /** Skip the shared-folder check (the caller vetted the folder already). */
    vetted?: boolean;
  },
): { created: boolean };
export declare function loadSqlite(repoRoot: string, sqliteModule?: string): unknown;
export declare function checkoutMigrationCount(repoRoot: string): number;
export declare function probeServer(ports: number[]): Promise<number | null>;

/** Options every command takes (the function API; the CLI maps its flags onto these). */
export type CommandOptions = {
  repo?: string;
  cwd?: string;
  /** Environment used to resolve the data folder (default `process.env`). */
  env?: EnvLike;
  dataDir?: string;
  sqliteModule?: string;
  allowOwnerMismatch?: boolean;
  geteuid?: () => number | undefined;
  log?: (line: string) => void;
};

export declare function paths(options?: CommandOptions): {
  repoRoot: string;
  dataDir: string;
  dataDirSource: DataDirSource;
  dbPath: string;
  outboxDir: string;
  databaseUrlExplicit: boolean;
};
export declare function init(options?: CommandOptions): { dataDir: string; created: boolean };

export type BackupResult = {
  archive: string;
  /** Read back after publishing (`tar -tzf` + its MANIFEST.json). */
  verified: true;
  size: number;
  kind: 'manual' | 'pre-upgrade';
  createdAt: string;
  db: { migrations: number; integrity: string };
  files: number;
  env: { included: boolean };
  checkout: { included: boolean };
  warnings: string[];
};
export declare function backup(
  options?: CommandOptions & {
    out?: string;
    noEnv?: boolean;
    includeCache?: boolean;
    includeCheckout?: boolean;
    kind?: 'manual' | 'pre-upgrade';
  },
): Promise<BackupResult>;

export type RestorePlace = { dataDir: string; dbPath: string };
export type RestoreResult = {
  /** Where the database and family files were placed (`target.after`). */
  dataDir: string;
  dbPath: string;
  /**
   * `before`: what the checkout resolved to when the restore started. With
   * `--with-env` (no `--data-dir`) and env files in the archive, `after` is
   * what `next start` resolves once those files are in place.
   */
  target: {
    source: 'env' | 'data-dir' | 'restored-env';
    before: RestorePlace;
    after: RestorePlace;
    changed: boolean;
  };
  migrations: { snapshot: number; checkout: number };
  restored: { db: boolean; familyFiles: number; env: string[]; checkoutFiles: number };
  archiveHasEnv: boolean;
  movedAside: string | null;
  envSaved: string[];
  /** Everything was placed; finishing the data folder's init failed (db:migrate redoes it). */
  warnings: string[];
};
export declare function restore(
  options?: CommandOptions & {
    archive?: string;
    force?: boolean;
    withEnv?: boolean;
    includeCheckout?: boolean;
    probe?: (ports: number[]) => Promise<number | null>;
  },
): Promise<RestoreResult>;

export type LegacyItem = { kind: string; path: string; files?: number; reason?: string };
export type LegacyCheckResult =
  | { checked: false; reason: string; legacy: false; items: [] }
  | { checked: true; legacy: boolean; items: LegacyItem[] };
export declare function detectLegacyCheckoutContent(repoRoot: string): LegacyCheckResult;
export declare function legacyCheck(
  options?: CommandOptions,
): LegacyCheckResult & { exitCode: number };

export type MigrateResult = {
  fromSha: string;
  subjects: Array<{ id: string; reason: string }>;
  generated: Array<{ id: string; rowSource: string }>;
  sourcePdfFiles: number;
  ingestFiles: number;
  registrars: string[];
  hiddenCommitted: string[];
  orphans: string[];
  incompleteGenerated: Array<{ id: string; missing: string[] }>;
  /** Catalog rows with an invalid or duplicate id (left out of the family catalog). */
  invalidCatalogRows: number;
  /** `content/source-pdfs` / `.examify-ingest` folders present in the checkout. */
  leftoverDirs: string[];
  noop: boolean;
  dryRun: boolean;
  copies?: Array<{ path: string; action: string }>;
  generatedActions?: Record<string, string>;
  dataDir?: string;
  /** The backup taken first (`taken`) or given with `--backup`; null for a prune-only run. */
  backup?: { archive: string; taken: boolean } | null;
  moved?: number;
  copied?: number;
  overwritten?: number;
  same?: number;
  conflicts?: string[];
  removed?: number;
  /** Leftover folders the run removed from the checkout. */
  removedFolders?: string[];
};
export declare function migrateCheckout(
  options?: CommandOptions & { dryRun?: boolean; backup?: string },
): Promise<MigrateResult>;

export type VerifyResult = {
  ok: boolean;
  failures: Array<{ check: string; detail: string }>;
  warnings: string[];
};
export declare function verify(options?: CommandOptions): VerifyResult;

export declare function parseArgs(argv: string[]):
  | { help: true }
  | {
      help?: undefined;
      command: string;
      flags: Record<string, string | true>;
      positionals: string[];
    };

export declare function main(
  argv: string[],
  io?: {
    cwd?: string;
    env?: EnvLike;
    stdout?: (text: string) => void;
    stderr?: (text: string) => void;
    geteuid?: () => number | undefined;
    probe?: (ports: number[]) => Promise<number | null>;
  },
): Promise<number>;
