import http from 'node:http';

/** Offline acceptance facts, deliberately unrelated to any real learner material. */
export const FIXTURE_SUBJECTS = [
  {
    id: 'fixture-orbits',
    label: 'Fixture Orbits',
    filename: 'orbit-notes.txt',
    text: 'Acceptance study notes: Earth has one natural moon. The Moon orbits Earth.',
  },
  {
    id: 'fixture-weather',
    label: 'Fixture Weather',
    filename: 'weather-notes.md',
    text: '# Acceptance weather notes\nWater freezes at zero degrees Celsius. Ice is solid water.',
  },
];
export const FIXTURE_MODEL = 'examify-offline-acceptance';

/** Exercise the real local HTTP provider protocol, including uploaded source delivery. */
export function fixtureBank(body) {
  if (body?.model !== FIXTURE_MODEL || body?.temperature !== 0)
    throw new Error('Unexpected fixture model');
  const parts = body.messages?.find((message) => message.role === 'user')?.content;
  if (!Array.isArray(parts)) throw new Error('Expected real provider content blocks');
  const texts = parts.filter((part) => part.type === 'text').map((part) => part.text);
  const metadata = texts.find((text) => text.startsWith('Subject metadata (use exactly): '));
  const line = metadata?.split('\n')[0]?.slice('Subject metadata (use exactly): '.length);
  const subject = JSON.parse(line || '{}');
  const fixture = FIXTURE_SUBJECTS.find((candidate) => candidate.id === subject.id);
  if (!fixture || subject.label !== fixture.label) throw new Error('Unknown fixture subject');
  if (
    !texts.some(
      (text) =>
        text.includes('UNTRUSTED SOURCE MATERIAL') &&
        text.includes(fixture.filename) &&
        text.includes(fixture.text),
    )
  ) {
    throw new Error('Uploaded UTF-8 source did not reach the real local provider');
  }
  return {
    version: 1,
    subject,
    difficulties: {
      easy: [1, 2].map((index) => ({
        id: `${subject.id}-easy-${index}`,
        type: 'mcq',
        q: `Offline fixture ${index}: which option agrees with your uploaded ${fixture.label} notes?`,
        choices: [
          'Not the fixture fact',
          index === 1 ? fixture.text.split('\n').at(-1) : 'The uploaded notes are the source',
          'Another incorrect option',
          'None of these',
        ],
        answer: 1,
        provenance: {
          pdf: fixture.filename,
          locator: `offline acceptance fixture, question ${index}`,
        },
      })),
      medium: [],
      hard: [],
    },
  };
}

export async function startFixtureProvider() {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    try {
      if (
        request.method !== 'POST' ||
        request.url !== '/v1/chat/completions' ||
        request.headers.authorization
      ) {
        response.writeHead(404).end();
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) throw new Error('Fixture body too large');
        chunks.push(chunk);
      }
      const bank = fixtureBank(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      calls.push(bank.subject.id);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(bank) } }] }));
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Invalid offline acceptance fixture request' }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    calls,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}
