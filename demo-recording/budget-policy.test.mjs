import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundedRequest, LIMITS, worstCaseUsd } from './budget-policy.mjs';
const url = 'https://api.openai.com/v1/chat/completions';
const request = (extra) => ({
  method: 'POST',
  body: JSON.stringify({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Synthetic cells notes' }],
    ...extra,
  }),
});
test('caps generation; preserves bounded grading', () => {
  assert.equal(JSON.parse(boundedRequest(url, request({})).body).max_tokens, LIMITS.outputTokens);
  assert.equal(JSON.parse(boundedRequest(url, request({ max_tokens: 700 })).body).max_tokens, 700);
});
test('rejects wrong models, endpoints, image input, tools, and excessive text', () => {
  assert.throws(() => boundedRequest(url, request({ model: 'other' })));
  assert.throws(() => boundedRequest('https://example.com', request({})));
  assert.throws(() => boundedRequest(url, request({ tools: [] })));
  assert.throws(() =>
    boundedRequest(
      url,
      request({
        messages: [
          { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:x' } }] },
        ],
      }),
    ),
  );
  assert.throws(() =>
    boundedRequest(url, request({ messages: [{ role: 'user', content: 'x'.repeat(33000) }] })),
  );
});
test('conservative standard-price bound below approved cap', () => {
  assert.equal(worstCaseUsd('openai'), 1.98656);
  assert.ok(worstCaseUsd('anthropic') < 2.59);
  assert.ok(worstCaseUsd('openai') < 5 && worstCaseUsd('anthropic') < 5);
});
