import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Bytes } from './hash';
import { PROMPT_VERSION } from './schema';

const PROMPT_REL = path.join('prompts', PROMPT_VERSION, 'generate-bank.md');

function promptCandidates(repoRoot?: string): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [
    repoRoot ? path.join(repoRoot, 'tools', 'examify-ingest', PROMPT_REL) : null,
    path.resolve(here, '..', PROMPT_REL),
    path.resolve(here, PROMPT_REL),
  ].filter((value): value is string => Boolean(value));
}

export function findIngestPackageRoot(repoRoot?: string): string {
  for (const candidate of promptCandidates(repoRoot)) {
    if (existsSync(candidate)) return path.dirname(path.dirname(candidate));
  }
  throw new Error('could not find examify-ingest prompts/v1/generate-bank.md');
}

export function generatePromptPath(repoRoot?: string): string {
  for (const candidate of promptCandidates(repoRoot)) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `generate prompt not found (looked for tools/examify-ingest/${PROMPT_REL} from the repo root and next to the ingest package)`,
  );
}

export type LoadedPrompt = {
  version: string;
  text: string;
  hash: string;
  path: string;
};

export function loadGeneratePrompt(repoRoot?: string): LoadedPrompt {
  const promptPath = generatePromptPath(repoRoot);
  const text = readFileSync(promptPath, 'utf8');
  if (text.trim() === '') {
    throw new Error(`generate prompt is empty: ${promptPath}`);
  }
  return {
    version: PROMPT_VERSION,
    text,
    hash: sha256Bytes(text),
    path: promptPath,
  };
}
