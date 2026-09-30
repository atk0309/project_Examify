// One replacement after the cancelled, observed run. These are usage counters,
// not credentials. Preserve its consumed request slot and exact original expiry.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
export const ORIGINAL_EXPIRY = '2026-09-30T12:59:00Z';
export function seedOriginalBudget(ledger, expiry) {
  if (expiry !== ORIGINAL_EXPIRY) throw Error('original_demo_expiry_changed');
  fs.mkdirSync(ledger, { recursive: true, mode: 0o700 });
  if (fs.readdirSync(ledger).length !== 0) throw Error('refuse_to_reset_existing_budget');
  fs.closeSync(fs.openSync(path.join(ledger, 'openai-0'), 'wx', 0o600));
  fs.writeFileSync(
    path.join(ledger, 'openai-0-usage.json'),
    JSON.stringify({
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: 1115,
      outputTokens: 809,
      priorRunId: '36707547014',
    }),
    { flag: 'wx', mode: 0o600 },
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedOriginalBudget('tests/.tmp/demo-budget', process.env.DEMO_EXPIRES_AT);
  console.log(
    'Preserved the original expiry and prior OpenAI reservation; seven OpenAI slots remain.',
  );
}
