import path from 'node:path';
import { parseArgs, runCli, USAGE, type CliIo, type ParsedCli } from './cli';
import { NEXT_INGEST_COMMANDS, generateSubject } from './generate';
import { findRepoRoot } from './load';
import { mergeRepoEnvFiles } from './repo-env';
import { resolveGenerateTargets } from './sources';

function pathFromRoot(repoRoot: string, absPath: string): string {
  return path.relative(repoRoot, absPath).split(path.sep).join('/') || absPath;
}

async function runGenerate(parsed: ParsedCli, io: CliIo): Promise<number> {
  if (!parsed.provider) {
    io.stderr.write('generate requires --provider anthropic|openai|local|test\n');
    return 2;
  }

  let repoRoot: string;
  try {
    repoRoot = findRepoRoot(io.cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`${message}\n`);
    return 1;
  }

  let targets;
  try {
    targets = resolveGenerateTargets(parsed.paths, io.cwd, repoRoot, parsed.subject);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`${message}\n`);
    return 1;
  }

  const env = mergeRepoEnvFiles(repoRoot, io.env ?? process.env);

  try {
    for (const target of targets) {
      const result = await generateSubject({
        repoRoot,
        subject: target.subject,
        subjectDir: target.subjectDir,
        sources: target.sources,
        provider: parsed.provider,
        model: parsed.model ?? undefined,
        seed: parsed.seed,
        dryRunIr: parsed.dryRunIr,
        env,
      });
      const verb = result.wroteIr ? 'wrote' : 'would write';
      const cache = result.cacheHit ? 'cache hit' : 'generated';
      io.stdout.write(
        `${verb} ${pathFromRoot(repoRoot, result.irPath)} (${target.subjectId}, ${cache}, cacheKey=${result.cacheKey})\n`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`${message}\n`);
    return 1;
  }

  io.stdout.write('\nGenerate writes BankIR only. Next (HITL, not auto-applied):\n');
  for (const command of NEXT_INGEST_COMMANDS) {
    io.stdout.write(`  ${command}\n`);
  }
  return 0;
}

/** Async CLI entry. validate/emit stay sync via `runCli`. */
export async function runCliAsync(argv: readonly string[], io: CliIo): Promise<number> {
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
    return runGenerate(parsed, io);
  }
  return runCli(argv, io);
}
