import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Bytes } from './hash';
import { PROMPT_VERSION } from './schema';

export function findIngestPackageRoot(): string {
  return path.resolve(fileURLToPath(new URL('..', import.meta.url)));
}

export function generatePromptPath(packageRoot = findIngestPackageRoot()): string {
  return path.join(packageRoot, 'prompts', PROMPT_VERSION, 'generate-bank.md');
}

export type LoadedPrompt = {
  version: string;
  text: string;
  hash: string;
  path: string;
};

export function loadGeneratePrompt(packageRoot = findIngestPackageRoot()): LoadedPrompt {
  const promptPath = generatePromptPath(packageRoot);
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
