import { applyEmit, formatEmitPlan, planEmit } from './emit';
import { sampleBankFrozenIds } from './frozen-ids';
import { findRepoRoot, isAuthoritativeCatalogInput, loadIrFiles, resolveIrFiles } from './load';
import { DEFAULT_GENERATE_SEED, GENERATE_PROVIDERS, type GenerateProviderId } from './schema';
import { validateIrCollection } from './validate';

export const USAGE = `Usage:
  examify-ingest validate <subjects-dir|ir.json...> [--replace-sample]
  examify-ingest emit <subjects-dir|ir.json...> [--dry-run] [--apply] [--replace-sample]
  examify-ingest generate [--provider anthropic|openai|local|test] [--seed <n>]
      [--subject <id>] [--model <name>] [--dry-run-ir] [--force] [--replace-sample]
      <subjects-dir|content/subjects/<id>>

emit is dry-run by default. Writes only with --apply.
A subjects-directory emit (every path is a directory, typically content/subjects)
prunes leftover generated subject JSON when the tree still has BankIR. An empty
subjects directory is refused (fail closed) and never wipes generated files.
Explicit IR files never prune; mixed file+directory argv is partial-safe and
never prunes.

generate writes BankIR only (content/subjects/<id>/bank.ir.json). It never
emits or applies. After generate, run validate content/subjects then
emit content/subjects --dry-run then emit content/subjects --apply.
Sources include notes/text (.txt/.md) and images in the subject folder,
plus PDFs (and those same extensions) under content/source-pdfs/<id>/ or
standalone content/source-pdfs/<id>.<ext>. PDF files stay PDFs — magic-byte
checks for uploaded PDFs are unchanged. Default seed is 0. Cloud providers
require ANTHROPIC_API_KEY or OPENAI_API_KEY from the environment or repo
.env / .env.local (never the CLI; existing env vars win) unless a matching
cacheKey IR is already cached. Use --provider test in CI. --dry-run-ir
writes nothing durable. A real BankIR with questions is not overwritten
unless --force (dry-run says "would overwrite"). Empty / placeholder IR
(empty file, valid zero-item schema) is treated as missing. Corrupt /
unparseable / invalid-schema IR requires --force; the error names
corruption, not empty. Sample-bank ids fail closed unless --replace-sample (no BankIR
written; the path is not implied to exist). Tree generate preflights
sources and overwrite, drafts every subject (SAMPLE freeze / provider)
before the first IR write, and commits BankIR only if every draft succeeds.
A sourceless sibling blocks the tree; target content/subjects/<id> or
--subject <id> (e.g. demo). Run manifests live under
.examify-ingest/runs/ (gitignored).
`;

export type CliIo = {
  cwd: string;
  stdout: { write: (chunk: string) => void };
  stderr: { write: (chunk: string) => void };
  env?: Record<string, string | undefined>;
};

/** Success banner for `validate`. Singular when the catalog is one BankIR file. */
export function formatValidateOk(count: number): string {
  return `ok ${count} BankIR file${count === 1 ? '' : 's'}`;
}

export type ParsedCli = {
  command: 'validate' | 'emit' | 'generate' | 'help';
  paths: string[];
  apply: boolean;
  dryRun: boolean;
  replaceSample: boolean;
  provider: GenerateProviderId | null;
  seed: number;
  subject: string | null;
  model: string | null;
  dryRunIr: boolean;
  force: boolean;
};

const BOOLEAN_FLAGS = new Set([
  '--apply',
  '--dry-run',
  '--replace-sample',
  '--help',
  '--dry-run-ir',
  '--force',
]);
const VALUE_FLAGS = new Set(['--provider', '--seed', '--subject', '--model']);
const GENERATE_VALUE_FLAGS = VALUE_FLAGS;
const GENERATE_BOOL_FLAGS = new Set(['--dry-run-ir', '--dry-run', '--force', '--replace-sample']);

function isGenerateProvider(value: string): value is GenerateProviderId {
  return (GENERATE_PROVIDERS as readonly string[]).includes(value);
}

