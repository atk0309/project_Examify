// Public synthetic questions and answer DATA only. No keys/rubrics, eval, imports,
// subprocesses, provider calls, or changing the active runner's checked-out code.
import { createHash } from 'node:crypto';
function object(value, fields, reason) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !fields.includes(k))
  )
    throw Error(reason);
}
function text(value, max, reason) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) throw Error(reason);
  return value;
}
function runId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,20}$/.test(value)) throw Error('checkpoint_run_id');
  return value;
}
export function publicQuestions(bank, difficulty = 'easy') {
  if (!['easy', 'medium', 'hard'].includes(difficulty)) throw Error('checkpoint_difficulty');
  object(bank, ['easy', 'medium', 'hard'], 'checkpoint_not_public_bank');
  if (!Array.isArray(bank[difficulty]) || bank[difficulty].length < 1 || bank[difficulty].length > 20)
    throw Error('checkpoint_question_count');
  const seen = new Set();
  return bank[difficulty].map((q) => {
    object(q, ['id', 'type', 'q', 'choices'], 'checkpoint_private_or_unknown_question_field');
    const id = text(q.id, 100, 'checkpoint_question_id');
    if (seen.has(id)) throw Error('checkpoint_duplicate_question');
    seen.add(id);
    const question = { id, type: q.type, q: text(q.q, 2000, 'checkpoint_question_text') };
    if (q.type === 'free') {
      if (q.choices !== undefined) throw Error('checkpoint_free_choices');
      return question;
    }
    if (q.type !== 'mcq' || !Array.isArray(q.choices) || q.choices.length !== 4)
      throw Error('checkpoint_question_type');
    const choices = q.choices.map((c) => text(c, 1000, 'checkpoint_choice_text'));
    if (new Set(choices).size !== 4) throw Error('checkpoint_duplicate_choice');
    return { ...question, choices };
  });
}
export function chooseDemoDifficulty(bank, maxWritten = 8) {
  if (!Number.isSafeInteger(maxWritten) || maxWritten < 1 || maxWritten > 8) throw Error('demo_no_marking_budget');
  object(bank, ['easy', 'medium', 'hard'], 'checkpoint_not_public_bank');
  for (const difficulty of ['easy', 'medium', 'hard']) {
    if (!Array.isArray(bank[difficulty]) || bank[difficulty].length === 0 || bank[difficulty].length > 12) continue;
    const questions = publicQuestions(bank, difficulty);
    const written = questions.filter(q => q.type === 'free').length;
    const signatures = questions.map(q => JSON.stringify([q.type, q.q, [...(q.choices ?? [])].sort()]));
    if (new Set(signatures).size === questions.length && written >= 1 && written <= maxWritten) return difficulty;
  }
  throw Error('demo_no_bounded_written_paper');
}
export function makeSnapshot({ bank, run, sourceNotes, difficulty = 'easy' }) {
  const questions = publicQuestions(bank, difficulty);
  return {
    schemaVersion: 1,
    difficulty,
    runId: runId(run),
    questionHash: createHash('sha256').update(JSON.stringify(questions)).digest('hex'),
    sourceNotes: text(sourceNotes, 10000, 'checkpoint_notes'),
    questions,
  };
}
export function parseAnswerPlan(raw, snapshot) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 32768)
    throw Error('checkpoint_plan_size');
  let plan;
  try {
    plan = JSON.parse(raw);
  } catch {
    throw Error('checkpoint_plan_json');
  }
  object(plan, ['schemaVersion', 'runId', 'questionHash', 'answers'], 'checkpoint_plan_fields');
  if (
    plan.schemaVersion !== 1 ||
    plan.runId !== snapshot.runId ||
    plan.questionHash !== snapshot.questionHash
  )
    throw Error('checkpoint_stale_plan');
  if (!Array.isArray(plan.answers) || plan.answers.length !== snapshot.questions.length)
    throw Error('checkpoint_answer_count');
  const questions = new Map(snapshot.questions.map((q) => [q.id, q]));
  const seen = new Set();
  const answers = plan.answers.map((answer) => {
    object(answer, ['id', 'type', 'chosenText', 'response'], 'checkpoint_answer_fields');
    const q = questions.get(answer.id);
    if (!q || seen.has(answer.id) || answer.type !== q.type)
      throw Error('checkpoint_answer_identity');
    seen.add(answer.id);
    if (q.type === 'mcq') {
      if (answer.response !== undefined || !q.choices.includes(answer.chosenText))
        throw Error('checkpoint_choice_mismatch');
      return { id: q.id, type: 'mcq', chosenText: answer.chosenText };
    }
    if (answer.chosenText !== undefined) throw Error('checkpoint_free_choice');
    return { id: q.id, type: 'free', response: text(answer.response, 800, 'checkpoint_response') };
  });
  return answers;
}
export function findAnswer(snapshot, answers, { question, choices = [] }) {
  const matches = snapshot.questions.filter(
    (q) =>
      q.q === question &&
      (q.type === 'free'
        ? choices.length === 0
        : JSON.stringify([...q.choices].sort()) === JSON.stringify([...choices].sort())),
  );
  if (matches.length !== 1) throw Error('checkpoint_visible_question_mismatch');
  const answer = answers.find((a) => a.id === matches[0].id);
  if (!answer) throw Error('checkpoint_missing_answer');
  return answer;
}
export function answerUrl(snapshot, poll) {
  runId(snapshot.runId);
  if (!Number.isSafeInteger(poll) || poll < 0 || poll > 100) throw Error('checkpoint_poll_count');
  return `https://raw.githubusercontent.com/atk0309/project_Examify/dot/examify-recording/demo-recording/answers/${snapshot.runId}.json?poll=${poll}`;
}
async function boundedText(response) {
  const stated = Number(response.headers.get('content-length'));
  if (Number.isFinite(stated) && stated > 32768) throw Error('checkpoint_plan_size');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 32768) {
        await reader.cancel();
        throw Error('checkpoint_plan_size');
      }
      chunks.push(Buffer.from(part.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}
export async function waitForAnswerPlan(
  snapshot,
  {
    expiresAt,
    fetchFn = fetch,
    now = Date.now,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    maxWaitMs = 600000,
    pollMs = 15000,
  },
) {
  const start = now();
  if (
    !Number.isFinite(expiresAt) ||
    expiresAt <= start ||
    expiresAt - start > 18000000 ||
    !Number.isFinite(maxWaitMs) ||
    maxWaitMs <= 0 ||
    maxWaitMs > 600000 ||
    pollMs < 1000
  )
    throw Error('checkpoint_expiry_or_wait_refused');
  const stop = Math.min(expiresAt, start + maxWaitMs);
  for (let poll = 0; poll < 100; poll++) {
    if (now() >= stop) throw Error('checkpoint_expired_or_timed_out');
    let response;
    try {
      response = await fetchFn(answerUrl(snapshot, poll), {
        method: 'GET',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(Math.max(1, Math.min(10000, stop - now()))),
      });
    } catch {
      throw Error('checkpoint_fetch_failed');
    }
    if (now() >= stop) throw Error('checkpoint_expired_or_timed_out');
    if (response.status === 200) {
      const raw = await boundedText(response);
      if (now() >= stop) throw Error('checkpoint_expired_or_timed_out');
      return parseAnswerPlan(raw, snapshot);
    }
    if (response.status !== 404) throw Error('checkpoint_http_failure');
    await sleep(Math.min(pollMs, Math.max(0, stop - now())));
  }
  throw Error('checkpoint_poll_limit');
}
