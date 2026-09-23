import path from 'node:path';
import { parseArgs, resolveCliLayer, runCli, USAGE, type CliIo, type ParsedCli } from './cli';
import { NEXT_INGEST_COMMANDS, generateTargets } from './generate';
import { mergeRepoEnvFiles } from './repo-env';
import { subjectsArgFor, type IngestRoot } from './roots';
import { resolveGenerateTargets } from './sources';

function pathFromRoot(repoRoot: string, absPath: string): string {
  return path.relative(repoRoot, absPath).split(path.sep).join('/') || absPath;
}

/** The HITL follow-up commands, naming the layer's subjects tree. */
export function nextIngestCommands(ingest: Pick<IngestRoot, 'layer' | 'dataDirDisplay'>): string[] {
  const subjects = subjectsArgFor(ingest);
  return NEXT_INGEST_COMMANDS.map((command) => command.replace('content/subjects', subjects));
}

async function runGenerate(parsed: ParsedCli, io: CliIo): Promise<number> {
  if (!parsed.provider) {
    io.stderr.write(
      'generate requires --provider anthropic|openai|local|claude-cli|codex-cli|test\n',
    );
    return 2;
  }

  const ingest = resolveCliLayer(parsed, io);
  if (!ingest) return 1;
  // IR, IR cache, page cache and run manifests live under the layer root;
  // API keys always come from the checkout .env files.
  const { root, repoRoot } = ingest;

  let targets;
  try {
    targets = resolveGenerateTargets(parsed.paths, io.cwd, root, parsed.subject);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`${message}\n`);
    return 1;
  }

  const env = mergeRepoEnvFiles(repoRoot, io.env ?? process.env);

  try {
    const results = await generateTargets(targets, {
      repoRoot: root,
      provider: parsed.provider,
      model: parsed.model ?? undefined,
      seed: parsed.seed,
      dryRunIr: parsed.dryRunIr,
      force: parsed.force,
      replaceSample: parsed.replaceSample,
      env,
    });
    for (let i = 0; i < results.length; i += 1) {
      const result = results[i]!;
      const target = targets[i]!;
      const verb = result.wroteIr
        ? result.irExisted
          ? 'overwrote'
          : 'wrote'
        : result.irExisted
          ? 'would overwrite'
          : 'would write';
      const cache = result.cacheHit ? 'cache hit' : 'generated';
      io.stdout.write(
        `${verb} ${pathFromRoot(root, result.irPath)} (${target.subjectId}, ${cache}, cacheKey=${result.cacheKey})\n`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`${message}\n`);
    return 1;
  }

  io.stdout.write('\nGenerate writes BankIR only. Next (HITL, not auto-applied):\n');
  for (const command of nextIngestCommands(ingest)) {
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
