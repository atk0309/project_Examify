// Controlled recovery after the four observed runs. These are usage counters,
// not credentials. Preserve its consumed request slot and explicitly renewed fixed expiry.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
export const ORIGINAL_EXPIRY = '2026-09-30T14:00:00Z';
export function seedOriginalBudget(ledger, expiry) {
  if (expiry !== ORIGINAL_EXPIRY) throw Error('original_demo_expiry_changed');
  fs.mkdirSync(ledger, { recursive: true, mode: 0o700 });
  if (fs.readdirSync(ledger).length !== 0) throw Error('refuse_to_reset_existing_budget');
  const previous = [
    { outputTokens: 809, priorRunId: '36707547014' },
    { outputTokens: 771, priorRunId: '36708662338' },
    { outputTokens: 809, priorRunId: '36713528756' },
    { inputTokens: 1703, outputTokens: 782, priorRunId: '36719205674' },
  ];
  for (const [slot, usage] of previous.entries()) {
    fs.closeSync(fs.openSync(path.join(ledger, `openai-${slot}`), 'wx', 0o600));
    fs.writeFileSync(
      path.join(ledger, `openai-${slot}-usage.json`),
      JSON.stringify({ provider: 'openai', model: 'gpt-4o', inputTokens: 1115, ...usage }),
      { flag: 'wx', mode: 0o600 },
    );
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedOriginalBudget('tests/.tmp/demo-budget', process.env.DEMO_EXPIRES_AT);
  console.log(
    'Preserved the original expiry and prior OpenAI reservation; four OpenAI slots remain.',
  );
}
