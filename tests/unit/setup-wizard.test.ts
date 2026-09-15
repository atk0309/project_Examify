import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_CATALOG_EMIT_MESSAGE } from '@/lib/setup-wizard-types';

const TMP = path.join(process.cwd(), 'tests', '.tmp');
const DB_PATH = path.join(TMP, `setup-wizard-${process.pid}.db`);
Reflect.set(process.env, 'DATABASE_URL', `file:${DB_PATH}`);
delete process.env.FAMILIES;

function fixtureIr(id: string, label: string) {
  return {
    version: 1,
    subject: { id, label, icon: 'geography', l: 0.6, c: 0.08, h: 40 },
    difficulties: {
      easy: [
        {
          id: `${id}-easy-1`,
          type: 'mcq',
          q: 'A fixture question?',
          choices: ['A', 'B', 'C', 'D'],
          answer: 1,
          provenance: { pdf: 'hand-authored', locator: 'unit' },
        },
      ],
      medium: [],
      hard: [],
    },
  };
}

function seedGenerated(root: string, id = 'chemistry') {
  const generated = path.join(root, 'content/generated');
  mkdirSync(path.join(generated, 'questions'), { recursive: true });
  mkdirSync(path.join(generated, 'keys'), { recursive: true });
  const subjects = JSON.stringify(
    [{ id, label: 'Chemistry', icon: 'chemistry', l: 0.6, c: 0.1, h: 30 }],
    null,
    2,
  );
  const questions = JSON.stringify({ easy: [], medium: [], hard: [] }, null, 2);
  const keys = JSON.stringify(
    {
      [`${id}-easy-1`]: {
        type: 'mcq',
        answer: 0,
        provenance: { pdf: 'secret.pdf', locator: 'do-not-leak' },
      },
    },
    null,
    2,
  );
  writeFileSync(path.join(generated, 'subjects.json'), subjects);
  writeFileSync(path.join(generated, 'questions', `${id}.json`), questions);
  writeFileSync(path.join(generated, 'keys', `${id}.json`), keys);
  return {
    subjectsPath: path.join(generated, 'subjects.json'),
    questionsPath: path.join(generated, 'questions', `${id}.json`),
    keysPath: path.join(generated, 'keys', `${id}.json`),
    subjects,
    questions,
    keys,
  };
}

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'examify-wizard-'));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'project-examify' }));
  mkdirSync(path.join(root, 'content/subjects'), { recursive: true });
  mkdirSync(path.join(root, 'src/lib/exam'), { recursive: true });
  return root;
}

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
  if (existsSync(DB_PATH)) {
    const fs = require('node:fs') as typeof import('node:fs');
    fs.unlinkSync(DB_PATH);
  }
  const sqlite = new Database(DB_PATH);
  sqlite.pragma('journal_mode = WAL');
  migrate(drizzle(sqlite), {
    migrationsFolder: path.join(process.cwd(), 'src', 'lib', 'db', 'migrations'),
  });
  sqlite.close();
});

afterAll(() => {
  const fs = require('node:fs') as typeof import('node:fs');
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
});

beforeEach(async () => {
  const { db, schema } = await import('@/lib/db');
  const { resetLegacyImportLatch } = await import('@/lib/households');
  db.delete(schema.householdMembers).run();
  db.delete(schema.households).run();
  db.delete(schema.users).run();
  resetLegacyImportLatch();
});

afterEach(async () => {
  const { setWizardContentRootForTests } = await import('@/lib/setup-wizard');
  setWizardContentRootForTests(null);
});

