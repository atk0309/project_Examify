import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fixtureBank,
  FIXTURE_MODEL,
  FIXTURE_SUBJECTS,
  startFixtureProvider,
} from './fixture-http-provider.mjs';

function requestFor(fixture = FIXTURE_SUBJECTS[0]) {
  return {
    model: FIXTURE_MODEL,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Subject metadata (use exactly): ${JSON.stringify({ id: fixture.id, label: fixture.label, icon: 'maths', l: 0.5, c: 0.1, h: 20 })}\n\nSources:`,
          },
          {
            type: 'text',
            text: `BEGIN UNTRUSTED SOURCE MATERIAL (${fixture.filename})\n${fixture.text}`,
          },
        ],
      },
    ],
  };
}
test('offline provider is deterministic and requires actual source content', () => {
  for (const fixture of FIXTURE_SUBJECTS) {
    const body = requestFor(fixture);
    const bank = fixtureBank(body);
    assert.deepEqual(fixtureBank(body), bank);
    assert.equal(bank.subject.id, fixture.id);
    assert.ok(
      bank.difficulties.easy.every(
        (question) => question.answer === 1 && question.provenance.pdf === fixture.filename,
      ),
    );
    body.messages[0].content.pop();
    assert.throws(() => fixtureBank(body), /source did not reach/);
  }
});
test('HTTP fixture serves local provider protocol and records only bounded subject IDs', async () => {
  const provider = await startFixtureProvider();
  try {
    const response = await fetch(provider.origin + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestFor()),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(JSON.parse(payload.choices[0].message.content).subject.id, FIXTURE_SUBJECTS[0].id);
    assert.deepEqual(provider.calls, [FIXTURE_SUBJECTS[0].id]);
    assert.equal((await fetch(provider.origin + '/wrong')).status, 404);
  } finally {
    await provider.close();
  }
});
