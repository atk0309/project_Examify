import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AttemptInput } from '@/lib/exam/attempts';
import { ANSWER_KEYS } from '@/lib/exam/answer-keys.server';
import { QUESTIONS } from '@/lib/exam/data';

const TMP = path.join(process.cwd(), 'tests', '.tmp');
const DB_PATH = path.join(TMP, `progress-${process.pid}.db`);
Reflect.set(process.env, 'DATABASE_URL', `file:${DB_PATH}`);
delete process.env.FAMILIES;

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
  db.delete(schema.examAttempts).run();
  db.delete(schema.householdMembers).run();
  db.delete(schema.households).run();
  db.delete(schema.users).run();
});

/** Insert a user row and return its id. */
async function seedUser(email: string): Promise<number> {
  const { db, schema } = await import('@/lib/db');
  const row = db
    .insert(schema.users)
    .values({ email, emailVerifiedAt: new Date() })
    .returning({ id: schema.users.id })
    .get();
  return row!.id;
}

/** Two isolated households matching the old FAMILIES fixture. */
async function seedHouseholds(): Promise<void> {
  const { db, schema } = await import('@/lib/db');
  const ours = db.insert(schema.households).values({ name: 'Alex family' }).returning().get()!;
  const theirs = db.insert(schema.households).values({ name: 'Sam family' }).returning().get()!;
  const standalone = db.insert(schema.households).values({ name: 'Jess alone' }).returning().get()!;

  const member = async (
    email: string,
    householdId: number,
    role: 'admin' | 'parent' | 'student',
  ) => {
    const userId = await seedUser(email);
    db.insert(schema.householdMembers).values({ householdId, userId, role }).run();
    return userId;
  };

  await member('alex@example.com', ours.id, 'student');
  await member('pat@example.com', ours.id, 'admin');
  await member('morgan@example.com', ours.id, 'parent');
  await member('jess@example.com', standalone.id, 'student');
  await member('sam@example.com', theirs.id, 'student');
  await member('stranger@example.com', theirs.id, 'parent');
}

/** Complete maths/easy paper, choosing `correctCount` MCQs right. */
function mathsEasyItems(correctCount: number): AttemptInput['items'] {
  const bank = QUESTIONS.maths!.easy!;
  let mcqIndex = 0;
  return bank.map((q) => {
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
  });
}

