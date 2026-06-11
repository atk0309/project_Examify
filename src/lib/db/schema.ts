import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Signed-in people (magic-link auth). There is no admin row and no password —
 * who may sign in (and as which role) is decided by the `FAMILIES` env config
 * (`src/lib/families.ts`): a student is some family's `child`, a parent is in some
 * family's `parents[]`. A `users` row is created on first verified sign-in, keyed
 * by email; ownership of attempts is structural via `users.id`, so the FAMILIES
 * config can change without touching stored progress.
 */
export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    email: text('email').notNull(),
    emailVerifiedAt: integer('email_verified_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [uniqueIndex('users_email_unique').on(t.email)],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export const magicTokens = sqliteTable(
  'magic_tokens',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    email: text('email').notNull(),
    // The role the link was issued for. Carried on the token so the verify
    // step can establish the right session role without re-checking env.
    role: text('role', { enum: ['student', 'parent'] })
      .notNull()
      .default('student'),
    tokenHash: text('token_hash').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    consumedAt: integer('consumed_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    uniqueIndex('magic_tokens_hash_unique').on(t.tokenHash),
    index('magic_tokens_email_idx').on(t.email),
  ],
);

export type MagicToken = typeof magicTokens.$inferSelect;

export const rateLimitEvents = sqliteTable(
  'rate_limit_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ip: text('ip').notNull(),
    kind: text('kind', { enum: ['signin'] }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [index('rate_limit_events_ip_kind_created_idx').on(t.ip, t.kind, t.createdAt)],
);

export type RateLimitEvent = typeof rateLimitEvents.$inferSelect;

/**
 * One row per completed mini exam, owned (via `userId`) by whoever sat it — the
 * student, or a parent who entered student mode. Ownership is always the
 * caller's own id; a parent's attempts never attach to the student.
 *
 * Aggregate columns (`total` / `correct` / `scorePct`) are denormalised so
 * per-subject summaries are cheap SQL without parsing JSON, and are always
 * **re-derived server-side** from `items` — the client's totals are never
 * trusted (see `src/lib/exam/score.server.ts`). `items` is the per-question
 * snapshot taken at attempt time so the review survives later edits to the
 * question bank: for MCQ the question text, choices, chosen + correct index;
 * for free-text the student's response plus the server-graded verdict.
 */
export const examAttempts = sqliteTable(
  'exam_attempts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    subject: text('subject').notNull(),
    difficulty: text('difficulty', { enum: ['easy', 'medium', 'hard'] }).notNull(),
    total: integer('total').notNull(),
    correct: integer('correct').notNull(),
    scorePct: integer('score_pct').notNull(),
    items: text('items', { mode: 'json' }).notNull().$type<AttemptItem[]>(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [index('exam_attempts_user_created_idx').on(t.userId, t.createdAt)],
);

export type ExamAttempt = typeof examAttempts.$inferSelect;
export type NewExamAttempt = typeof examAttempts.$inferInsert;

/**
 * An IN-PROGRESS mini exam, autosaved so a user who reloads, closes the browser
 * or has their (mobile) tab discarded can resume instead of losing their place.
 * One row per (user, subject, difficulty) — a user may have several half-finished
 * exams, at most one per combo (the `exam_sessions_user_subject_diff_unique`
 * index); starting the same combo again REPLACES the row (upsert). A finished or
 * abandoned exam clears its row (`recordAttempt` / `discardExamSession`).
 *
 * Owned via `userId` by whoever is sitting it (the student, or a parent in
 * student mode) — always the caller's own id, mirroring `examAttempts`.
 *
 * Stores only the PUBLIC question ids (the exact ordered paper, so a resume
 * rebuilds the same questions without re-shuffling `buildExam()`) and the user's
 * own answers — never an answer key (those stay server-only). `answers` is
 * parallel to `questionIds`: an mcq choice index, a free-text string, or null.
 */
export const examSessions = sqliteTable(
  'exam_sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    subject: text('subject').notNull(),
    difficulty: text('difficulty', { enum: ['easy', 'medium', 'hard'] }).notNull(),
    questionIds: text('question_ids', { mode: 'json' }).notNull().$type<string[]>(),
    answers: text('answers', { mode: 'json' }).notNull().$type<(number | string | null)[]>(),
    currentIndex: integer('current_index').notNull().default(0),
    startedAt: integer('started_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    uniqueIndex('exam_sessions_user_subject_diff_unique').on(t.userId, t.subject, t.difficulty),
  ],
);

export type ExamSession = typeof examSessions.$inferSelect;
export type NewExamSession = typeof examSessions.$inferInsert;

/**
 * The bounded, client-renderable grading feedback for a free-text answer. These
 * are the ONLY grading fields ever surfaced in the UI — the rubric and the raw
 * model text are never shipped (see the render invariant in `CLAUDE.md`).
 */
export type Verdict = {
  /** Marks awarded, 0..maxScore. */
  score: number;
  /** One short sentence of feedback. */
  verdict: string;
  /** Points the answer got right. */
  gotRight: string[];
  /** Points to review / that were missed. */
  toReview: string[];
  /** Spelling slips worth noting (non-penalising). */
  spelling: string[];
};

/**
 * A single reviewed question inside a persisted attempt's `items` snapshot —
 * a discriminated union by `type`.
 *
 * `type`/`id` are optional on the MCQ shape so rows persisted BEFORE this field
 * existed (legacy attempts, no `type`) still satisfy the type without a cast;
 * `normalizeAttemptItem` (`src/lib/exam/attempts.ts`) fills in the default.
 */
export type McqAttemptItem = {
  type?: 'mcq';
  id?: string;
  q: string;
  choices: string[];
  /** The choice index the student picked, or null if left blank. */
  chosen: number | null;
  /** The index of the correct choice. */
  answer: number;
};

export type FreeAttemptItem = {
  type: 'free';
  id: string;
  q: string;
  /** The student's typed answer. */
  response: string;
  maxScore: number;
  /** Marks awarded when graded; null when the item is held for review. */
  score: number | null;
  status: 'graded' | 'needs_review';
  /** The bounded feedback when graded; null when held for review. */
  verdict: Verdict | null;
};

export type AttemptItem = McqAttemptItem | FreeAttemptItem;