describe('setup wizard catalog emit', () => {
  it('refuses an empty subjects tree and does not wipe generated files', async () => {
    const { previewCatalogEmit, applyCatalogEmit, setWizardContentRootForTests } =
      await import('@/lib/setup-wizard');
    const root = tempRoot();
    mkdirSync(path.join(root, 'content/subjects/history'), { recursive: true });
    const leftover = seedGenerated(root);
    setWizardContentRootForTests(root);

    const preview = previewCatalogEmit(root);
    expect(preview.ok).toBe(false);
    if (preview.ok) throw new Error('expected refuse');
    expect(preview.reason).toBe('empty_catalog');
    expect(preview.message).toBe(EMPTY_CATALOG_EMIT_MESSAGE);
    expect(preview.message).toMatch(/will not wipe generated content/);

    const applied = applyCatalogEmit(root);
    expect(applied.ok).toBe(false);
    expect(readFileSync(leftover.subjectsPath, 'utf8')).toBe(leftover.subjects);
    expect(readFileSync(leftover.questionsPath, 'utf8')).toBe(leftover.questions);
    expect(readFileSync(leftover.keysPath, 'utf8')).toBe(leftover.keys);
  });

  it('dry-run plan is paths only and never includes key contents', async () => {
    const { previewCatalogEmit, setWizardContentRootForTests } = await import('@/lib/setup-wizard');
    const root = tempRoot();
    mkdirSync(path.join(root, 'content/subjects/history'), { recursive: true });
    writeFileSync(
      path.join(root, 'content/subjects/history/bank.ir.json'),
      JSON.stringify(fixtureIr('history', 'History')),
    );
    seedGenerated(root);
    setWizardContentRootForTests(root);

    const preview = previewCatalogEmit(root);
    expect(preview.ok).toBe(true);
    if (!preview.ok) throw new Error('expected preview');
    const serialized = JSON.stringify(preview.files);
    expect(serialized).not.toContain('do-not-leak');
    expect(serialized).not.toContain('secret.pdf');
    expect(serialized).not.toContain('"answer"');
    expect(serialized).not.toContain('A fixture question?');
    expect(preview.files.some((file) => file.relPath.endsWith('keys/history.json'))).toBe(true);
    expect(preview.files.every((file) => file.relPath && file.action)).toBe(true);
  });
});

describe('setup wizard subjects and files', () => {
  it('adds and deletes a subject, refusing sample-bank ids', async () => {
    const {
      addWizardSubject,
      deleteWizardSubject,
      listWizardSubjects,
      setWizardContentRootForTests,
    } = await import('@/lib/setup-wizard');
    const root = tempRoot();
    setWizardContentRootForTests(root);

    expect(addWizardSubject({ id: 'maths', label: 'Maths', icon: 'maths' }, root)).toEqual({
      ok: false,
      reason: 'sample_id',
    });
    const added = addWizardSubject({ id: 'history', label: 'History', icon: 'geography' }, root);
    expect(added.ok).toBe(true);
    expect(listWizardSubjects(root).map((row) => row.id)).toEqual(['history']);

    expect(deleteWizardSubject('history', root)).toEqual({ ok: true });
    expect(listWizardSubjects(root)).toEqual([]);
  });

  it('attaches a PDF and a matching BankIR, refusing a mismatched subject id', async () => {
    const { addWizardSubject, attachWizardFile, setWizardContentRootForTests } =
      await import('@/lib/setup-wizard');
    const root = tempRoot();
    setWizardContentRootForTests(root);
    expect(addWizardSubject({ id: 'history', label: 'History', icon: 'geography' }, root).ok).toBe(
      true,
    );

    const pdf = attachWizardFile(
      { subjectId: 'history', filename: 'notes.pdf', bytes: Buffer.from('%PDF-1.4 fixture') },
      root,
    );
    expect(pdf).toEqual({ ok: true, name: 'notes.pdf', kind: 'pdf' });

    const mismatch = attachWizardFile(
      {
        subjectId: 'history',
        filename: 'bank.ir.json',
        bytes: Buffer.from(JSON.stringify(fixtureIr('biology', 'Biology'))),
      },
      root,
    );
    expect(mismatch).toEqual({ ok: false, reason: 'ir_mismatch' });

    const ir = attachWizardFile(
      {
        subjectId: 'history',
        filename: 'bank.ir.json',
        bytes: Buffer.from(JSON.stringify(fixtureIr('history', 'History'))),
      },
      root,
    );
    expect(ir).toEqual({ ok: true, name: 'bank.ir.json', kind: 'ir' });
  });
});

describe('setup wizard household gate', () => {
  it('is pending after bootstrap and clear after complete', async () => {
    const { bootstrapHousehold } = await import('@/lib/households');
    const { completeSetupWizard, parentNeedsSetupWizard } = await import('@/lib/setup-wizard');
    const host = bootstrapHousehold({ email: 'pat@example.com', householdName: 'Ours' });
    expect(host.ok).toBe(true);
    if (!host.ok) throw new Error('bootstrap');
    expect(parentNeedsSetupWizard(host.userId)).toBe(true);
    completeSetupWizard(host.householdId);
    expect(parentNeedsSetupWizard(host.userId)).toBe(false);
  });
});
