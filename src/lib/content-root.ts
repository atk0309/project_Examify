import { getDataPaths } from '@/lib/data-dir';

let contentRootOverride: string | null = null;

/** Tests only — point subject/PDF/generated I/O at a temp tree. */
export function setOnboardingContentRootForTests(root: string | null): void {
  contentRootOverride = root;
}

/**
 * Family content root for wizard subjects / uploads / BankIR / generated
 * JSON and the live bank: the family data folder, never the checkout.
 * (`.env` stays in the checkout — see `getEnvStoreRoot`.)
 */
export function getOnboardingContentRoot(): string {
  return contentRootOverride ?? getDataPaths().familyRoot;
}
