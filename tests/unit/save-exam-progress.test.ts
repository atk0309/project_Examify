import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionData } from '@/lib/auth';
import type { SaveExamProgressInput } from '@/actions/saveExamProgress';

const TMP = path.join(process.cwd(), 'tests', '.tmp');
const DB_PATH = path.join(TMP, `save-exam-progress-${process.pid}.db`);

const sessionHolder = vi.hoisted(() => ({ current: {} as SessionData }));
vi.mock('@/lib/auth', () => ({ getSession: async () => sessionHolder.current }));

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

const goodInput = (): SaveExamProgressInput => ({
  subject: 'maths',
  difficulty: 'easy',
  questionIds: ['maths-easy-1', 'maths-easy-2'],
  answers: [0, null],
  currentIndex: 0,
});

describe('beginExamSession action (create on start)', () => {
  it('creates a draft for a signed-in student', async () => {
    const { beginExamSession } = await import('@/actions/saveExamProgress');
    const { getExamSessions } = await import('@/lib/exam-session');
    const userId = await seedUser('alex@example.com');
    sessionHolder.current = { userId, role: 'student', email: 'alex@example.com' };

    const res = await beginExamSession(goodInput());
    expect(res).toEqual({ ok: true });
    expect(getExamSessions(userId)).toHaveLength(1);
  });

  it('lets a parent in student mode create under their OWN id', async () => {
    const { beginExamSession } = await import('@/actions/saveExamProgress');
    const { getExamSessions } = await import('@/lib/exam-session');
    const parentId = await seedUser('pat@example.com');
    const studentId = await seedUser('alex@example.com');
    sessionHolder.current = {
      userId: parentId,
      role: 'parent',
      email: 'pat@example.com',
      studentMode: true,
    };

    const res = await beginExamSession(goodInput());
    expect(res).toEqual({ ok: true });
    expect(getExamSessions(parentId)).toHaveLength(1);
    expect(getExamSessions(studentId)).toHaveLength(0);
  });

  it('forbids a parent NOT in student mode (read-only) and writes nothing', async () => {
    const { beginExamSession } = await import('@/actions/saveExamProgress');
    const { getExamSessions } = await import('@/lib/exam-session');
    const userId = await seedUser('pat@example.com');
    sessionHolder.current = { userId, role: 'parent', email: 'pat@example.com' };

    expect(await beginExamSession(goodInput())).toEqual({ ok: false, reason: 'forbidden' });
    expect(getExamSessions(userId)).toHaveLength(0);
  });

  it('forbids an anonymous caller', async () => {
    const { beginExamSession } = await import('@/actions/saveExamProgress');
    sessionHolder.current = {};
    expect(await beginExamSession(goodInput())).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('rejects a desynced answers/questionIds length', async () => {
    const { beginExamSession } = await import('@/actions/saveExamProgress');
    const userId = await seedUser('alex@example.com');
    sessionHolder.current = { userId, role: 'student', email: 'alex@example.com' };

    expect(await beginExamSession({ ...goodInput(), answers: [0] })).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('rejects an over-long free-text answer', async () => {
    const { beginExamSession } = await import('@/actions/saveExamProgress');
    const userId = await seedUser('alex@example.com');
    sessionHolder.current = { userId, role: 'student', email: 'alex@example.com' };

    const res = await beginExamSession({
      subject: 'maths',
      difficulty: 'easy',
      questionIds: ['maths-easy-1'],
      answers: ['x'.repeat(4001)],
      currentIndex: 0,
    });
    expect(res).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('saveExamProgress action (update-only autosave)', () => {
  it('checkpoints an existing draft', async () => {
    const { beginExamSession, saveExamProgress } = await import('@/actions/saveExamProgress');
    const { getExamSessions } = await import('@/lib/exam-session');
    const userId = await seedUser('alex@example.com');
    sessionHolder.current = { userId, role: 'student', email: 'alex@example.com' };

    await beginExamSession(goodInput());
    const res = await saveExamProgress({ ...goodInput(), answers: [1, 2], currentIndex: 1 });
    expect(res).toEqual({ ok: true });
    const sessions = getExamSessions(userId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.currentIndex).toBe(1);
    expect(sessions[0]!.answers).toEqual([1, 2]);
  });

  it('does NOT recreate a cleared draft (a late autosave after finish/discard is a no-op)', async () => {
    const { saveExamProgress } = await import('@/actions/saveExamProgress');
    const { getExamSessions } = await import('@/lib/exam-session');
    const userId = await seedUser('alex@example.com');
    sessionHolder.current = { userId, role: 'student', email: 'alex@example.com' };

    // No draft exists (e.g. it was just finished/discarded). The autosave still
    // returns ok, but must not resurrect the row.
    const res = await saveExamProgress(goodInput());
    expect(res).toEqual({ ok: true });
    expect(getExamSessions(userId)).toHaveLength(0);
  });

  it('forbids a parent NOT in student mode and an anonymous caller', async () => {
    const { saveExamProgress } = await import('@/actions/saveExamProgress');
    const userId = await seedUser('pat@example.com');
    sessionHolder.current = { userId, role: 'parent', email: 'pat@example.com' };
    expect(await saveExamProgress(goodInput())).toEqual({ ok: false, reason: 'forbidden' });

    sessionHolder.current = {};
    expect(await saveExamProgress(goodInput())).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('rejects malformed input', async () => {
    const { saveExamProgress } = await import('@/actions/saveExamProgress');
    const userId = await seedUser('alex@example.com');
    sessionHolder.current = { userId, role: 'student', email: 'alex@example.com' };
    expect(await saveExamProgress({ ...goodInput(), answers: [0] })).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });
});