export function parseArgs(argv: readonly string[]): ParsedCli | { error: string } {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const key = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);

    if (VALUE_FLAGS.has(key)) {
      const value = inline ?? argv[i + 1];
      if (inline === undefined) {
        if (!value || value.startsWith('--')) return { error: `${key} requires a value` };
        i += 1;
      }
      if (value === undefined || value === '') return { error: `${key} requires a value` };
      values.set(key, value);
      continue;
    }
    if (BOOLEAN_FLAGS.has(key)) {
      if (inline !== undefined) return { error: `${key} does not take a value` };
      flags.add(key);
      continue;
    }
    return { error: `unknown flag ${key}` };
  }

  if (flags.has('--help') || positional[0] === 'help' || positional.length === 0) {
    return {
      command: 'help',
      paths: [],
      apply: false,
      dryRun: true,
      replaceSample: false,
      provider: null,
      seed: DEFAULT_GENERATE_SEED,
      subject: null,
      model: null,
      dryRunIr: false,
      force: false,
    };
  }

  const command = positional[0];
  if (command !== 'validate' && command !== 'emit' && command !== 'generate') {
    return { error: `unknown command ${command}` };
  }

  const paths = positional.slice(1);
  if (paths.length === 0) {
    return {
      error:
        command === 'generate'
          ? 'expected a subjects directory (content/subjects or content/subjects/<id>)'
          : 'expected a subjects directory or BankIR file path',
    };
  }

  if (command !== 'generate') {
    for (const flag of GENERATE_VALUE_FLAGS) {
      if (values.has(flag)) return { error: `${flag} is only valid for generate` };
    }
    if (flags.has('--dry-run-ir')) return { error: '--dry-run-ir is only valid for generate' };
    if (flags.has('--force')) return { error: '--force is only valid for generate' };
  } else {
    if (flags.has('--apply')) {
      return { error: 'generate never emits; use validate then emit --apply' };
    }
    for (const flag of flags) {
      if (!GENERATE_BOOL_FLAGS.has(flag) && flag !== '--help') {
        return { error: `${flag} is not valid for generate` };
      }
    }
  }

  const apply = flags.has('--apply');
  const dryRun = flags.has('--dry-run') || !apply;
  if (command !== 'generate' && apply && flags.has('--dry-run')) {
    return { error: 'use either --apply or --dry-run, not both' };
  }

  let provider: GenerateProviderId | null = null;
  if (command === 'generate') {
    const raw = values.get('--provider');
    if (!raw) return { error: 'generate requires --provider anthropic|openai|local|test' };
    if (!isGenerateProvider(raw)) return { error: `unknown provider ${raw}` };
    provider = raw;
  }

  let seed = DEFAULT_GENERATE_SEED;
  if (values.has('--seed')) {
    const raw = values.get('--seed')!;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isInteger(parsed) || String(parsed) !== raw.trim()) {
      return { error: `--seed must be an integer (got ${raw})` };
    }
    seed = parsed;
  }

  return {
    command,
    paths,
    apply,
    dryRun,
    replaceSample: flags.has('--replace-sample'),
    provider,
    seed,
    subject: values.get('--subject') ?? null,
    model: values.get('--model') ?? null,
    dryRunIr: flags.has('--dry-run-ir') || (command === 'generate' && flags.has('--dry-run')),
    force: flags.has('--force'),
  };
}

function printIssues(io: CliIo, errors: readonly { path?: string; message: string }[]): void {
  for (const error of errors) {
    const prefix = error.path ? `${error.path}: ` : '';
    io.stderr.write(`${prefix}${error.message}\n`);
  }
}

function runValidateOrEmit(parsed: ParsedCli, io: CliIo): number {
  let pruneMissing = false;
  if (parsed.command === 'emit') {
    try {
      pruneMissing = isAuthoritativeCatalogInput(parsed.paths, io.cwd);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      io.stderr.write(`${message}\n`);
      return 1;
    }
  }

  let files;
  try {
    const paths = resolveIrFiles(parsed.paths, io.cwd, {
      allowEmptyDirectory: pruneMissing,
    });
    files = loadIrFiles(paths);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`${message}\n`);
    return 1;
  }

  if (pruneMissing && files.length === 0) {
    io.stderr.write(
      'authoritative emit refused: no BankIR files in the subjects tree (will not wipe generated content)\n',
    );
    return 1;
  }

  const result = validateIrCollection(files, {
    replaceSample: parsed.replaceSample,
    frozenIds: sampleBankFrozenIds(),
  });
  if (!result.ok) {
    printIssues(io, result.errors);
    io.stderr.write(
      `validate failed (${result.errors.length} issue${result.errors.length === 1 ? '' : 's'})\n`,
    );
    return 1;
  }

  if (parsed.command === 'validate') {
    io.stdout.write(`${formatValidateOk(result.banks.length)}\n`);
    return 0;
  }

  let repoRoot: string;
  try {
    repoRoot = findRepoRoot(io.cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`${message}\n`);
    return 1;
  }

  let planned;
  try {
    planned = planEmit(result.banks, repoRoot, { pruneMissing });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`${message}\n`);
    return 1;
  }
  if (!parsed.apply) {
    io.stdout.write(`${formatEmitPlan(planned)}\n`);
    io.stdout.write('\n(dry-run; pass --apply to write)\n');
    return 0;
  }

  const written = applyEmit(planned);
  if (written.length === 0) {
    io.stdout.write('already up to date\n');
    return 0;
  }
  for (const file of written) {
    const verb = file.delete ? 'deleted' : file.existing === null ? 'created' : 'updated';
    io.stdout.write(`${verb} ${file.relPath}\n`);
  }
  return 0;
}

export function runCli(argv: readonly string[], io: CliIo): number {
  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    io.stderr.write(`${parsed.error}\n\n${USAGE}`);
    return 2;
  }
  if (parsed.command === 'help') {
    io.stdout.write(USAGE);
    return 0;
  }
  if (parsed.command === 'generate') {
    io.stderr.write('generate is async; use runCliAsync (pnpm examify-ingest generate)\n');
    return 2;
  }
  return runValidateOrEmit(parsed, io);
}
