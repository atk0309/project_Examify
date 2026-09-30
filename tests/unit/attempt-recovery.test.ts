import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GradeArgs, GradeResult } from '@/lib/grading';
import type { RecordAttemptInput } from '@/actions/recordAttempt';
import type { SessionData } from '@/lib/auth';
import { QUESTIONS } from '@/lib/exam/data';
import { ANSWER_KEYS } from '@/lib/exam/answer-keys.server';

const state = vi.hoisted(() => ({
  grade: vi.fn<(tasks: readonly GradeArgs[]) => Promise<GradeResult[]>>(),
  session: {} as SessionData,
}));
vi.mock('@/lib/grading', () => ({ gradeAnswers: state.grade }));
vi.mock('@/lib/auth', () => ({ getSession: async () => state.session }));
const DB_PATH = path.join(process.cwd(), 'tests', '.tmp', `attempt-recovery-${process.pid}.db`);

beforeAll(() => {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.rmSync(DB_PATH, { force: true });
  process.env.DATABASE_URL = `file:${DB_PATH}`;
  const sqlite = new Database(DB_PATH);
  migrate(drizzle(sqlite), { migrationsFolder: path.join(process.cwd(), 'src/lib/db/migrations') });
  sqlite.close();
});
afterAll(() => fs.rmSync(DB_PATH, { force: true }));
beforeEach(async () => {
  const { db, schema } = await import('@/lib/db');
  db.delete(schema.examSessions).run();
  db.delete(schema.examAttempts).run();
  db.delete(schema.users).run();
  const user = db.insert(schema.users).values({ email: 'student@example.com' }).returning().get();
  state.session = { userId: user.id, role: 'student', email: user.email };
  state.grade
    .mockReset()
    .mockImplementation(async (tasks) => tasks.map(() => ({ status: 'needs_review' })));
});

function input(): RecordAttemptInput {
  return {
    submissionId: randomUUID(),
    subject: 'geography',
    difficulty: 'medium',
    items: QUESTIONS.geography!.medium!.map((q) =>
      q.type === 'free'
        ? { type: 'free', id: q.id, response: 'A considered answer about climate.' }
        : { type: 'mcq', id: q.id, chosen: (ANSWER_KEYS[q.id] as { answer: number }).answer },
    ),
  };
}
function success(tasks: readonly GradeArgs[]): GradeResult[] {
  return tasks.map((task) => ({
    status: 'graded',
    verdict: {
      score: task.maxScore,
      verdict: 'Correct',
      gotRight: [],
      toReview: [],
      spelling: [],
    },
  }));
}

