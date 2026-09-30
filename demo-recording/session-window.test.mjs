import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionDeadline, assertWindow } from './session-window.mjs';
const now = Date.parse('2026-09-30T10:00:00Z');
test('live requires strict absolute UTC expiry within two hours', () => {
  for (const value of ['', undefined, 'in 2h', '2026-09-30T09:59:59Z', '2026-09-30T12:00:01Z'])
    assert.throws(() => sessionDeadline('live', value, now));
  assert.equal(sessionDeadline('live', '2026-09-30T12:00:00Z', now), now + 7200000);
});
test('expiry cannot restart on a subsequent workflow rerun', () => {
  const deadline = sessionDeadline('live', '2026-09-30T11:00:00Z', now);
  assertWindow(deadline, now);
  assert.throws(() => assertWindow(deadline, now + 3600000));
  assert.throws(() => sessionDeadline('live', '2026-09-30T11:00:00Z', now + 3600000));
});
test('missing live mode supplies no live authorization', () => {
  assert.equal(sessionDeadline(undefined, '2026-09-30T11:00:00Z', now), null);
  assert.throws(() => assertWindow(null, now));
});
