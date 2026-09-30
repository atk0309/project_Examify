import test from 'node:test';
import assert from 'node:assert/strict';
import { safeGenerationDiagnostic, captureGenerationWarning } from './generation-diagnostic.mjs';
const good = { category: 'schema', fields: [{ path: 'difficulties.easy.[].provenance.pdf', code: 'invalid_type' }] };
test('captures only fixed product category/path/code, never subject IDs or logs', () => {
  const out = [];
  captureGenerationWarning(['[onboarding] generate failed', { reason: 'provider_output_invalid', subjectId: 'SECRET_CANARY', outputDiagnostic: good }], x => out.push(x));
  assert.deepEqual(out, [good]);
  assert.ok(!JSON.stringify(out).includes('SECRET_CANARY'));
  captureGenerationWarning(['arbitrary raw log SECRET_CANARY'], x => out.push(x));
  assert.equal(out.length, 1);
});
test('rejects arbitrary keys, paths, codes, categories and accessors', () => {
  for (const bad of [
    { ...good, raw: 'SECRET_CANARY' },
    { ...good, category: 'SECRET_CANARY' },
    { ...good, fields: [{ path: 'subject.SECRET_CANARY', code: 'invalid' }] },
    { ...good, fields: [{ path: 'meta.sourceHashes.SECRET_CANARY', code: 'invalid' }] },
    { ...good, fields: [{ path: 'root', code: 'SECRET_CANARY' }] },
    { ...good, fields: [{ path: 'root', code: 'invalid', value: 'SECRET_CANARY' }] },
    { ...good, fields: Array(7).fill(good.fields[0]) },
    { get category() { throw Error('must not invoke'); }, fields: [] },
  ]) assert.equal(safeGenerationDiagnostic(bad), null);
});

test('accepts bounded diagnostic JSON string and rejects malformed or oversized strings', () => {
  const out = [];
  const send = value => captureGenerationWarning(['[onboarding] generate failed', { reason: 'provider_output_invalid', outputDiagnostic: value }], x => out.push(x));
  send(JSON.stringify(good));
  send('SECRET_CANARY');
  send(' '.repeat(4097));
  send(JSON.stringify({ ...good, raw: 'SECRET_CANARY' }));
  assert.deepEqual(out, [good]);
  assert.equal(safeGenerationDiagnostic(Object.create({ category: 'schema', fields: [] })), null);
});

test('rejects accessor-bearing field arrays without invoking getters', () => {
  const fields = [];
  Object.defineProperty(fields, '0', { get() { throw Error('must not invoke'); }, enumerable: true });
  assert.equal(safeGenerationDiagnostic({ category: 'schema', fields }), null);
});

test('custom array iterators cannot bypass the field count or execute code', () => {
  const fields = [];
  fields[Symbol.iterator] = function* () { throw Error('must not invoke'); };
  assert.deepEqual(safeGenerationDiagnostic({ category: 'schema', fields }), { category: 'schema', fields: [] });
  assert.equal(safeGenerationDiagnostic({ category: 'schema', fields: Array(1) }), null);
});