describe('durable attempt submission and recovery', () => {
  it('saves answers before provider work, deduplicates concurrent/repeated submits and binds IDs to payloads', async () => {
    const { recordAttempt } = await import('@/actions/recordAttempt');
    const { db, schema } = await import('@/lib/db');
    let release!: (results: GradeResult[]) => void;
    state.grade.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const payload = input();
    const { saveExamSession } = await import('@/lib/exam-session');
    saveExamSession(state.session.userId!, {
      submissionId: payload.submissionId,
      subject: payload.subject,
      difficulty: 'medium',
      questionIds: payload.items.map((item) => item.id),
      answers: payload.items.map((item) => (item.type === 'free' ? item.response : item.chosen)),
      currentIndex: 0,
    });
    const first = recordAttempt(payload);
    await vi.waitFor(() => expect(state.grade).toHaveBeenCalledTimes(1));
    expect(db.select().from(schema.examAttempts).all()).toHaveLength(1);
    expect(db.select().from(schema.examSessions).all()).toHaveLength(0);
    const replay = await recordAttempt(payload);
    expect(replay.ok).toBe(true);
    expect(state.grade).toHaveBeenCalledTimes(1);
    const changed = structuredClone(payload);
    changed.items.find((item) => item.type === 'free')!.response = 'Different';
    expect(await recordAttempt(changed)).toEqual({ ok: false, reason: 'invalid' });
    release(success(state.grade.mock.calls[0]![0]));
    const finished = await first;
    expect(finished.ok).toBe(true);
    expect(await recordAttempt(payload)).toEqual(finished);
    expect(state.grade).toHaveBeenCalledTimes(1);
    expect(db.select().from(schema.examAttempts).all()).toHaveLength(1);
  });

  it('keeps unmarked answers out of the denominator and incomplete attempts out of aggregates', async () => {
    const { recordAttempt } = await import('@/actions/recordAttempt');
    const { getScoreHistory } = await import('@/lib/progress');
    const result = await recordAttempt(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempt.scorePct).toBe(100);
    expect(result.attempt.correct).toBeLessThan(result.attempt.total);
    expect(result.attempt.canRetryGrading).toBe(true);
    expect(result.progress.subjects).toEqual([]);
    expect(getScoreHistory(state.session.userId!)).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('rubric');
    expect(JSON.stringify(result)).not.toContain('gradingTasks');
  });

  it('retries only unmarked answers using the original rubric and updates the same row', async () => {
    const { recordAttempt } = await import('@/actions/recordAttempt');
    const { retryAttemptGrading } = await import('@/actions/retryAttemptGrading');
    const { getScoreHistory } = await import('@/lib/progress');
    const { db, schema } = await import('@/lib/db');
    const result = await recordAttempt(input());
    if (!result.ok) throw new Error('Expected saved attempt');
    const originalTasks = structuredClone(state.grade.mock.calls[0]![0]);
    state.grade.mockImplementation(async (tasks) => success(tasks));
    const recovered = await retryAttemptGrading(result.attempt.id);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(state.grade.mock.calls[1]![0]).toEqual(originalTasks);
    expect(recovered.attempt.id).toBe(result.attempt.id);
    expect(recovered.attempt.createdAt).toBe(result.attempt.createdAt);
    expect(recovered.attempt.canRetryGrading).toBe(false);
    expect(recovered.progress.subjects[0]?.average).toBe(100);
    expect(getScoreHistory(state.session.userId!)).toEqual([100]);
    expect(db.select().from(schema.examAttempts).all()).toHaveLength(1);
    await retryAttemptGrading(result.attempt.id);
    expect(state.grade).toHaveBeenCalledTimes(2);
  });

  it('serializes recovery, allows an abandoned lease to expire, and rejects other users', async () => {
    const { recordAttempt } = await import('@/actions/recordAttempt');
    const { retryAttemptGrading } = await import('@/actions/retryAttemptGrading');
    const { db, schema } = await import('@/lib/db');
    const saved = await recordAttempt(input());
    if (!saved.ok) throw new Error('Expected saved attempt');
    db.update(schema.examAttempts)
      .set({ gradingLease: 'crashed', gradingLeaseUntil: Date.now() + 10000 })
      .where(eq(schema.examAttempts.id, saved.attempt.id))
      .run();
    expect(await retryAttemptGrading(saved.attempt.id)).toEqual({ ok: false, reason: 'busy' });
    expect(state.grade).toHaveBeenCalledTimes(1);
    db.update(schema.examAttempts)
      .set({ gradingLeaseUntil: Date.now() - 1 })
      .where(eq(schema.examAttempts.id, saved.attempt.id))
      .run();
    state.grade.mockImplementation(async (tasks) => success(tasks));
    expect((await retryAttemptGrading(saved.attempt.id)).ok).toBe(true);
    const other = db.insert(schema.users).values({ email: 'other@example.com' }).returning().get();
    state.session.userId = other.id;
    expect(await retryAttemptGrading(saved.attempt.id)).toEqual({ ok: false, reason: 'invalid' });
    state.session.role = 'parent';
    expect(await retryAttemptGrading(saved.attempt.id)).toEqual({ ok: false, reason: 'forbidden' });
    expect(state.grade).toHaveBeenCalledTimes(2);
  });

  it('preserves durable answers if marking unexpectedly rejects', async () => {
    const { recordAttempt } = await import('@/actions/recordAttempt');
    state.grade.mockRejectedValueOnce(new Error('provider failed'));
    const saved = await recordAttempt(input());
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.attempt.canRetryGrading).toBe(true);
    expect(
      saved.attempt.items.some((item) => item.type === 'free' && item.response.includes('climate')),
    ).toBe(true);
  });
  it('recovery never regrades an already marked item and concurrent retries invoke one provider', async () => {
    const { db, schema } = await import('@/lib/db');
    const { retryAttemptGrading } = await import('@/actions/retryAttemptGrading');
    const verdict = {
      score: 1,
      verdict: 'Earlier verdict',
      gotRight: [],
      toReview: [],
      spelling: [],
    };
    const row = db
      .insert(schema.examAttempts)
      .values({
        userId: state.session.userId!,
        subject: 'geography',
        difficulty: 'medium',
        total: 2,
        correct: 1,
        scorePct: 100,
        items: [
          {
            type: 'free',
            id: 'first',
            q: 'Original question',
            response: 'Earlier response',
            maxScore: 1,
            score: 1,
            status: 'graded',
            verdict,
          },
          {
            type: 'free',
            id: 'second',
            q: 'Removed question',
            response: 'Original response',
            maxScore: 2,
            score: null,
            status: 'needs_review',
            verdict: null,
          },
        ],
        gradingTasks: [
          {
            index: 0,
            question: 'Original question',
            studentAnswer: 'Earlier response',
            maxScore: 1,
            rubric: 'Original rubric one',
          },
          {
            index: 1,
            question: 'Removed question',
            studentAnswer: 'Original response',
            maxScore: 2,
            rubric: 'Original rubric two',
          },
        ],
      })
      .returning()
      .get();
    let release!: (results: GradeResult[]) => void;
    state.grade.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = retryAttemptGrading(row.id);
    await vi.waitFor(() => expect(state.grade).toHaveBeenCalledTimes(1));
    expect(state.grade.mock.calls[0]![0]).toEqual([row.gradingTasks![1]]);
    expect(await retryAttemptGrading(row.id)).toEqual({ ok: false, reason: 'busy' });
    release(success(state.grade.mock.calls[0]![0]));
    const result = await first;
    if (!result.ok) throw new Error('Expected recovered attempt');
    expect(result.attempt.items[0]).toEqual(row.items[0]);
    expect(result.attempt.correct).toBe(2);
    expect(state.grade).toHaveBeenCalledTimes(1);
  });

  it('a stale worker cannot overwrite a newer lease result', async () => {
    const { recordAttempt } = await import('@/actions/recordAttempt');
    const { db, schema } = await import('@/lib/db');
    let release!: (results: GradeResult[]) => void;
    state.grade.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const submitted = recordAttempt(input());
    await vi.waitFor(() => expect(state.grade).toHaveBeenCalledTimes(1));
    const row = db.select().from(schema.examAttempts).get()!;
    db.update(schema.examAttempts)
      .set({ gradingLease: 'newer-worker', gradingLeaseUntil: Date.now() + 10000 })
      .where(eq(schema.examAttempts.id, row.id))
      .run();
    release(success(state.grade.mock.calls[0]![0]));
    await submitted;
    const after = db.select().from(schema.examAttempts).get()!;
    expect(after.items).toEqual(row.items);
    expect(after.gradingLease).toBe('newer-worker');
  });
});