describe('saveAttempt + getProgressForUser', () => {
  it('persists a validated attempt with a server-derived score', async () => {
    const { saveAttempt, getProgressForUser } = await import('@/lib/progress');
    const userId = await seedUser('alex@example.com');

    const result = await saveAttempt(userId, {
      subject: 'maths',
      difficulty: 'easy',
      items: mathsEasyItems(2),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Two MCQs + the deterministic full-score free-text stub.
      expect(result.attempt.correct).toBe(3);
    }

    const progress = getProgressForUser(userId);
    expect(progress.attempts).toHaveLength(1);
    const attempt = progress.attempts[0]!;
    expect(attempt.subject).toBe('maths');
    expect(attempt.correct).toBe(3);
    expect(attempt.items.length).toBeGreaterThan(0);
    expect(progress.subjects.find((s) => s.subjectId === 'maths')?.best).toBe(attempt.scorePct);
  });

  it('rejects an invalid attempt and writes nothing', async () => {
    const { saveAttempt, getProgressForUser } = await import('@/lib/progress');
    const userId = await seedUser('alex@example.com');

    const result = await saveAttempt(userId, {
      subject: 'not-a-subject',
      difficulty: 'easy',
      items: mathsEasyItems(1),
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_subject' });
    expect(getProgressForUser(userId).attempts).toHaveLength(0);
  });

  it('scopes progress to the owning user', async () => {
    const { saveAttempt, getProgressForUser } = await import('@/lib/progress');
    const alex = await seedUser('alex@example.com');
    const other = await seedUser('someone@example.com');
    await saveAttempt(alex, { subject: 'maths', difficulty: 'easy', items: mathsEasyItems(1) });

    expect(getProgressForUser(alex).attempts).toHaveLength(1);
    expect(getProgressForUser(other).attempts).toHaveLength(0);
  });
});

describe('getScoreHistory', () => {
  it('returns the full chronological (oldest-first) score series, scoped to the user', async () => {
    const { saveAttempt, getScoreHistory } = await import('@/lib/progress');
    const alex = await seedUser('alex@example.com');
    const other = await seedUser('someone@example.com');

    // Three attempts with increasing correct counts → increasing scores.
    await saveAttempt(alex, { subject: 'maths', difficulty: 'easy', items: mathsEasyItems(1) });
    await saveAttempt(alex, { subject: 'maths', difficulty: 'easy', items: mathsEasyItems(2) });
    await saveAttempt(alex, { subject: 'maths', difficulty: 'easy', items: mathsEasyItems(3) });
    await saveAttempt(other, { subject: 'maths', difficulty: 'easy', items: mathsEasyItems(1) });

    const history = getScoreHistory(alex);
    expect(history).toHaveLength(3);
    // Oldest-first and strictly increasing, matching insertion order.
    expect(history[0]!).toBeLessThan(history[1]!);
    expect(history[1]!).toBeLessThan(history[2]!);
    // Other user's attempt is excluded.
    expect(getScoreHistory(other)).toHaveLength(1);
  });

  it('is uncapped — returns more than the 50-attempt progress cap', async () => {
    const { saveAttempt, getScoreHistory, getProgressForUser } = await import('@/lib/progress');
    const alex = await seedUser('alex@example.com');
    for (let i = 0; i < 55; i++) {
      await saveAttempt(alex, { subject: 'maths', difficulty: 'easy', items: mathsEasyItems(1) });
    }
    expect(getScoreHistory(alex)).toHaveLength(55);
    // getProgressForUser stays capped at 50.
    expect(getProgressForUser(alex).attempts).toHaveLength(50);
  });

  it('is empty for a user with no attempts', async () => {
    const { getScoreHistory } = await import('@/lib/progress');
    const alex = await seedUser('alex@example.com');
    expect(getScoreHistory(alex)).toEqual([]);
  });
});

async function userId(email: string): Promise<number> {
  const { db, schema } = await import('@/lib/db');
  const row = db
    .select()
    .from(schema.users)
    .all()
    .find((u) => u.email === email);
  if (!row) throw new Error(`missing user ${email}`);
  return row.id;
}

describe('resolveChildren (per-household isolation)', () => {
  it('resolves the parent’s own child who has signed in', async () => {
    const { resolveChildren } = await import('@/lib/progress');
    await seedHouseholds();
    const alex = await userId('alex@example.com');

    const children = resolveChildren('pat@example.com');
    expect(children).toHaveLength(1);
    expect(children[0]!.id).toBe(alex);
    expect(children[0]!.label).toBe('Alex');
  });

  it('resolves the same child for the second parent in the household (parent pair)', async () => {
    const { resolveChildren } = await import('@/lib/progress');
    await seedHouseholds();
    const alex = await userId('alex@example.com');

    const children = resolveChildren('morgan@example.com');
    expect(children).toHaveLength(1);
    expect(children[0]!.id).toBe(alex);
  });

  it('returns nothing for a parent in another household (no cross-household visibility)', async () => {
    const { resolveChildren } = await import('@/lib/progress');
    await seedHouseholds();
    const children = resolveChildren('stranger@example.com');
    expect(children).toHaveLength(1);
    expect(children[0]!.email).toBe('sam@example.com');
  });

  it('never surfaces a standalone child to another household', async () => {
    const { resolveChildren } = await import('@/lib/progress');
    await seedHouseholds();
    expect(resolveChildren('pat@example.com').some((c) => c.email === 'jess@example.com')).toBe(
      false,
    );
    expect(resolveChildren('jess@example.com')).toEqual([]);
  });

  it('returns nothing when the parent’s household has no student yet', async () => {
    const { resolveChildren } = await import('@/lib/progress');
    const { bootstrapHousehold } = await import('@/lib/households');
    bootstrapHousehold({ email: 'pat@example.com', householdName: 'Ours' });
    expect(resolveChildren('pat@example.com')).toEqual([]);
  });

  it('preserves existing child progress across household membership', async () => {
    const { saveAttempt, getProgressForUser, resolveChildren } = await import('@/lib/progress');
    await seedHouseholds();
    const alex = await userId('alex@example.com');

    await saveAttempt(alex, { subject: 'maths', difficulty: 'easy', items: mathsEasyItems(2) });

    const children = resolveChildren('pat@example.com');
    expect(children).toHaveLength(1);
    expect(children[0]!.id).toBe(alex);
    expect(getProgressForUser(children[0]!.id).attempts).toHaveLength(1);
  });
});
