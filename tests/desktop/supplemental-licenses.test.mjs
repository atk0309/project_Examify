import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadSupplementalNotices } from '../../scripts/desktop/supplemental-licenses.mjs';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-notices-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const documents = ['dotenv', 'dotenv-expand'].map((component) => {
    const bytes = Buffer.from(`Fixture ${component}`),
      file = `${component}-LICENSE`;
    fs.writeFileSync(path.join(root, file), bytes);
    return {
      file,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sourceUrl: `https://example.invalid/${component}`,
      associations: [
        {
          package: '@next/env',
          version: '16.3.6',
          component,
          componentVersion: component === 'dotenv' ? '16.3.1' : '10.0.0',
        },
      ],
    };
  });
  const write = () =>
    fs.writeFileSync(
      path.join(root, 'provenance.json'),
      JSON.stringify({ schemaVersion: 1, documents }),
    );
  write();
  return { root, documents, write };
}
test('exact shipped package and embedded component versions are required', (t) => {
  const { root, documents, write } = fixture(t);
  assert.equal(
    loadSupplementalNotices([{ name: '@next/env', version: '16.3.6' }], { root }).files.length,
    2,
  );
  assert.equal(loadSupplementalNotices([], { root }).files.length, 0);
  assert.throws(
    () => loadSupplementalNotices([{ name: '@next/env', version: '16.4.0' }], { root }),
    /Missing exact-version/,
  );
  documents[0].associations[0].componentVersion = '99.0.0';
  write();
  assert.throws(
    () => loadSupplementalNotices([{ name: '@next/env', version: '16.3.6' }], { root }),
    /Missing exact-version/,
  );
});
test('tampering, missing coverage and escaping paths fail closed', (t) => {
  const { root, documents, write } = fixture(t);
  fs.appendFileSync(path.join(root, documents[0].file), 'changed');
  assert.throws(() => loadSupplementalNotices([], { root }), /bytes do not match/);
  documents.shift();
  write();
  assert.throws(
    () => loadSupplementalNotices([{ name: '@next/env', version: '16.3.6' }], { root }),
    /Missing exact-version/,
  );
  documents[0].file = '../outside';
  write();
  assert.throws(() => loadSupplementalNotices([], { root }), /Invalid supplemental/);
});
test('nested evidence works but linked ancestors are rejected', (t) => {
  const { root, documents, write } = fixture(t);
  fs.mkdirSync(path.join(root, 'nested'));
  const file = documents[0].file;
  fs.renameSync(path.join(root, file), path.join(root, 'nested', file));
  documents[0].file = `nested/${file}`;
  write();
  assert.equal(
    loadSupplementalNotices([{ name: '@next/env', version: '16.3.6' }], { root }).files.length,
    2,
  );
  fs.renameSync(path.join(root, 'nested'), path.join(root, 'other'));
  try {
    fs.symlinkSync(path.join(root, 'other'), path.join(root, 'nested'), 'dir');
  } catch (error) {
    if (error.code === 'EPERM') return t.skip('Symlink unavailable');
    throw error;
  }
  assert.throws(() => loadSupplementalNotices([], { root }), /linked ancestors/);
});
test('checked-in original notices match verified hashes and retain attribution', () => {
  const result = loadSupplementalNotices([{ name: '@next/env', version: '16.3.6' }]);
  assert.equal(result.documents.length, 2);
  for (const file of result.files) assert.match(file.bytes.toString(), /Scott Motte/);
});
