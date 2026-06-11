import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ExamSessionInput } from '@/lib/exam-session';

const TMP = path.join(process.cwd(), 'tests', '.tmp');
const DB_PATH = path.join(TMP, `exam-session-${process.pid}.db`);

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

const draft = (over: Partial<ExamSessionInput> = {}): ExamSessionInput => ({
  subject: 'maths',
  difficulty: 'easy',
  questionIds: ['maths-easy-1', 'maths-easy-2', 'maths-easy-3'],
  answers: [0, 'a free answer', null],
  currentIndex: 1,
  ...over,
});

describe('saveExamSession + getExamSessions', () => {
  it('round-trips a draft for a user', async () => {
    const { saveExamSession, getExamSessions } = await import('@/lib/exam-session');
    const userId = await seedUser('alex@example.com');

    saveExamSession(userId, draft());
    const sessions = getExamSessions(userId);

    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.subject).toBe('maths');
    expect(s.difficulty).toBe('easy');
    expect(s.questionIds).toEqual(['maths-easy-1', 'maths-easy-2', 'maths-easy-3']);
    expect(s.answers).toEqual([0, 'a free answer', null]);
    expect(s.currentIndex).toBe(1);
    expect(typeof s.startedAt).toBe('number');
    expect(typeof s.updatedAt).toBe('number');
  });

  it('replaces (upserts) the row for the same subject+difficulty', async () => {
    const { saveExamSession, getExamSessions } = await import('@/lib/exam-session');
    const userId = await seedUser('alex@example.com');

    saveExamSession(userId, draft({ currentIndex: 0, answers: [null, null, null] }));
    saveExamSession(userId, draft({ currentIndex: 2, answers: [1, 'changed', 2] }));

    const sessions = getExamSessions(userId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.currentIndex).toBe(2);
    expect(sessions[0]!.answers).toEqual([1, 'changed', 2]);
  });

  it('keeps a separate row per difficulty (one per subject+difficulty)', async () => {
    const { saveExamSession, getExamSessions } = await import('@/lib/exam-session');
    const userId = await seedUser('alex@example.com');

    saveExamSession(userId, draft({ difficulty: 'easy' }));
    saveExamSession(userId, draft({ difficulty: 'hard' }));

    const sessions = getExamSessions(userId);
    expect(sessions).toHaveLength(2);
    expect(new Set(sessions.map((s) => s.difficulty))).toEqual(new Set(['easy', 'hard']));
  });

  it('scopes sessions to the owning user', async () => {
    const { saveExamSession, getExamSessions } = await import('@/lib/exam-session');
    const alex = await seedUser('alex@example.com');
    const other = await seedUser('someone@example.com');

    saveExamSession(alex, draft());
    expect(getExamSessions(alex)).toHaveLength(1);
    expect(getExamSessions(other)).toHaveLength(0);
  });
});

describe('updateExamSession (update-only autosave)', () => {
  it('updates an existing draft and reports a row was changed', async () => {
    const { saveExamSession, updateExamSession, getExamSessions } =
      await import('@/lib/exam-session');
    const userId = await seedUser('alex@example.com');
    saveExamSession(userId, draft({ currentIndex: 0, answers: [null, null, null] }));

    const changed = updateExamSession(userId, draft({ currentIndex: 2, answers: [1, 'x', 2] }));
    expect(changed).toBe(true);

    const sessions = getExamSessions(userId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.currentIndex).toBe(2);
    expect(sessions[0]!.answers).toEqual([1, 'x', 2]);
  });

  it('does NOT recreate a row that does not exist (a late save after a clear is a no-op)', async () => {
    const { updateExamSession, getExamSessions } = await import('@/lib/exam-session');
    const userId = await seedUser('alex@example.com');

    const changed = updateExamSession(userId, draft());
    expect(changed).toBe(false);
    expect(getExamSessions(userId)).toHaveLength(0);
  });
});

describe('clearExamSession', () => {
  it('removes only the matching (user, subject, difficulty) and is idempotent', async () => {
    const { saveExamSession, getExamSessions, clearExamSession } =
      await import('@/lib/exam-session');
    const userId = await seedUser('alex@example.com');
    saveExamSession(userId, draft({ difficulty: 'easy' }));
    saveExamSession(userId, draft({ difficulty: 'hard' }));

    clearExamSession(userId, 'maths', 'easy');
    let sessions = getExamSessions(userId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.difficulty).toBe('hard');

    // Idempotent — clearing again (already gone) is a no-op.
    clearExamSession(userId, 'maths', 'easy');
    sessions = getExamSessions(userId);
    expect(sessions).toHaveLength(1);
  });
});
