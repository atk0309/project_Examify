import { findRepoRoot } from 'examify-ingest';

let contentRootOverride: string | null = null;

/** Tests only — point subject/PDF/generated I/O at a temp tree. */
export function setOnboardingContentRootForTests(root: string | null): void {
  contentRootOverride = root;
}

export function getOnboardingContentRoot(): string {
  return contentRootOverride ?? findRepoRoot(process.cwd());
}
