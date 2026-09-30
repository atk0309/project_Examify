import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { budgetSummary } from './export-budget.mjs';
test('only reserved counters and approved token fields reach the artifact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-budget-export-'));
  try {
    fs.writeFileSync(path.join(dir, 'openai-0'), '');
    fs.writeFileSync(path.join(dir, 'openai-1'), '');
    fs.writeFileSync(
      path.join(dir, 'server-process-123.json'),
      JSON.stringify({ secret: 'synthetic-canary' }),
    );
    fs.writeFileSync(
      path.join(dir, 'openai-0-usage.json'),
      JSON.stringify({
        provider: 'openai',
        model: 'gpt-4o',
        inputTokens: 100,
        outputTokens: 200,
        secret: 'synthetic-canary',
      }),
    );
    const s = budgetSummary(dir);
    assert.equal(s.providers.openai.reservedRequests, 2);
    assert.equal(s.providers.openai.requests[0].inputTokens, 100);
    assert.equal(s.providers.openai.requests[1].usageStatus, 'unverified');
    assert.equal(s.providers.anthropic.reservedRequests, 0);
    assert.ok(!JSON.stringify(s).includes('synthetic-canary'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
