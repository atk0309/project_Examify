import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seedOriginalBudget, ORIGINAL_EXPIRY } from './seed-original-budget.mjs';
import { budgetSummary } from './export-budget.mjs';
test('replacement carries observed cost and consumes the original slot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-carry-'));
  try {
    seedOriginalBudget(dir, ORIGINAL_EXPIRY);
    const summary = budgetSummary(dir);
    assert.equal(summary.providers.openai.reservedRequests, 5);
    assert.equal(summary.providers.openai.requests[0].inputTokens, 1115);
    assert.equal(summary.providers.openai.requests[0].outputTokens, 809);
    assert.equal(summary.providers.openai.requests[0].priorRunId, '36707547014');
    assert.equal(summary.providers.openai.requests[1].outputTokens, 771);
    assert.equal(summary.providers.openai.requests[1].priorRunId, '36708662338');
    assert.equal(summary.providers.openai.requests[2].outputTokens, 809);
    assert.equal(summary.providers.openai.requests[2].priorRunId, '36713528756');
    assert.equal(summary.providers.openai.requests[3].inputTokens, 1703);
    assert.equal(summary.providers.openai.requests[3].outputTokens, 782);
    assert.equal(summary.providers.openai.requests[3].priorRunId, '36719205674');
    assert.equal(summary.providers.openai.requests[4].inputTokens, 1707);
    assert.equal(summary.providers.openai.requests[4].outputTokens, 864);
    assert.equal(summary.providers.openai.requests[4].priorRunId, '36723888076');
    assert.equal(summary.providers.anthropic.reservedRequests, 1);
    assert.equal(summary.providers.anthropic.requests[0].inputTokens, 303);
    assert.equal(summary.providers.anthropic.requests[0].outputTokens, 54);
    assert.equal(summary.providers.anthropic.requests[0].priorRunId, '36723888076');
    assert.throws(() => seedOriginalBudget(dir, ORIGINAL_EXPIRY), /reset/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('replacement cannot silently extend expiry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-carry-expiry-'));
  try {
    assert.throws(() => seedOriginalBudget(dir, '2026-09-30T13:59:00Z'), /expiry_changed/);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
