import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionData } from '@/lib/auth';
import type { AttemptInput } from '@/lib/exam/attempts';
import { ANSWER_KEYS } from '@/lib/exam/answer-keys.server';
import { QUESTIONS } from '@/lib/exam/data';

const TMP = path.join(process.cwd(), 'tests', '.tmp');
const DB_PATH = path.join(TMP, `record-attempt-${process.pid}.db`);

// Controllable session, swapped per test. `@/lib/auth` is mocked so the action
// never touches next/headers cookies during a unit run.
const sessionHolder = vi.hoisted(() => ({ current: {} as SessionData }));

vi.mock('@/lib/auth', () => ({
  getSession: async () => sessionHolder.current,
}));

beforeAll(() => {
  fs.mkdirSync(TMP, { recursive: true });
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  Reflect.set(process.env, 'DATABASE_URL', `file:${DB_PATH}`);
  const sqlite = new Database(DB_PATH);
  sqlite.pragma('journal_mode = WAL');
  migrate(drizzle(sqlite), {
    migrationsFolder: path.join(process.cwd(), 'src', 'lib', 'db', 'migrations'),
  });
  sqlite.close();
});

afterAll(() => {
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
});

beforeEach(async () => {
  const { db, schema } = await import('@/lib/db');
  db.delete(schema.examSessions).run();
  db.delete(schema.examAttempts).run();
  db.delete(schema.users).run();
  sessionHolder.current = {};
});

async function seedUser(email: string): Promise<number> {
  const { db, schema } = await import('@/lib/db');
  const row = db
    .insert(schema.users)
    .values({ email, emailVerifiedAt: new Date() })
    .returning({ id: schema.users.id })
    .get();
  return row!.id;
}

function mathsEasyInput(correctCount: number): AttemptInput {
  const bank = QUESTIONS.maths!.easy!;
  let mcqIndex = 0;
  return {
    subject: 'maths',
    difficulty: 'easy',
    items: bank.map((q) => {
      if (q.type === 'free') {
        return { type: 'free' as const, id: q.id, response: 'A complete worked explanation.' };
      }
      const answer = (ANSWER_KEYS[q.id] as { answer: number }).answer;
      const chosen = mcqIndex < correctCount ? answer : (answer + 1) % q.choices.length;
      mcqIndex += 1;
      return {
        type: 'mcq' as const,
        id: q.id,
        chosen,
      };
    }),
  };
}

/** A geography/medium input that includes a free-text item (graded via the stub). */
function geographyMediumWithFree(): AttemptInput {
  return {
    subject: 'geography',
    difficulty: 'medium',
    items: QUESTIONS.geography!.medium!.map((q) =>
      q.type === 'free'
        ? {
            type: 'free' as const,
            id: q.id,
            response: 'Weather is day-to-day; climate is the long-term pattern.',
          }
        : {
            type: 'mcq' as const,
            id: q.id,
            chosen: (ANSWER_KEYS[q.id] as { answer: number }).answer,
          },
    ),
  };
}

describe('recordAttempt action', () => {
  it('persists for a signed-in student and returns refreshed progress', async () => {
    const { recordAttempt } = await import('@/actions/recordAttempt');
    const userId = await seedUser('alex@example.com');
    sessionHolder.current = { userId, role: 'student', email: 'alex@example.com' };

    const res = await recordAttempt(mathsEasyInput(3));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.scorePct).toBeGreaterThan(0);
    expect(res.attempt.correct).toBe(4);
    expect(res.progress.attempts).toHaveLength(1);
    expect(res.progress.attempts[0]!.correct).toBe(4);
  });

  it('grades a free-text item server-side and persists the verdict', async () => {
    const { recordAttempt } = await import('@/actions/recordAttempt');
    const userId = await seedUser('alex@example.com');
    sessionHolder.current = { userId, role: 'student', email: 'alex@example.com' };

    const res = await recordAttempt(geographyMediumWithFree());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.attempt.correct).toBe(QUESTIONS.geography!.medium!.length);
    const free = res.attempt.items.find((i) => i.type === 'free');
    expect(free).toBeDefined();
    if (!free || free.type !== 'free') return;
    expect(free.status).toBe('graded');
    expect(free.verdict).not.toBeNull();
    expect(free.response).toContain('climate');
  });

  it('forbids a parent NOT in student mode (read-only) and writes nothing', async () => {
    const { recordAttempt } = await import('@/actions/recordAttempt');
    const userId = await seedUser('pat@example.com');
    sessionHolder.current = { userId, role: 'parent', email: 'pat@example.com' };

    const res = await recordAttempt(mathsEasyInput(3));
    expect(res).toEqual({ ok: false, reason: 'forbidden' });

    const { getProgressForUser } = await import('@/lib/progress');
    expect(getProgressForUser(userId).attempts).toHaveLength(0);
  });

  it('lets a parent in student mode record under their OWN id (not the student)', async () => {
    const { recordAttempt } = await import('@/actions/recordAttempt');
    const parentId = await seedUser('pat@example.com');
    const studentId = await seedUser('alex@example.com');
    sessionHolder.current = {
      userId: parentId,
      role: 'parent',
      email: 'pat@example.com',
      studentMode: true,
    };

    const res = await recordAttempt(mathsEasyInput(3));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.progress.attempts).toHaveLength(1);

    const { getProgressForUser } = await import('@/lib/progress');
    // The attempt is the parent's; the student's record is untouched.
    expect(getProgressForUser(parentId).attempts).toHaveLength(1);
    expect(getProgressForUser(studentId).attempts).toHaveLength(0);
  });

  it('forbids an anonymous caller', async () => {
    const { recordAttempt } = await import('@/actions/recordAttempt');
    sessionHolder.current = {};
    const res = await recordAttempt(mathsEasyInput(1));
    expect(res).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('clears the matching in-progress session on a successful finish', async () => {
    const { recordAttempt } = await import('@/actions/recordAttempt');
    const { saveExamSession, getExamSessions } = await import('@/lib/exam-session');
    const userId = await seedUser('alex@example.com');
    sessionHolder.current = { userId, role: 'student', email: 'alex@example.com' };

    // A live draft for maths/easy, plus an unrelated one for geography/medium.
    saveExamSession(userId, {
      subject: 'maths',
      difficulty: 'easy',
      questionIds: ['maths-easy-1'],
      answers: [null],
      currentIndex: 0,
    });
    saveExamSession(userId, {
      subject: 'geography',
      difficulty: 'medium',
      questionIds: ['geography-medium-1'],
      answers: [null],
      currentIndex: 0,
    });

    const res = await recordAttempt(mathsEasyInput(3));
    expect(res.ok).toBe(true);

    // The finished combo's draft is gone; the unrelated one survives.
    const remaining = getExamSessions(userId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.subject).toBe('geography');
  });

  it('rejects malformed input for a student', async () => {
    const { recordAttempt } = await import('@/actions/recordAttempt');
    const userId = await seedUser('alex@example.com');
    sessionHolder.current = { userId, role: 'student', email: 'alex@example.com' };

    const res = await recordAttempt({
      subject: 'maths',
      difficulty: 'easy',
      items: [],
    } as unknown as AttemptInput);
    expect(res).toEqual({ ok: false, reason: 'invalid' });
  });
});
