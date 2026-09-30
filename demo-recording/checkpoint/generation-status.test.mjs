import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyGenerationError } from './generation-status.mjs';
test('exports a fixed category for malformed provider output', () => {
  assert.equal(classifyGenerationError('The AI replied, but not with questions Examify can use. Try Generate again. Nothing was written.'), 'provider_output_invalid');
});
test('does not echo arbitrary error contents', () => {
  for (const value of ['secret-token-do-not-export', '', null, 'Error: private request body'])
    assert.equal(classifyGenerationError(value), 'unclassified_failure');
});
