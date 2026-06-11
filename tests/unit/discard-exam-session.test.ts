import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionData } from '@/lib/auth';

const TMP = path.join(process.cwd(), 'tests', '.tmp');
const DB_PATH = path.join(TMP, `discard-exam-session-${process.pid}.db`);

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

async function seedSession(userId: number) {
  const { saveExamSession } = await import('@/lib/exam-session');
  saveExamSession(userId, {
    subject: 'maths',
    difficulty: 'easy',
    questionIds: ['maths-easy-1'],
    answers: [null],
    currentIndex: 0,
  });
}

describe('discardExamSession action', () => {
  it('clears the matching draft for a signed-in student', async () => {
    const { discardExamSession } = await import('@/actions/discardExamSession');
    const { getExamSessions } = await import('@/lib/exam-session');
    const userId = await seedUser('alex@example.com');
    await seedSession(userId);
    sessionHolder.current = { userId, role: 'student', email: 'alex@example.com' };

    const res = await discardExamSession({ subject: 'maths', difficulty: 'easy' });
    expect(res).toEqual({ ok: true });
    expect(getExamSessions(userId)).toHaveLength(0);
  });

  it('forbids a parent NOT in student mode and leaves the draft intact', async () => {
    const { discardExamSession } = await import('@/actions/discardExamSession');
    const { getExamSessions } = await import('@/lib/exam-session');
    const userId = await seedUser('pat@example.com');
    await seedSession(userId);
    sessionHolder.current = { userId, role: 'parent', email: 'pat@example.com' };

    const res = await discardExamSession({ subject: 'maths', difficulty: 'easy' });
    expect(res).toEqual({ ok: false, reason: 'forbidden' });
    expect(getExamSessions(userId)).toHaveLength(1);
  });

  it('forbids an anonymous caller', async () => {
    const { discardExamSession } = await import('@/actions/discardExamSession');
    sessionHolder.current = {};
    expect(await discardExamSession({ subject: 'maths', difficulty: 'easy' })).toEqual({
      ok: false,
      reason: 'forbidden',
    });
  });
});
