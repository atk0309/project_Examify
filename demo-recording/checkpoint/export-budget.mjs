// Export only bounded call/token evidence, never process records or request data.
import fs from 'node:fs';
import { safeGenerationDiagnostic } from './generation-diagnostic.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const models = { openai: 'gpt-4o', anthropic: 'claude-sonnet-4-6' };
export function budgetSummary(ledger) {
  const summary = { requestLimitPerProvider: 8, approvedCeilingUsdPerProvider: 5, providers: {} };
  for (const provider of Object.keys(models)) {
    const requests = [];
    for (let slot = 0; slot < 8; slot++) {
      if (!fs.existsSync(path.join(ledger, `${provider}-${slot}`))) continue;
      let item = { slot, usageStatus: 'unverified' };
      try {
        const u = JSON.parse(
          fs.readFileSync(path.join(ledger, `${provider}-${slot}-usage.json`), 'utf8'),
        );
        if (
          u.provider === provider &&
          u.model === models[provider] &&
          Number.isSafeInteger(u.inputTokens) &&
          u.inputTokens >= 0 &&
          u.inputTokens <= 66560 &&
          Number.isSafeInteger(u.outputTokens) &&
          u.outputTokens >= 0 &&
          u.outputTokens <= 8192
        )
          item = {
            slot,
            usageStatus: 'observed',
            model: models[provider],
            inputTokens: u.inputTokens,
            outputTokens: u.outputTokens,
          };
        if (
          item.usageStatus === 'observed' &&
          typeof u.priorRunId === 'string' &&
          /^[1-9]\d+$/.test(u.priorRunId)
        )
          item.priorRunId = u.priorRunId;
      } catch {
        /* Unknown usage still consumes its full reserved request allowance. */
      }
      requests.push(item);
    }
    summary.providers[provider] = { reservedRequests: requests.length, requests };
  }
  return summary;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  fs.mkdirSync('demo-recording/evidence', { recursive: true });
  try {
    const raw = JSON.parse(fs.readFileSync('tests/.tmp/demo-budget/generation-diagnostic.json', 'utf8'));
    const diagnostic = safeGenerationDiagnostic(raw);
    if (diagnostic) fs.writeFileSync('demo-recording/evidence/generation-diagnostic.json', JSON.stringify(diagnostic));
  } catch { /* Missing or invalid diagnostic is not exported. */ }
  fs.writeFileSync(
    'demo-recording/evidence/budget-summary.json',
    JSON.stringify(budgetSummary('tests/.tmp/demo-budget'), null, 2),
  );
}
