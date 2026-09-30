import fs from 'node:fs';
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

test('nested tool calls and unapproved response formats are rejected', () => {
  assert.throws(() =>
    boundedRequest(
      url,
      request({ messages: [{ role: 'assistant', content: '', tool_calls: [] }] }),
    ),
  );
  assert.throws(() =>
    boundedRequest(url, request({ response_format: { type: 'json_schema', json_schema: {} } })),
  );
});

test('permits only the exact reviewed BankIR schema within unchanged byte/output caps', () => {
  const format = JSON.parse(fs.readFileSync(new URL('./fixtures/openai-response-format.json', import.meta.url), 'utf8'));
  const result = boundedRequest(url, request({ response_format: format }));
  assert.deepEqual(JSON.parse(result.body).response_format, format);
  assert.equal(JSON.parse(result.body).max_tokens, 8192);
  assert.ok(Buffer.byteLength(result.body) <= 32768);
  for (const mutate of [
    (f) => { f.json_schema.strict = false; },
    (f) => { f.json_schema.name = 'another_schema'; },
    (f) => { f.json_schema.schema.additionalProperties = true; },
    (f) => { f.json_schema.extra = 'unapproved'; },
    (f) => { f.extra = 'unapproved'; },
  ]) {
    const changed = structuredClone(format); mutate(changed);
    assert.throws(() => boundedRequest(url, request({ response_format: changed })), /demo_response_format/);
  }
  assert.throws(() => boundedRequest(url, request({ response_format: format, messages: [{ role: 'user', content: 'x'.repeat(30000) }] })), /demo_input_limit/);
});
