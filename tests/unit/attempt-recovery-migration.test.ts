import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';

it('upgrades a populated pre-recovery database without dropping users, attempts, drafts or membership', () => {
  const sqlite = new Database(':memory:');
  const dir = path.join(process.cwd(), 'src/lib/db/migrations');
  try {
    for (const file of fs
      .readdirSync(dir)
      .filter((name) => /^000[0-8]_.*\.sql$/.test(name))
      .sort()) {
      sqlite.exec(fs.readFileSync(path.join(dir, file), 'utf8'));
    }
    sqlite.exec(`
      INSERT INTO users (id, email, password_hash) VALUES (1, 'student@example.com', 'existing-hash');
      INSERT INTO households (id, name) VALUES (1, 'Existing family');
      INSERT INTO household_members (household_id, user_id, role) VALUES (1, 1, 'student');
      INSERT INTO exam_attempts (id, user_id, subject, difficulty, total, correct, score_pct, items)
        VALUES (1, 1, 'maths', 'easy', 1, 1, 100, '[]');
      INSERT INTO exam_sessions (user_id, subject, difficulty, question_ids, answers, current_index)
        VALUES (1, 'maths', 'easy', '["question"]', '[1]', 0);
    `);
    sqlite.exec(fs.readFileSync(path.join(dir, '0009_attempt_recovery.sql'), 'utf8'));
    expect(sqlite.prepare('SELECT password_hash, session_version FROM users').get()).toEqual({
      password_hash: 'existing-hash',
      session_version: 0,
    });
    expect(sqlite.prepare('SELECT role FROM household_members').get()).toEqual({ role: 'student' });
    expect(sqlite.prepare('SELECT name FROM households').get()).toEqual({
      name: 'Existing family',
    });
    expect(
      sqlite.prepare('SELECT score_pct, submission_id, grading_tasks FROM exam_attempts').get(),
    ).toEqual({ score_pct: 100, submission_id: null, grading_tasks: null });
    expect(sqlite.prepare('SELECT answers, submission_id FROM exam_sessions').get()).toEqual({
      answers: '[1]',
      submission_id: expect.stringMatching(/^[a-f0-9]{32}$/),
    });
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
  } finally {
    sqlite.close();
  }
});
