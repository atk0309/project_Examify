import { SAMPLE_QUESTIONS } from '../../../src/lib/exam/data';
import { applyEmit, formatEmitPlan, planEmit } from './emit';
import { collectQuestionIds } from './ids';
import { findRepoRoot, isAuthoritativeCatalogInput, loadIrFiles, resolveIrFiles } from './load';
import { validateIrCollection } from './validate';

export const USAGE = `Usage:
  examify-ingest validate <subjects-dir|ir.json...> [--replace-sample]
  examify-ingest emit <subjects-dir|ir.json...> [--dry-run] [--apply] [--replace-sample]

emit is dry-run by default. Writes only with --apply.
A subjects-directory emit (every path is a directory, typically content/subjects)
prunes leftover generated subject JSON. Explicit IR files never prune; mixed
file+directory argv is partial-safe and never prunes.
`;

export type CliIo = {
  cwd: string;
  stdout: { write: (chunk: string) => void };
  stderr: { write: (chunk: string) => void };
};

export type ParsedCli = {
  command: 'validate' | 'emit' | 'help';
  paths: string[];
  apply: boolean;
  dryRun: boolean;
  replaceSample: boolean;
};

export function parseArgs(argv: readonly string[]): ParsedCli | { error: string } {
  const flags = new Set<string>();
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith('--')) flags.add(arg);
    else positional.push(arg);
  }

  const unknown = [...flags].filter(
    (flag) => !['--apply', '--dry-run', '--replace-sample', '--help'].includes(flag),
  );
  if (unknown.length > 0) return { error: `unknown flag ${unknown[0]}` };

  if (flags.has('--help') || positional[0] === 'help' || positional.length === 0) {
    return { command: 'help', paths: [], apply: false, dryRun: true, replaceSample: false };
  }

  const command = positional[0];
  if (command !== 'validate' && command !== 'emit') {
    return { error: `unknown command ${command}` };
  }

  const paths = positional.slice(1);
  if (paths.length === 0) return { error: 'expected a subjects directory or BankIR file path' };

  const apply = flags.has('--apply');
  const dryRun = flags.has('--dry-run') || !apply;
  if (apply && flags.has('--dry-run')) {
    return { error: 'use either --apply or --dry-run, not both' };
  }

  return {
    command,
    paths,
    apply,
    dryRun,
    replaceSample: flags.has('--replace-sample'),
  };
}

function printIssues(io: CliIo, errors: readonly { path?: string; message: string }[]): void {
  for (const error of errors) {
    const prefix = error.path ? `${error.path}: ` : '';
    io.stderr.write(`${prefix}${error.message}\n`);
  }
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

  let files;
  try {
    const paths = resolveIrFiles(parsed.paths, io.cwd);
    files = loadIrFiles(paths);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`${message}\n`);
    return 1;
  }

  const result = validateIrCollection(files, {
    replaceSample: parsed.replaceSample,
    frozenIds: collectQuestionIds(SAMPLE_QUESTIONS),
  });
  if (!result.ok) {
    printIssues(io, result.errors);
    io.stderr.write(
      `validate failed (${result.errors.length} issue${result.errors.length === 1 ? '' : 's'})\n`,
    );
    return 1;
  }

  if (parsed.command === 'validate') {
    io.stdout.write(
      `ok ${result.banks.length} BankIR file${result.banks.length === 1 ? '' : 's'}\n`,
    );
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
    planned = planEmit(result.banks, repoRoot, {
      pruneMissing: isAuthoritativeCatalogInput(parsed.paths, io.cwd),
    });
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

const isMain = process.argv[1] && /cli\.ts$/.test(process.argv[1]);
if (isMain) {
  process.exitCode = runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
