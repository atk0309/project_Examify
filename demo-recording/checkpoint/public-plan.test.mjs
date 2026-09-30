import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSnapshot, parseAnswerPlan, waitForAnswerPlan, findAnswer, chooseDemoDifficulty } from './public-plan.mjs';
const bank = {
  easy: [
    {
      id: 'demo-1',
      type: 'mcq',
      q: 'What makes sugar using light?',
      choices: ['Nucleus', 'Chloroplasts', 'Cell wall', 'Mitochondria'],
    },
    { id: 'demo-2', type: 'free', q: 'What releases energy from food?' },
  ],
  medium: [],
  hard: [],
};
const snapshot = makeSnapshot({
  bank,
  run: '12345',
  sourceNotes: 'Chloroplasts use light to make sugar. Mitochondria release energy from food.',
});
const plan = {
  schemaVersion: 1,
  runId: '12345',
  questionHash: snapshot.questionHash,
  answers: [
    { id: 'demo-1', type: 'mcq', chosenText: 'Chloroplasts' },
    { id: 'demo-2', type: 'free', response: 'Mitochondria release energy from food.' },
  ],
};
const clone = (x) => JSON.parse(JSON.stringify(x));
test('public snapshot refuses keys/rubrics and unknown fields', () => {
  for (const field of ['answer', 'rubric', 'provenance', 'key']) {
    const b = clone(bank);
    b.easy[0][field] = 'never export';
    assert.throws(() => makeSnapshot({ bank: b, run: '12345', sourceNotes: 'notes' }));
  }
  assert.throws(() =>
    makeSnapshot({ bank: { version: 1, ...bank }, run: '12345', sourceNotes: 'notes' }),
  );
});
test('answer data is complete, exact and safe with reordered options', () => {
  const answers = parseAnswerPlan(JSON.stringify(plan), snapshot);
  assert.equal(
    findAnswer(snapshot, answers, {
      question: bank.easy[0].q,
      choices: [...bank.easy[0].choices].reverse(),
    }).chosenText,
    'Chloroplasts',
  );
  assert.equal(
    findAnswer(snapshot, answers, { question: bank.easy[1].q }).response,
    plan.answers[1].response,
  );
  assert.throws(() => findAnswer(snapshot, answers, { question: 'Unseen question' }));
});
test('changing generated wording or options invalidates old plans', () => {
  for (const transform of [
    (b) => (b.easy[0].q += ' Please explain.'),
    (b) => b.easy[0].choices.reverse(),
    (b) => b.easy.reverse(),
  ]) {
    const b = clone(bank);
    transform(b);
    const next = makeSnapshot({ bank: b, run: '12345', sourceNotes: 'notes' });
    assert.throws(() => parseAnswerPlan(JSON.stringify(plan), next));
  }
});
test('rejects stale/missing/duplicate/unknown answers and command fields', () => {
  for (const transform of [
    (p) => (p.runId = '999'),
    (p) => (p.questionHash = 'stale'),
    (p) => p.answers.pop(),
    (p) => (p.answers[1] = p.answers[0]),
    (p) => (p.answers[0].chosenText = 'wrong option'),
    (p) => (p.command = 'node steal-keys'),
    (p) => (p.answers[0].eval = 'process.env'),
    (p) => (p.answers[1].response = 'x'.repeat(801)),
  ]) {
    const p = clone(plan);
    transform(p);
    assert.throws(() => parseAnswerPlan(JSON.stringify(p), snapshot));
  }
});
test('waits for delayed answer DATA, never executes code or changes expiry', async () => {
  let time = 1000,
    calls = 0;
  const result = await waitForAnswerPlan(snapshot, {
    expiresAt: 61000,
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    fetchFn: async (url, init) => {
      assert.ok(url.startsWith('https://raw.githubusercontent.com/atk0309/project_Examify/'));
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers, undefined);
      calls++;
      return calls === 1 ? new Response('', { status: 404 }) : new Response(JSON.stringify(plan));
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.length, 2);
  assert.equal(time, 16000);
});
test('missing/expired windows and malformed supplied plans fail closed', async () => {
  for (const expiry of [undefined, 0, 1000, 7201001])
    await assert.rejects(
      waitForAnswerPlan(snapshot, {
        expiresAt: expiry,
        now: () => 1000,
        fetchFn: async () => {
          throw Error('must not fetch');
        },
      }),
    );
  await assert.rejects(
    waitForAnswerPlan(snapshot, {
      expiresAt: 61000,
      now: () => 1000,
      fetchFn: async () => new Response('{bad'),
    }),
  );
});
test('bounded timeout refuses even a plan arriving after expiry', async () => {
  let time = 1000;
  await assert.rejects(
    waitForAnswerPlan(snapshot, {
      expiresAt: 3000,
      now: () => time,
      pollMs: 1000,
      sleep: async (ms) => {
        time += ms;
      },
      fetchFn: async () => new Response('', { status: 404 }),
    }),
    /timed_out/,
  );
  time = 1000;
  await assert.rejects(
    waitForAnswerPlan(snapshot, {
      expiresAt: 3000,
      now: () => time,
      fetchFn: async () => {
        time = 3001;
        return new Response(JSON.stringify(plan));
      },
    }),
    /timed_out/,
  );
});

test('different coherent synthetic questions accept their own reviewed plan', () => {
  const varied = makeSnapshot({
    bank: {
      easy: [
        {
          id: 'variation-1',
          type: 'mcq',
          q: 'Where is genetic information stored?',
          choices: ['Membrane', 'Nucleus', 'Wall', 'Chloroplast'],
        },
        { id: 'variation-2', type: 'free', q: 'What does the cell membrane do?' },
      ],
      medium: [],
      hard: [],
    },
    run: '12346',
    sourceNotes:
      'The nucleus holds genetic information. The cell membrane controls entry and exit.',
  });
  const reviewed = {
    schemaVersion: 1,
    runId: varied.runId,
    questionHash: varied.questionHash,
    answers: [
      { id: 'variation-1', type: 'mcq', chosenText: 'Nucleus' },
      {
        id: 'variation-2',
        type: 'free',
        response: 'The cell membrane controls what enters and leaves the cell.',
      },
    ],
  };
  const answers = parseAnswerPlan(JSON.stringify(reviewed), varied);
  assert.equal(
    findAnswer(varied, answers, { question: varied.questions[1].q }).response,
    reviewed.answers[1].response,
  );
});
test('oversized streamed answer plan is cancelled before parsing', async () => {
  await assert.rejects(
    waitForAnswerPlan(snapshot, {
      expiresAt: 61000,
      now: () => 1000,
      fetchFn: async () => new Response('x'.repeat(32769)),
    }),
    /plan_size/,
  );
});

test('selects a public paper with written work across varying difficulty layouts', () => {
  assert.equal(chooseDemoDifficulty(bank), 'easy');
  const medium = { easy: [bank.easy[0]], medium: [bank.easy[1]], hard: [] };
  assert.equal(chooseDemoDifficulty(medium), 'medium');
  const snapshot = makeSnapshot({ bank: medium, difficulty: 'medium', run: '12345', sourceNotes: 'notes' });
  assert.equal(snapshot.difficulty, 'medium');
  assert.deepEqual(snapshot.questions, [bank.easy[1]]);
  assert.equal(chooseDemoDifficulty({ easy: [], medium: [], hard: [bank.easy[1]] }), 'hard');
});
test('no-written and excessive marking papers fail before launch without provider calls', () => {
  assert.throws(() => chooseDemoDifficulty({ easy: [bank.easy[0]], medium: [], hard: [] }), /no_bounded_written_paper/);
  const many = Array.from({length: 9}, (_, i) => ({ ...bank.easy[1], id: `written-${i}` }));
  assert.throws(() => chooseDemoDifficulty({ easy: many, medium: [], hard: [] }), /no_bounded_written_paper/);
  assert.throws(() => chooseDemoDifficulty({ easy: [{ ...bank.easy[1], rubric: 'private' }] }), /private_or_unknown/);
  assert.throws(() => makeSnapshot({ bank, difficulty: 'invalid', run: '12345', sourceNotes: 'notes' }), /difficulty/);
});

test('skips oversized or ambiguous papers in favour of a safe later difficulty', () => {
  const many = Array.from({length: 21}, (_, i) => ({ ...bank.easy[1], id: `written-${i}` }));
  assert.equal(chooseDemoDifficulty({ easy: many, medium: [bank.easy[1]], hard: [] }), 'medium');
  const duplicates = [bank.easy[1], { ...bank.easy[1], id: 'different-id-same-visible-question' }];
  assert.equal(chooseDemoDifficulty({ easy: duplicates, medium: [], hard: [bank.easy[1]] }), 'hard');
});

test('paper selection respects remaining marking reservations from earlier recordings', () => {
  const free = Array.from({ length: 8 }, (_, i) => ({ id: `free-${i}`, type: 'free', q: `Written question ${i}` }));
  assert.equal(chooseDemoDifficulty({ easy: free, medium: [bank.easy[1]], hard: [] }, 7), 'medium');
  assert.throws(() => chooseDemoDifficulty(bank, 0), /no_marking_budget/);
  assert.throws(() => chooseDemoDifficulty(bank, 9), /no_marking_budget/);
});

test('checkpoint accepts fixed five-hour window but still caps review wait at ten minutes', async () => {
  const raw = JSON.stringify(plan);
  const args = { now: () => 1000, fetchFn: async () => new Response(raw, { status: 200 }) };
  assert.equal((await waitForAnswerPlan(snapshot, { ...args, expiresAt: 1000 + 18000000 })).length, 2);
  await assert.rejects(waitForAnswerPlan(snapshot, { ...args, expiresAt: 1001 + 18000000 }), /expiry_or_wait/);
  await assert.rejects(waitForAnswerPlan(snapshot, { ...args, expiresAt: 1000 + 18000000, maxWaitMs: 600001 }), /expiry_or_wait/);
});
