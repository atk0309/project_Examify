import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectQuestionIds, FIXTURE_IDS } from 'examify-ingest';
import { SAMPLE_QUESTIONS } from '@/lib/exam/data';
import { EMPTY_AUTHORITATIVE_EMIT } from '@/lib/onboarding-types';

const TMP = path.join(process.cwd(), 'tests', '.tmp');
const DB_PATH = path.join(TMP, `onboarding-${process.pid}.db`);
Reflect.set(process.env, 'DATABASE_URL', `file:${DB_PATH}`);
delete process.env.FAMILIES;

function fixtureIr(id: string, label: string, questionId = `${id}-easy-1`) {
  return {
    version: 1,
    subject: { id, label, icon: 'geography', l: 0.6, c: 0.08, h: 40 },
    difficulties: {
      easy: [
        {
          id: questionId,
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
  const root = mkdtempSync(path.join(tmpdir(), 'examify-onboarding-'));
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
  const { setOnboardingContentRootForTests } = await import('@/lib/onboarding');
  const { setEnvStoreRootForTests, setInitialEnvironForTests } = await import('@/lib/env-store');
  setOnboardingContentRootForTests(null);
  setEnvStoreRootForTests(null);
  setInitialEnvironForTests(null);
});

describe('onboarding catalog emit', () => {
  it('refuses an empty subjects tree when there is nothing to remove', async () => {
    const { previewOnboardingEmit, setOnboardingContentRootForTests } =
      await import('@/lib/onboarding');
    const root = tempRoot();
    mkdirSync(path.join(root, 'content/subjects/history'), { recursive: true });
    setOnboardingContentRootForTests(root);

    const preview = previewOnboardingEmit(false, root);
    expect(preview.ok).toBe(false);
    if (preview.ok) throw new Error('expected refuse');
    expect(preview.reason).toBe('empty_catalog');
    expect(preview.message).toBe(EMPTY_AUTHORITATIVE_EMIT);
  });

  it('an empty family tree with leftovers is a prune-only plan that never wipes unconfirmed', async () => {
    const { previewOnboardingEmit, applyOnboardingEmit, setOnboardingContentRootForTests } =
      await import('@/lib/onboarding');
    const root = tempRoot();
    mkdirSync(path.join(root, 'content/subjects/history'), { recursive: true });
    const leftover = seedGenerated(root);
    setOnboardingContentRootForTests(root);

    const preview = previewOnboardingEmit(false, root);
    if (!preview.ok) throw new Error('expected a prune-only preview');
    expect(preview.dryRun.subjectCount).toBe(0);
    expect(preview.dryRun.diff).toContain('would delete content/generated/keys/chemistry.json');
    expect(preview.dryRun.diff).not.toContain('do-not-leak');

    // Not the confirmed dry-run, then no prune confirm: nothing is touched.
    const stale = applyOnboardingEmit({ replaceSample: false, expectedHash: 'unused' }, root);
    expect(stale.ok === false && stale.reason).toBe('stale_preview');
    const unconfirmed = applyOnboardingEmit(
      { replaceSample: false, expectedHash: preview.dryRun.hash },
      root,
    );
    expect(unconfirmed.ok === false && unconfirmed.reason).toBe('prune_confirm_required');
    expect(readFileSync(leftover.subjectsPath, 'utf8')).toBe(leftover.subjects);
    expect(readFileSync(leftover.questionsPath, 'utf8')).toBe(leftover.questions);
    expect(readFileSync(leftover.keysPath, 'utf8')).toBe(leftover.keys);
  });

  it('dry-run includes a public CLI-shaped diff and never includes key contents', async () => {
    const { previewOnboardingEmit, setOnboardingContentRootForTests } =
      await import('@/lib/onboarding');
    const root = tempRoot();
    mkdirSync(path.join(root, 'content/subjects/history'), { recursive: true });
    writeFileSync(
      path.join(root, 'content/subjects/history/bank.ir.json'),
      JSON.stringify(fixtureIr('history', 'History')),
    );
    seedGenerated(root);
    setOnboardingContentRootForTests(root);

    const preview = previewOnboardingEmit(false, root);
    expect(preview.ok).toBe(true);
    if (!preview.ok) throw new Error('expected preview');
    const serialized = JSON.stringify(preview.dryRun);
    expect(serialized).not.toContain('do-not-leak');
    expect(serialized).not.toContain('secret.pdf');
    expect(serialized).not.toContain('"answer"');
    expect(preview.dryRun.plan.some((file) => file.path.endsWith('keys/history.json'))).toBe(true);
    expect(preview.dryRun.plan.every((file) => file.path && file.action)).toBe(true);
    expect(preview.dryRun.questionCount).toBe(1);
    expect(preview.dryRun.diff).toMatch(/would (create|update|delete) /);
    expect(preview.dryRun.diff).not.toContain('do-not-leak');
    expect(preview.dryRun.diff).not.toContain('secret.pdf');
  });

  it('delete removes IR only; prune waits for confirmed directory apply', async () => {
    const {
      applyOnboardingEmit,
      deleteOnboardingSubject,
      previewOnboardingEmit,
      setOnboardingContentRootForTests,
    } = await import('@/lib/onboarding');
    const root = tempRoot();
    setOnboardingContentRootForTests(root);
    mkdirSync(path.join(root, 'content/subjects/history'), { recursive: true });
    writeFileSync(
      path.join(root, 'content/subjects/history/bank.ir.json'),
      JSON.stringify(fixtureIr('history', 'History')),
    );
    mkdirSync(path.join(root, 'content/subjects/civics'), { recursive: true });
    writeFileSync(
      path.join(root, 'content/subjects/civics/bank.ir.json'),
      JSON.stringify(fixtureIr('civics', 'Civics')),
    );
    const leftover = seedGenerated(root, 'chemistry');

    expect(deleteOnboardingSubject('history', root)).toEqual({ ok: true });
    expect(existsSync(path.join(root, 'content/subjects/history/bank.ir.json'))).toBe(false);
    expect(readFileSync(leftover.keysPath, 'utf8')).toBe(leftover.keys);

    const preview = previewOnboardingEmit(false, root);
    expect(preview.ok).toBe(true);
    if (!preview.ok) throw new Error('expected preview');
    expect(
      preview.dryRun.plan.some((row) => row.action === 'delete' && row.path.includes('chemistry')),
    ).toBe(true);
    expect(preview.dryRun.diff).toContain(
      'would delete content/generated/questions/chemistry.json',
    );
    expect(preview.dryRun.diff).toContain('would delete content/generated/keys/chemistry.json');
    expect(preview.dryRun.diff).not.toContain('do-not-leak');

    const refused = applyOnboardingEmit(
      { replaceSample: false, expectedHash: preview.dryRun.hash },
      root,
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('expected prune confirm');
    expect(refused.reason).toBe('prune_confirm_required');
    expect(refused.message).toMatch(/chemistry/);
    expect(refused.deletes?.some((row) => row.path.includes('chemistry'))).toBe(true);
    expect(existsSync(leftover.questionsPath)).toBe(true);
    expect(existsSync(leftover.keysPath)).toBe(true);

    const applied = applyOnboardingEmit(
      { replaceSample: false, expectedHash: preview.dryRun.hash, confirmPrune: true },
      root,
    );
    expect(applied.ok).toBe(true);
    expect(existsSync(leftover.questionsPath)).toBe(false);
    expect(existsSync(leftover.keysPath)).toBe(false);
  });

  it('deleting the last family subject lets Apply remove it from the live bank', async () => {
    const {
      applyOnboardingEmit,
      deleteOnboardingSubject,
      previewOnboardingEmit,
      setOnboardingContentRootForTests,
      validateOnboardingIr,
    } = await import('@/lib/onboarding');
    const { loadLivePublicBank } = await import('@/lib/exam/live-bank.server');
    const root = tempRoot();
    setOnboardingContentRootForTests(root);
    mkdirSync(path.join(root, 'content/subjects/history'), { recursive: true });
    writeFileSync(
      path.join(root, 'content/subjects/history/bank.ir.json'),
      JSON.stringify(fixtureIr('history', 'History')),
    );
    const first = previewOnboardingEmit(false, root);
    if (!first.ok) throw new Error('expected preview');
    expect(
      applyOnboardingEmit({ replaceSample: false, expectedHash: first.dryRun.hash }, root).ok,
    ).toBe(true);
    expect(loadLivePublicBank().subjects.some((subject) => subject.id === 'history')).toBe(true);

    expect(deleteOnboardingSubject('history', root)).toEqual({ ok: true });
    expect(validateOnboardingIr(false, root)).toEqual({ ok: true });
    const preview = previewOnboardingEmit(false, root);
    if (!preview.ok) throw new Error(`expected a prune-only preview, got ${preview.reason}`);
    expect(preview.dryRun.subjectCount).toBe(0);
    expect(preview.dryRun.diff).toContain('would delete content/generated/keys/history.json');
    expect(preview.planned.every((file) => !file.relPath.startsWith('src/'))).toBe(true);

    const refused = applyOnboardingEmit(
      { replaceSample: false, expectedHash: preview.dryRun.hash },
      root,
    );
    expect(refused.ok === false && refused.reason).toBe('prune_confirm_required');
    expect(loadLivePublicBank().subjects.some((subject) => subject.id === 'history')).toBe(true);

    const applied = applyOnboardingEmit(
      { replaceSample: false, expectedHash: preview.dryRun.hash, confirmPrune: true },
      root,
    );
    expect(applied.ok).toBe(true);
    expect(existsSync(path.join(root, 'content/generated/keys/history.json'))).toBe(false);
    expect(loadLivePublicBank().subjects.some((subject) => subject.id === 'history')).toBe(false);

    // Nothing left to remove: an empty tree is refused again, as before.
    expect(previewOnboardingEmit(false, root)).toMatchObject({
      ok: false,
      reason: 'empty_catalog',
    });
  });

  it('refuses apply when the plan no longer matches the confirmed dry-run hash', async () => {
    const { applyOnboardingEmit, previewOnboardingEmit, setOnboardingContentRootForTests } =
      await import('@/lib/onboarding');
    const root = tempRoot();
    mkdirSync(path.join(root, 'content/subjects/history'), { recursive: true });
    writeFileSync(
      path.join(root, 'content/subjects/history/bank.ir.json'),
      JSON.stringify(fixtureIr('history', 'History')),
    );
    setOnboardingContentRootForTests(root);

    const preview = previewOnboardingEmit(false, root);
    expect(preview.ok).toBe(true);
    if (!preview.ok) throw new Error('expected preview');

    writeFileSync(
      path.join(root, 'content/subjects/history/bank.ir.json'),
      JSON.stringify(fixtureIr('history', 'History', 'history-easy-2')),
    );

    const applied = applyOnboardingEmit(
      { replaceSample: false, expectedHash: preview.dryRun.hash },
      root,
    );
    expect(applied.ok).toBe(false);
    if (applied.ok) throw new Error('expected stale refuse');
    expect(applied.reason).toBe('stale_preview');
    expect(existsSync(path.join(root, 'content/generated/questions/history.json'))).toBe(false);
    expect(existsSync(path.join(root, 'content/generated/keys/history.json'))).toBe(false);
  });

  it('surfaces every colliding SAMPLE_QUESTIONS id, not only ingest fixtures', async () => {
    const { previewOnboardingEmit, setOnboardingContentRootForTests } =
      await import('@/lib/onboarding');
    const allSampleIds = collectQuestionIds(SAMPLE_QUESTIONS);
    const nonFixture = allSampleIds.find((id) => !(FIXTURE_IDS as readonly string[]).includes(id));
    expect(nonFixture).toBeTruthy();
    expect(allSampleIds.length).toBeGreaterThan(FIXTURE_IDS.length);

    const root = tempRoot();
    mkdirSync(path.join(root, 'content/subjects/maths'), { recursive: true });
    writeFileSync(
      path.join(root, 'content/subjects/maths/bank.ir.json'),
      JSON.stringify(fixtureIr('maths', 'Maths', nonFixture)),
    );
    setOnboardingContentRootForTests(root);

    const blocked = previewOnboardingEmit(false, root);
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error('expected collision');
    expect(JSON.stringify(blocked.issues)).toContain(nonFixture);

    const allowed = previewOnboardingEmit(true, root);
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) throw new Error('expected replace-sample preview');
    expect(allowed.dryRun.collisions).toContain(nonFixture);
    expect(allowed.dryRun.replaceSample).toBe(true);

    const { validateOnboardingIr } = await import('@/lib/onboarding');
    const blockedValidate = validateOnboardingIr(false, root);
    expect(blockedValidate.ok).toBe(false);
    const allowedValidate = validateOnboardingIr(true, root);
    expect(allowedValidate.ok).toBe(true);
  });
});

describe('onboarding subjects and files', () => {
  it('adds, renames, and deletes a subject without writing generated files', async () => {
    const {
      addOnboardingSubject,
      deleteOnboardingSubject,
      listOnboardingSubjects,
      renameOnboardingSubject,
      setOnboardingContentRootForTests,
    } = await import('@/lib/onboarding');
    const root = tempRoot();
    setOnboardingContentRootForTests(root);

    const added = addOnboardingSubject({ id: 'History', label: 'History', icon: 'unknown' }, root);
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error('add');
    expect(added.subject.icon).toBe('maths');
    expect(added.subject.hasIr).toBe(false);
    expect(listOnboardingSubjects(root).map((row) => row.id)).toEqual(['history']);
    expect(existsSync(path.join(root, 'content/subjects/history/bank.ir.json'))).toBe(false);
    expect(existsSync(path.join(root, 'content/subjects/history/subject.json'))).toBe(true);

    const renamed = renameOnboardingSubject(
      { id: 'history', nextId: 'world-history', label: 'World History', icon: 'geography' },
      root,
    );
    expect(renamed.ok).toBe(true);
    expect(listOnboardingSubjects(root).map((row) => row.id)).toEqual(['world-history']);

    const leftover = seedGenerated(root, 'world-history');
    mkdirSync(path.join(root, 'content/subjects/civics'), { recursive: true });
    writeFileSync(
      path.join(root, 'content/subjects/civics/bank.ir.json'),
      JSON.stringify(fixtureIr('civics', 'Civics')),
    );

    expect(deleteOnboardingSubject('world-history', root)).toEqual({ ok: true });
    expect(listOnboardingSubjects(root).map((row) => row.id)).toEqual(['civics']);
    expect(existsSync(leftover.questionsPath)).toBe(true);
    expect(existsSync(leftover.keysPath)).toBe(true);
  });

  it('attaches PDFs under source-pdfs only and refuses IR / oversized files', async () => {
    const { addOnboardingSubject, attachSourcePdf, setOnboardingContentRootForTests } =
      await import('@/lib/onboarding');
    const root = tempRoot();
    setOnboardingContentRootForTests(root);
    expect(
      addOnboardingSubject({ id: 'history', label: 'History', icon: 'geography' }, root).ok,
    ).toBe(true);

    const pdf = attachSourcePdf(
      { subjectId: 'history', filename: 'notes.pdf', bytes: Buffer.from('%PDF-1.4 fixture') },
      root,
    );
    expect(pdf).toEqual({ ok: true, filename: 'notes.pdf' });
    expect(existsSync(path.join(root, 'content/source-pdfs/history/notes.pdf'))).toBe(true);
    expect(existsSync(path.join(root, 'content/subjects/history/notes.pdf'))).toBe(false);
    expect(existsSync(path.join(root, 'content/generated/notes.pdf'))).toBe(false);

    expect(
      attachSourcePdf(
        {
          subjectId: 'history',
          filename: 'bank.ir.json',
          bytes: Buffer.from(JSON.stringify(fixtureIr('history', 'History'))),
        },
        root,
      ),
    ).toEqual({ ok: false, reason: 'invalid_type' });

    expect(
      attachSourcePdf(
        { subjectId: 'history', filename: 'huge.pdf', bytes: Buffer.alloc(8 * 1024 * 1024 + 1) },
        root,
      ),
    ).toEqual({ ok: false, reason: 'too_large' });

    expect(
      attachSourcePdf(
        { subjectId: 'history', filename: 'fake.pdf', bytes: Buffer.from('not-a-pdf-payload') },
        root,
      ),
    ).toEqual({ ok: false, reason: 'invalid_type' });
    expect(existsSync(path.join(root, 'content/source-pdfs/history/fake.pdf'))).toBe(false);
    expect(existsSync(path.join(root, 'content/source-pdfs/history/notes.pdf'))).toBe(true);
  });

  it('accepts only buffers that start with the PDF magic', async () => {
    const { hasPdfMagic } = await import('@/lib/onboarding');
    expect(hasPdfMagic(Buffer.from('%PDF-1.7'))).toBe(true);
    expect(hasPdfMagic(Buffer.from('%PDF'))).toBe(true);
    expect(hasPdfMagic(Buffer.from('%PD'))).toBe(false);
    expect(hasPdfMagic(Buffer.from('PDF-1.4'))).toBe(false);
    expect(hasPdfMagic(Buffer.alloc(0))).toBe(false);
  });

  it('lists notes.txt generate sources without treating them as uploaded PDFs', async () => {
    const { addOnboardingSubject, listOnboardingSubjects, setOnboardingContentRootForTests } =
      await import('@/lib/onboarding');
    const { onboardingSourceCountLabel, onboardingSourceFileNames } =
      await import('@/lib/onboarding-types');
    const root = tempRoot();
    setOnboardingContentRootForTests(root);
    expect(
      addOnboardingSubject({ id: 'demo', label: 'Generate demo', icon: 'biology' }, root).ok,
    ).toBe(true);
    writeFileSync(path.join(root, 'content/subjects/demo/notes.txt'), 'A generate fixture.\n');
    const demo = listOnboardingSubjects(root).find((row) => row.id === 'demo');
    expect(demo?.sourceFiles).toEqual([]);
    expect(demo?.generateSources).toEqual(['content/subjects/demo/notes.txt']);
    expect(demo?.hasIr).toBe(false);
    expect(onboardingSourceCountLabel(demo!)).toBe('1 source');
    expect(onboardingSourceFileNames(demo!)).toEqual(['notes.txt']);
    expect(onboardingSourceCountLabel({ sourceFiles: [], generateSources: [] })).toBe(
      'No files yet',
    );
    expect(onboardingSourceCountLabel({ sourceFiles: [], generateSources: [], hasIr: false })).toBe(
      'No files yet',
    );
    expect(onboardingSourceCountLabel({ sourceFiles: [], generateSources: [], hasIr: true })).toBe(
      'Hand-authored',
    );
  });

  it('exposes live bank subject names and question counts on the snapshot', async () => {
    const { bootstrapHousehold } = await import('@/lib/households');
    const { applyOnboardingEmit, getOnboardingSnapshot, setOnboardingContentRootForTests } =
      await import('@/lib/onboarding');
    const host = bootstrapHousehold({ email: 'pat@example.com', householdName: 'Ours' });
    expect(host.ok).toBe(true);
    if (!host.ok) throw new Error('bootstrap');
    const root = tempRoot();
    mkdirSync(path.join(root, 'content/subjects/history'), { recursive: true });
    writeFileSync(
      path.join(root, 'content/subjects/history/bank.ir.json'),
      JSON.stringify(fixtureIr('history', 'History')),
    );
    setOnboardingContentRootForTests(root);
    const { previewOnboardingEmit } = await import('@/lib/onboarding');
    const preview = previewOnboardingEmit(false, root);
    expect(preview.ok).toBe(true);
    if (!preview.ok) throw new Error('expected preview');
    expect(
      applyOnboardingEmit({ replaceSample: false, expectedHash: preview.dryRun.hash }, root).ok,
    ).toBe(true);
    const snap = getOnboardingSnapshot(host.householdId, root);
    const history = snap.liveSubjects.find((row) => row.id === 'history');
    expect(history).toMatchObject({ id: 'history', label: 'History', questionCount: 1 });
    expect(snap.liveSubjects.some((row) => row.label && row.id)).toBe(true);
  });

  it('treats leftover empty / zero-item BankIR as not existing for overwrite', async () => {
    const { listOnboardingSubjects, setOnboardingContentRootForTests } =
      await import('@/lib/onboarding');
    const { classifyBankIr, hasExistingBankIr } = await import('examify-ingest');
    const root = tempRoot();
    const irPath = path.join(root, 'content/subjects/history/bank.ir.json');
    mkdirSync(path.join(root, 'content/subjects/history'), { recursive: true });
    setOnboardingContentRootForTests(root);

    writeFileSync(irPath, '');
    expect(classifyBankIr(irPath)).toEqual({ kind: 'placeholder' });
    expect(hasExistingBankIr(irPath)).toBe(false);
    expect(listOnboardingSubjects(root)[0]).toMatchObject({ id: 'history', hasIr: false });

    writeFileSync(
      irPath,
      JSON.stringify({
        version: 1,
        subject: { id: 'history', label: 'History', icon: 'geography', l: 0.6, c: 0.08, h: 40 },
        difficulties: { easy: [], medium: [], hard: [] },
      }),
    );
    expect(classifyBankIr(irPath)).toEqual({ kind: 'placeholder' });
    expect(hasExistingBankIr(irPath)).toBe(false);
    expect(listOnboardingSubjects(root)[0]).toMatchObject({ id: 'history', hasIr: false });
  });

  it('treats leftover corrupt BankIR as existing for overwrite', async () => {
    const { listOnboardingSubjects, setOnboardingContentRootForTests } =
      await import('@/lib/onboarding');
    const { classifyBankIr, hasExistingBankIr } = await import('examify-ingest');
    const root = tempRoot();
    const irPath = path.join(root, 'content/subjects/history/bank.ir.json');
    mkdirSync(path.join(root, 'content/subjects/history'), { recursive: true });
    setOnboardingContentRootForTests(root);

    for (const [body, reason] of [
      ['{}\n', 'invalid BankIR schema'],
      ['{ "stale": true }\n', 'invalid BankIR schema'],
      ['not-json{\n', 'unparseable JSON'],
    ] as const) {
      writeFileSync(irPath, body);
      expect(classifyBankIr(irPath)).toEqual({ kind: 'corrupt', reason });
      expect(hasExistingBankIr(irPath)).toBe(true);
      expect(listOnboardingSubjects(root)[0]).toMatchObject({ id: 'history', hasIr: true });
    }
  });

  it('does not leave the IR dir renamed when the destination PDF dir already exists', async () => {
    const {
      addOnboardingSubject,
      attachSourcePdf,
      listOnboardingSubjects,
      renameOnboardingSubject,
      setOnboardingContentRootForTests,
    } = await import('@/lib/onboarding');
    const root = tempRoot();
    setOnboardingContentRootForTests(root);
    expect(
      addOnboardingSubject({ id: 'history', label: 'History', icon: 'geography' }, root).ok,
    ).toBe(true);
    expect(
      attachSourcePdf(
        { subjectId: 'history', filename: 'notes.pdf', bytes: Buffer.from('%PDF-1.4 fixture') },
        root,
      ).ok,
    ).toBe(true);

    mkdirSync(path.join(root, 'content/source-pdfs/world-history'), { recursive: true });
    writeFileSync(
      path.join(root, 'content/source-pdfs/world-history/other.pdf'),
      '%PDF-1.4 leftover',
    );

    const renamed = renameOnboardingSubject(
      { id: 'history', nextId: 'world-history', label: 'World History', icon: 'geography' },
      root,
    );
    expect(renamed).toEqual({ ok: false, reason: 'duplicate' });
    expect(listOnboardingSubjects(root).map((row) => row.id)).toEqual(['history']);
    expect(existsSync(path.join(root, 'content/subjects/history/bank.ir.json'))).toBe(false);
    expect(existsSync(path.join(root, 'content/subjects/history/subject.json'))).toBe(true);
    expect(existsSync(path.join(root, 'content/subjects/world-history'))).toBe(false);
    expect(existsSync(path.join(root, 'content/source-pdfs/history/notes.pdf'))).toBe(true);
    expect(existsSync(path.join(root, 'content/source-pdfs/world-history/other.pdf'))).toBe(true);
  });

  it('rewrites question ids when renaming a populated subject', async () => {
    const {
      renameOnboardingSubject,
      rewriteOnboardingQuestionIds,
      setOnboardingContentRootForTests,
      validateOnboardingIr,
    } = await import('@/lib/onboarding');
    const root = tempRoot();
    setOnboardingContentRootForTests(root);
    mkdirSync(path.join(root, 'content/subjects/biology'), { recursive: true });
    writeFileSync(
      path.join(root, 'content/subjects/biology/bank.ir.json'),
      JSON.stringify({
        version: 1,
        subject: { id: 'biology', label: 'Biology', icon: 'biology', l: 0.58, c: 0.09, h: 142 },
        difficulties: {
          easy: [
            {
              id: 'biology-easy-1',
              type: 'mcq',
              q: 'A populated question?',
              choices: ['A', 'B', 'C', 'D'],
              answer: 1,
              provenance: { pdf: 'hand-authored', locator: 'unit' },
            },
            {
              id: 'biology-easy-free-1',
              type: 'free',
              q: 'A populated free item?',
              rubric: 'Award 1 mark.',
              maxScore: 1,
              provenance: { pdf: 'hand-authored', locator: 'unit' },
            },
          ],
          medium: [],
          hard: [],
        },
      }),
    );

    const rewritten = rewriteOnboardingQuestionIds(
      {
        easy: [{ id: 'biology-easy-1' }, { id: 'biology-easy-free-1' }],
      },
      'biology',
      'life-science',
    );
    expect(rewritten).toEqual({
      easy: [{ id: 'life-science-easy-1' }, { id: 'life-science-easy-free-1' }],
    });

    const renamed = renameOnboardingSubject(
      { id: 'biology', nextId: 'life-science', label: 'Life Science', icon: 'biology' },
      root,
    );
    expect(renamed.ok).toBe(true);
    const ir = JSON.parse(
      readFileSync(path.join(root, 'content/subjects/life-science/bank.ir.json'), 'utf8'),
    ) as {
      subject: { id: string };
      difficulties: { easy: { id: string }[] };
    };
    expect(ir.subject.id).toBe('life-science');
    expect(ir.difficulties.easy.map((item) => item.id)).toEqual([
      'life-science-easy-1',
      'life-science-easy-free-1',
    ]);
    expect(existsSync(path.join(root, 'content/subjects/biology'))).toBe(false);
    expect(validateOnboardingIr(false, root)).toEqual({ ok: true });
  });

  it('moves IR and source-pdf dirs together on a successful id rename', async () => {
    const {
      addOnboardingSubject,
      attachSourcePdf,
      listOnboardingSubjects,
      renameOnboardingSubject,
      setOnboardingContentRootForTests,
    } = await import('@/lib/onboarding');
    const root = tempRoot();
    setOnboardingContentRootForTests(root);
    expect(
      addOnboardingSubject({ id: 'history', label: 'History', icon: 'geography' }, root).ok,
    ).toBe(true);
    expect(
      attachSourcePdf(
        { subjectId: 'history', filename: 'notes.pdf', bytes: Buffer.from('%PDF-1.4 fixture') },
        root,
      ).ok,
    ).toBe(true);

    const renamed = renameOnboardingSubject(
      { id: 'history', nextId: 'world-history', label: 'World History', icon: 'geography' },
      root,
    );
    expect(renamed.ok).toBe(true);
    expect(listOnboardingSubjects(root).map((row) => row.id)).toEqual(['world-history']);
    expect(existsSync(path.join(root, 'content/subjects/history'))).toBe(false);
    expect(existsSync(path.join(root, 'content/source-pdfs/history'))).toBe(false);
    expect(existsSync(path.join(root, 'content/source-pdfs/world-history/notes.pdf'))).toBe(true);
  });

  it('delete of the last IR subject leaves generated files until a confirmed prune', async () => {
    const { deleteOnboardingSubject, setOnboardingContentRootForTests } =
      await import('@/lib/onboarding');
    const root = tempRoot();
    setOnboardingContentRootForTests(root);
    mkdirSync(path.join(root, 'content/subjects/history'), { recursive: true });
    writeFileSync(
      path.join(root, 'content/subjects/history/bank.ir.json'),
      JSON.stringify(fixtureIr('history', 'History')),
    );
    const leftover = seedGenerated(root, 'history');
    expect(deleteOnboardingSubject('history', root)).toEqual({ ok: true });
    expect(readFileSync(leftover.keysPath, 'utf8')).toBe(leftover.keys);
    const { previewOnboardingEmit } = await import('@/lib/onboarding');
    const preview = previewOnboardingEmit(false, root);
    if (!preview.ok) throw new Error('expected a prune-only preview');
    expect(preview.dryRun.plan.filter((row) => row.action === 'delete').length).toBeGreaterThan(0);
    expect(readFileSync(leftover.keysPath, 'utf8')).toBe(leftover.keys);
  });
});

describe('onboarding upload filenames (C13)', () => {
  const PDF = Buffer.from('%PDF-1.4 fixture');

  async function uploadRoot() {
    const mod = await import('@/lib/onboarding');
    const root = tempRoot();
    mod.setOnboardingContentRootForTests(root);
    expect(
      mod.addOnboardingSubject({ id: 'history', label: 'History', icon: 'geography' }, root).ok,
    ).toBe(true);
    return { ...mod, root, dir: path.join(root, 'content/source-pdfs/history') };
  }

  it('stores ordinary school filenames under a safe name instead of refusing them', async () => {
    const { attachSourcePdf, isSafeUploadName, listOnboardingSubjects, root, dir } =
      await uploadRoot();
    const cases: [string, string][] = [
      ['Chemistry, Unit 2.pdf', 'Chemistry Unit 2.pdf'],
      ["Mum's notes.pdf", 'Mums notes.pdf'],
      ['Maths & Stats.pdf', 'Maths and Stats.pdf'],
      ['Year 9 – Biology.pdf', 'Year 9 - Biology.pdf'],
      ['Physique_été.pdf', 'Physique_ete.pdf'],
      ['Paper1+MS.pdf', 'Paper1-MS.pdf'],
      ['Revision #3.pdf', 'Revision 3.pdf'],
      ['worksheet 3 ans!.pdf', 'worksheet 3 ans.pdf'],
      ['notes..pdf', 'notes.pdf'],
      ['.hidden.pdf', 'hidden.pdf'],
      ['Биология.pdf', 'upload.pdf'],
      ['Unit 1 - Cells.pdf', 'Unit 1 - Cells.pdf'],
      ['IMG_1234.PDF', 'IMG_1234.pdf'],
    ];
    cases.forEach(([uploaded, stored], index) => {
      const bytes = Buffer.from(`%PDF-1.4 case ${index}`);
      expect(attachSourcePdf({ subjectId: 'history', filename: uploaded, bytes }, root)).toEqual({
        ok: true,
        filename: stored,
      });
      expect(isSafeUploadName(stored)).toBe(true);
      expect(readFileSync(path.join(dir, stored))).toEqual(bytes);
    });
    expect(readdirSync(dir).sort()).toEqual(cases.map(([, stored]) => stored).sort());
    expect(listOnboardingSubjects(root)[0]?.sourceFiles).toEqual(
      cases.map(([, stored]) => stored).sort(),
    );
  });

  it('never clobbers a different file with the same stored name', async () => {
    const { attachSourcePdf, root, dir } = await uploadRoot();
    const first = Buffer.from('%PDF-1.4 first');
    const second = Buffer.from('%PDF-1.4 second');
    expect(
      attachSourcePdf({ subjectId: 'history', filename: 'Unit 2.pdf', bytes: first }, root),
    ).toEqual({ ok: true, filename: 'Unit 2.pdf' });
    expect(
      attachSourcePdf({ subjectId: 'history', filename: 'Unit, 2.pdf', bytes: second }, root),
    ).toEqual({ ok: true, filename: 'Unit 2 (2).pdf' });
    // Dropping the same file again is a no-op, not a third copy.
    expect(
      attachSourcePdf({ subjectId: 'history', filename: 'Unit 2.pdf', bytes: first }, root),
    ).toEqual({ ok: true, filename: 'Unit 2.pdf' });
    expect(readdirSync(dir).sort()).toEqual(['Unit 2 (2).pdf', 'Unit 2.pdf']);
    expect(readFileSync(path.join(dir, 'Unit 2.pdf'))).toEqual(first);
    expect(readFileSync(path.join(dir, 'Unit 2 (2).pdf'))).toEqual(second);
  });

  it('does not write through a symlink that already has the stored name', async () => {
    const { attachSourcePdf, root, dir } = await uploadRoot();
    mkdirSync(dir, { recursive: true });
    const outside = path.join(root, 'outside.txt');
    writeFileSync(outside, 'keep me');
    symlinkSync(outside, path.join(dir, 'notes.pdf'));
    expect(
      attachSourcePdf({ subjectId: 'history', filename: 'notes.pdf', bytes: PDF }, root),
    ).toEqual({ ok: true, filename: 'notes (2).pdf' });
    expect(readFileSync(outside, 'utf8')).toBe('keep me');
  });

  it('gives non-PDF, oversized and unusable names their own reasons', async () => {
    const { attachSourcePdf, root, dir } = await uploadRoot();
    const attach = (filename: string, bytes = PDF) =>
      attachSourcePdf({ subjectId: 'history', filename, bytes }, root);
    expect(attach('notes.docx')).toEqual({ ok: false, reason: 'invalid_type' });
    expect(attach('fake.pdf', Buffer.from('not a pdf'))).toEqual({
      ok: false,
      reason: 'invalid_type',
    });
    expect(attach('empty.pdf', Buffer.alloc(0))).toEqual({ ok: false, reason: 'invalid_type' });
    expect(attach('huge.pdf', Buffer.alloc(8 * 1024 * 1024 + 1))).toEqual({
      ok: false,
      reason: 'too_large',
    });
    for (const name of ['../escape.pdf', 'a/b.pdf', 'a\\b.pdf', 'nul\0.pdf', '   ']) {
      expect(attach(name)).toEqual({ ok: false, reason: 'invalid_name' });
    }
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
    expect(existsSync(path.join(root, 'content/source-pdfs/escape.pdf'))).toBe(false);
  });
});

describe('onboarding upload ceiling', () => {
  it('keeps the Server Action body limit above the advertised PDF cap', async () => {
    const { MAX_SOURCE_PDF_BYTES, ONBOARDING_ACTION_BODY_LIMIT_BYTES } =
      await import('@/lib/onboarding');
    expect(ONBOARDING_ACTION_BODY_LIMIT_BYTES).toBeGreaterThan(MAX_SOURCE_PDF_BYTES);
    const raw = readFileSync(path.join(process.cwd(), 'next.config.mjs'), 'utf8');
    const match = raw.match(/bodySizeLimit:\s*([0-9_]+)\s*\*\s*1024\s*\*\s*1024/);
    expect(match).toBeTruthy();
    const limitBytes = Number(match![1]) * 1024 * 1024;
    expect(limitBytes).toBeGreaterThan(MAX_SOURCE_PDF_BYTES);
    expect(limitBytes).toBeGreaterThanOrEqual(ONBOARDING_ACTION_BODY_LIMIT_BYTES);
  });
});

describe('onboarding household gate', () => {
  it('auto-starts only for the admin until skip or complete', async () => {
    const { bootstrapHousehold } = await import('@/lib/households');
    const {
      adminNeedsOnboardingChip,
      adminShouldAutoStartOnboarding,
      completeOnboarding,
      getOnboardingForUser,
      skipOnboarding,
    } = await import('@/lib/onboarding');
    const host = bootstrapHousehold({ email: 'pat@example.com', householdName: 'Ours' });
    expect(host.ok).toBe(true);
    if (!host.ok) throw new Error('bootstrap');

    let info = getOnboardingForUser(host.userId);
    expect(info.role).toBe('admin');
    expect(info.complete).toBe(false);
    expect(
      adminShouldAutoStartOnboarding({
        role: info.role,
        onboardingComplete: info.complete,
        state: info.state,
      }),
    ).toBe(true);

    skipOnboarding(host.householdId);
    info = getOnboardingForUser(host.userId);
    expect(info.complete).toBe(false);
    expect(
      adminShouldAutoStartOnboarding({
        role: info.role,
        onboardingComplete: info.complete,
        state: info.state,
      }),
    ).toBe(false);
    expect(adminNeedsOnboardingChip({ role: info.role, onboardingComplete: info.complete })).toBe(
      true,
    );

    completeOnboarding(host.householdId);
    info = getOnboardingForUser(host.userId);
    expect(info.complete).toBe(true);
    expect(adminNeedsOnboardingChip({ role: info.role, onboardingComplete: info.complete })).toBe(
      false,
    );
  });

  it('exposes AI configured flags including OpenAI env detection', async () => {
    const { bootstrapHousehold } = await import('@/lib/households');
    const { getOnboardingSnapshot } = await import('@/lib/onboarding');
    const { setEnvStoreRootForTests, setInitialEnvironForTests } = await import('@/lib/env-store');
    const host = bootstrapHousehold({ email: 'pat@example.com', householdName: 'Ours' });
    expect(host.ok).toBe(true);
    if (!host.ok) throw new Error('bootstrap');
    const root = mkdtempSync(path.join(tmpdir(), 'examify-onboarding-openai-'));
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'project-examify' }));
    writeFileSync(path.join(root, '.env'), 'ANTHROPIC_API_KEY=test\n');
    setEnvStoreRootForTests(root);
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const snap = getOnboardingSnapshot(host.householdId);
      expect(snap.openaiConfigured).toBe(false);
      expect(snap.openaiHostManaged).toBe(false);
      expect(snap.anthropicConfigured).toBe(false);
      expect(snap.anthropicPresent).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
    process.env.OPENAI_API_KEY = 'sk-test-not-a-sentinel';
    try {
      const injected = getOnboardingSnapshot(host.householdId);
      expect(injected.openaiConfigured).toBe(true);
      expect(injected.openaiHostManaged).toBe(true);
      writeFileSync(
        path.join(root, '.env'),
        'ANTHROPIC_API_KEY=test\nOPENAI_API_KEY=sk-test-not-a-sentinel\n',
      );
      const matched = getOnboardingSnapshot(host.householdId);
      expect(matched.openaiConfigured).toBe(true);
      expect(matched.openaiHostManaged).toBe(false);
      setInitialEnvironForTests({ OPENAI_API_KEY: 'sk-test-not-a-sentinel' });
      const execOwned = getOnboardingSnapshot(host.householdId);
      expect(execOwned.openaiConfigured).toBe(true);
      expect(execOwned.openaiHostManaged).toBe(true);
      setInitialEnvironForTests({ OPENAI_API_KEY: '' });
      expect(getOnboardingSnapshot(host.householdId).openaiHostManaged).toBe(true);
      setInitialEnvironForTests({ OPENAI_API_KEY: 'test' });
      expect(getOnboardingSnapshot(host.householdId).openaiHostManaged).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it('exposes AI configured flags including Anthropic env detection', async () => {
    const { bootstrapHousehold } = await import('@/lib/households');
    const { getOnboardingSnapshot } = await import('@/lib/onboarding');
    const { setEnvStoreRootForTests, setInitialEnvironForTests } = await import('@/lib/env-store');
    const host = bootstrapHousehold({ email: 'pat@example.com', householdName: 'Ours' });
    expect(host.ok).toBe(true);
    if (!host.ok) throw new Error('bootstrap');
    const root = mkdtempSync(path.join(tmpdir(), 'examify-onboarding-anthropic-'));
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'project-examify' }));
    writeFileSync(path.join(root, '.env'), 'OPENAI_API_KEY=\n');
    setEnvStoreRootForTests(root);
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const snap = getOnboardingSnapshot(host.householdId);
      expect(snap.anthropicConfigured).toBe(false);
      expect(snap.anthropicPresent).toBe(false);
      expect(snap.anthropicHostManaged).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
    process.env.ANTHROPIC_API_KEY = 'sk-anth-test-not-a-sentinel';
    try {
      const injected = getOnboardingSnapshot(host.householdId);
      expect(injected.anthropicConfigured).toBe(true);
      expect(injected.anthropicHostManaged).toBe(true);
      writeFileSync(path.join(root, '.env'), 'ANTHROPIC_API_KEY=sk-anth-test-not-a-sentinel\n');
      const matched = getOnboardingSnapshot(host.householdId);
      expect(matched.anthropicConfigured).toBe(true);
      expect(matched.anthropicHostManaged).toBe(false);
      setInitialEnvironForTests({ ANTHROPIC_API_KEY: 'sk-anth-test-not-a-sentinel' });
      const execOwned = getOnboardingSnapshot(host.householdId);
      expect(execOwned.anthropicConfigured).toBe(true);
      expect(execOwned.anthropicHostManaged).toBe(true);
      setInitialEnvironForTests({ ANTHROPIC_API_KEY: '' });
      expect(getOnboardingSnapshot(host.householdId).anthropicHostManaged).toBe(true);
      setInitialEnvironForTests({ ANTHROPIC_API_KEY: 'test' });
      process.env.ANTHROPIC_API_KEY = 'test';
      const sentinel = getOnboardingSnapshot(host.householdId);
      expect(sentinel.anthropicHostManaged).toBe(true);
      expect(sentinel.anthropicWriteBlocked).toBe(false);
      expect(sentinel.anthropicConfigured).toBe(false);
      expect(sentinel.anthropicPresent).toBe(true);
      expect(sentinel.anthropicLiveTest).toBe(true);
      // Vitest runs with NODE_ENV=test, where gradingStubAllowed() holds.
      expect(sentinel.gradingStubActive).toBe(true);
      setInitialEnvironForTests({ ANTHROPIC_API_KEY: '' });
      process.env.ANTHROPIC_API_KEY = '';
      writeFileSync(path.join(root, '.env'), 'ANTHROPIC_API_KEY=sk-from-store\n');
      const emptyHost = getOnboardingSnapshot(host.householdId);
      expect(emptyHost.anthropicHostManaged).toBe(true);
      expect(emptyHost.anthropicWriteBlocked).toBe(true);
      expect(emptyHost.anthropicConfigured).toBe(false);
      expect(emptyHost.anthropicPresent).toBe(true);
      expect(emptyHost.anthropicLiveTest).toBe(false);
      expect(emptyHost.gradingStubActive).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it('marks finish eligibility on apply and clears it on catalog invalidation', async () => {
    const { bootstrapHousehold } = await import('@/lib/households');
    const {
      getHouseholdOnboarding,
      invalidateOnboardingEmit,
      markOnboardingApplied,
      saveOnboardingState,
    } = await import('@/lib/onboarding');
    const host = bootstrapHousehold({ email: 'pat@example.com', householdName: 'Ours' });
    expect(host.ok).toBe(true);
    if (!host.ok) throw new Error('bootstrap');

    saveOnboardingState(host.householdId, { dryRunHash: 'abc123' });
    markOnboardingApplied(host.householdId);
    let state = getHouseholdOnboarding(host.householdId).state;
    expect(state.applied).toBe(true);
    expect(state.dryRunHash).toBeUndefined();

    saveOnboardingState(host.householdId, { dryRunHash: 'stale' });
    invalidateOnboardingEmit(host.householdId);
    state = getHouseholdOnboarding(host.householdId).state;
    expect(state.applied).toBe(false);
    expect(state.dryRunHash).toBeUndefined();
  });

  it('never auto-starts invited parents or students', async () => {
    const { bootstrapHousehold } = await import('@/lib/households');
    const { adminShouldAutoStartOnboarding, getOnboardingForUser } =
      await import('@/lib/onboarding');
    const { db, schema } = await import('@/lib/db');
    const host = bootstrapHousehold({ email: 'pat@example.com', householdName: 'Ours' });
    if (!host.ok) throw new Error('bootstrap');
    const parent = db
      .insert(schema.users)
      .values({ email: 'other@example.com', emailVerifiedAt: new Date() })
      .returning()
      .get()!;
    db.insert(schema.householdMembers)
      .values({ householdId: host.householdId, userId: parent.id, role: 'parent' })
      .run();
    const kid = db
      .insert(schema.users)
      .values({ email: 'kid@example.com', emailVerifiedAt: new Date() })
      .returning()
      .get()!;
    db.insert(schema.householdMembers)
      .values({ householdId: host.householdId, userId: kid.id, role: 'student' })
      .run();

    const parentInfo = getOnboardingForUser(parent.id);
    expect(
      adminShouldAutoStartOnboarding({
        role: parentInfo.role,
        onboardingComplete: parentInfo.complete,
        state: parentInfo.state,
      }),
    ).toBe(false);
    const kidInfo = getOnboardingForUser(kid.id);
    expect(
      adminShouldAutoStartOnboarding({
        role: kidInfo.role,
        onboardingComplete: kidInfo.complete,
        state: kidInfo.state,
      }),
    ).toBe(false);
  });
});

const REPO = process.cwd();
const REGISTRARS = ['src/lib/exam/generated-public.ts', 'src/lib/exam/generated-keys.server.ts'];

/**
 * A separate fake checkout (never the real one): committed biology IR,
 * generated JSON and registrars, copied byte for byte.
 */
function fakeCheckout(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'examify-onboarding-checkout-'));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'project-examify' }));
  for (const rel of [
    ...REGISTRARS,
    'content/subjects/biology/bank.ir.json',
    'content/generated/subjects.json',
    'content/generated/questions/biology.json',
    'content/generated/keys/biology.json',
  ]) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    copyFileSync(path.join(REPO, rel), path.join(root, rel));
  }
  return root;
}

/** Relative path → bytes for every file under `dir` (skipping `skip` subtrees). */
function treeBytes(dir: string, skip: readonly string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (abs: string) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const child = path.join(abs, entry.name);
      const rel = path.relative(dir, child);
      if (skip.includes(rel)) continue;
      if (entry.isDirectory()) walk(child);
      else out[rel] = readFileSync(child, 'utf8');
    }
  };
  walk(dir);
  return out;
}

function fileMode(abs: string): number {
  return statSync(abs).mode & 0o777;
}

describe('onboarding writes only the family data folder', () => {
  it('preview + apply against a family root leave a fake checkout byte-for-byte unchanged', async () => {
    const onboarding = await import('@/lib/onboarding');
    const { generateOnboardingSubject } = await import('@/lib/onboarding-generate');
    const { setEnvStoreRootForTests } = await import('@/lib/env-store');
    const checkout = fakeCheckout();
    const outside = mkdtempSync(path.join(tmpdir(), 'examify-onboarding-family-'));

    // The default layout (`<checkout>/data`) and a folder outside the checkout.
    for (const family of [path.join(checkout, 'data'), outside]) {
      onboarding.setOnboardingContentRootForTests(family);
      setEnvStoreRootForTests(checkout);
      const before = treeBytes(checkout, ['data']);

      expect(onboarding.addOnboardingSubject({ id: 'history', label: 'History' }, family).ok).toBe(
        true,
      );
      writeFileSync(path.join(family, 'content/subjects/history/notes.txt'), 'Magna Carta.\n');
      const generated = await generateOnboardingSubject({
        subjectId: 'history',
        provider: 'test',
        seed: 0,
        root: family,
      });
      expect(generated.ok).toBe(true);
      // A leftover generated subject the whole-tree emit prunes.
      seedGenerated(family, 'chemistry');

      const preview = onboarding.previewOnboardingEmit(false, family);
      if (!preview.ok) throw new Error(`expected preview: ${preview.message}`);
      const generatedDir = path.join(family, 'content/generated');
      for (const file of preview.planned) {
        expect(file.relPath.startsWith('content/generated/'), file.relPath).toBe(true);
        expect(file.relPath).not.toMatch(/^src\/|\.\./);
        expect(path.relative(generatedDir, file.absPath).startsWith('..'), file.absPath).toBe(
          false,
        );
      }
      expect(onboarding.isPlanInsideFamilyGenerated(preview.planned, family)).toBe(true);
      expect(preview.dryRun.plan.some((row) => row.path.includes('generated-'))).toBe(false);

      const applied = onboarding.applyOnboardingEmit(
        { replaceSample: false, expectedHash: preview.dryRun.hash, confirmPrune: true },
        family,
      );
      expect(applied.ok).toBe(true);

      expect(treeBytes(checkout, ['data'])).toEqual(before);
      expect(existsSync(path.join(checkout, '.examify-ingest'))).toBe(false);
      expect(existsSync(path.join(family, 'content/subjects/history/bank.ir.json'))).toBe(true);
      expect(existsSync(path.join(checkout, 'content/subjects/history'))).toBe(false);
      expect(Object.keys(treeBytes(generatedDir)).sort()).toEqual([
        'keys/history.json',
        'questions/history.json',
        'subjects.json',
      ]);
      expect(fileMode(path.join(generatedDir, 'keys/history.json'))).toBe(0o600);
      expect(fileMode(path.join(generatedDir, 'keys'))).toBe(0o700);
    }
  });

  it('never plans registrars, even when the family root has some', async () => {
    const { previewOnboardingEmit, applyOnboardingEmit } = await import('@/lib/onboarding');
    const family = tempRoot();
    mkdirSync(path.join(family, 'content/subjects/history'), { recursive: true });
    writeFileSync(
      path.join(family, 'content/subjects/history/bank.ir.json'),
      JSON.stringify(fixtureIr('history', 'History')),
    );
    for (const rel of REGISTRARS) writeFileSync(path.join(family, rel), 'export {}\n');

    const preview = previewOnboardingEmit(false, family);
    if (!preview.ok) throw new Error('expected preview');
    expect(preview.dryRun.plan.map((row) => row.path)).toEqual([
      'content/generated/subjects.json',
      'content/generated/questions/history.json',
      'content/generated/keys/history.json',
    ]);
    expect(
      applyOnboardingEmit({ replaceSample: false, expectedHash: preview.dryRun.hash }, family).ok,
    ).toBe(true);
    for (const rel of REGISTRARS) {
      expect(readFileSync(path.join(family, rel), 'utf8')).toBe('export {}\n');
    }
  });

  it('dry-run lists family subjects that replace a built-in subject', async () => {
    const { previewOnboardingEmit, BUILTIN_SUBJECTS } = await import('@/lib/onboarding');
    expect(BUILTIN_SUBJECTS).toContainEqual({ id: 'biology', label: 'Biology' });
    expect(BUILTIN_SUBJECTS.some((subject) => subject.id === 'history')).toBe(false);

    const family = tempRoot();
    mkdirSync(path.join(family, 'content/subjects/history'), { recursive: true });
    writeFileSync(
      path.join(family, 'content/subjects/history/bank.ir.json'),
      JSON.stringify(fixtureIr('history', 'History')),
    );
    const plain = previewOnboardingEmit(false, family);
    if (!plain.ok) throw new Error('expected preview');
    expect(plain.dryRun.shadows).toEqual([]);

    mkdirSync(path.join(family, 'content/subjects/biology'), { recursive: true });
    const biology = JSON.parse(
      readFileSync(path.join(REPO, 'content/subjects/biology/bank.ir.json'), 'utf8'),
    ) as { subject: { label: string } };
    biology.subject.label = 'Our Biology';
    writeFileSync(
      path.join(family, 'content/subjects/biology/bank.ir.json'),
      JSON.stringify(biology),
    );
    const shadowed = previewOnboardingEmit(false, family);
    if (!shadowed.ok) throw new Error('expected preview');
    expect(shadowed.dryRun.shadows).toEqual([{ id: 'biology', label: 'Biology' }]);
  });

  it('snapshot lists family subjects only, the built-ins and how hints name the folder', async () => {
    const { bootstrapHousehold } = await import('@/lib/households');
    const { getOnboardingSnapshot, onboardingDataDirDisplay } = await import('@/lib/onboarding');
    const host = bootstrapHousehold({ email: 'snap@example.com', householdName: 'Snap' });
    if (!host.ok) throw new Error('bootstrap');
    const family = tempRoot();
    mkdirSync(path.join(family, 'content/subjects/history'), { recursive: true });
    writeFileSync(
      path.join(family, 'content/subjects/history/bank.ir.json'),
      JSON.stringify(fixtureIr('history', 'History')),
    );

    const snap = getOnboardingSnapshot(host.householdId, family);
    expect(snap.subjects.map((row) => row.id)).toEqual(['history']);
    expect(snap.builtinSubjects).toContainEqual({ id: 'biology', label: 'Biology' });
    expect(snap.liveSubjects.map((row) => row.id)).toContain('biology');
    expect(snap.dataDirDisplay).toBe(family);

    expect(onboardingDataDirDisplay(path.join(REPO, 'data'))).toBe('data');
    expect(onboardingDataDirDisplay(path.join(REPO, 'data', 'family'))).toBe('data/family');
  });

  it('isPlanInsideFamilyGenerated accepts only files under <root>/content/generated', async () => {
    const { isPlanInsideFamilyGenerated } = await import('@/lib/onboarding');
    const root = '/srv/examify-data';
    const plan = (...rels: string[]) => rels.map((rel) => ({ absPath: path.join(root, rel) }));
    expect(
      isPlanInsideFamilyGenerated(
        plan('content/generated/subjects.json', 'content/generated/keys/history.json'),
        root,
      ),
    ).toBe(true);
    expect(isPlanInsideFamilyGenerated(plan('src/lib/exam/generated-public.ts'), root)).toBe(false);
    expect(isPlanInsideFamilyGenerated(plan('content/generated'), root)).toBe(false);
    expect(isPlanInsideFamilyGenerated(plan('content/generated-x/a.json'), root)).toBe(false);
    expect(isPlanInsideFamilyGenerated(plan('content/generated/../../app.db'), root)).toBe(false);
    expect(
      isPlanInsideFamilyGenerated([{ absPath: '/srv/checkout/content/generated/a.json' }], root),
    ).toBe(false);
  });

  it('wizard writes refuse a subjects, source-pdfs or subject path linked into the checkout', async () => {
    const onboarding = await import('@/lib/onboarding');
    const checkout = fakeCheckout();
    const tracked = path.join(checkout, 'content');
    const pdf = Buffer.from('%PDF-1.4 fixture');
    mkdirSync(path.join(tracked, 'source-pdfs/biology'), { recursive: true });
    writeFileSync(path.join(tracked, 'source-pdfs/biology/unit.pdf'), pdf);
    const before = treeBytes(tracked);
    const unsafe = { ok: false, reason: 'unsafe_path' };
    const history = { id: 'history', label: 'History', icon: 'geography' };

    // content/subjects is a link to the checkout's subjects.
    const linkedSubjects = tempRoot();
    rmSync(path.join(linkedSubjects, 'content/subjects'), { recursive: true });
    symlinkSync(path.join(tracked, 'subjects'), path.join(linkedSubjects, 'content/subjects'));
    expect(onboarding.addOnboardingSubject(history, linkedSubjects)).toEqual(unsafe);
    expect(
      onboarding.renameOnboardingSubject(
        { id: 'biology', nextId: 'bio', label: 'Bio' },
        linkedSubjects,
      ),
    ).toEqual(unsafe);
    expect(
      onboarding.renameOnboardingSubject({ id: 'biology', label: 'Renamed' }, linkedSubjects),
    ).toEqual(unsafe);
    expect(onboarding.deleteOnboardingSubject('biology', linkedSubjects)).toEqual(unsafe);

    // content/source-pdfs is a link; content/subjects is real.
    const linkedPdfs = tempRoot();
    expect(onboarding.addOnboardingSubject(history, linkedPdfs).ok).toBe(true);
    symlinkSync(path.join(tracked, 'source-pdfs'), path.join(linkedPdfs, 'content/source-pdfs'));
    expect(
      onboarding.attachSourcePdf(
        { subjectId: 'history', filename: 'unit.pdf', bytes: pdf },
        linkedPdfs,
      ),
    ).toEqual(unsafe);
    expect(
      onboarding.detachSourcePdf({ subjectId: 'biology', filename: 'unit.pdf' }, linkedPdfs),
    ).toEqual(unsafe);
    expect(
      onboarding.renameOnboardingSubject(
        { id: 'history', nextId: 'hist', label: 'Hist' },
        linkedPdfs,
      ),
    ).toEqual(unsafe);
    expect(onboarding.deleteOnboardingSubject('history', linkedPdfs)).toEqual(unsafe);
    expect(existsSync(path.join(linkedPdfs, 'content/subjects/history'))).toBe(true);

    // One file of a real subject is a link: its rewrite would go through it.
    const linkedMeta = tempRoot();
    expect(onboarding.addOnboardingSubject(history, linkedMeta).ok).toBe(true);
    const meta = path.join(linkedMeta, 'content/subjects/history/subject.json');
    rmSync(meta);
    symlinkSync(path.join(tracked, 'subjects/biology/bank.ir.json'), meta);
    expect(
      onboarding.renameOnboardingSubject({ id: 'history', label: 'Renamed' }, linkedMeta),
    ).toEqual(unsafe);

    expect(treeBytes(tracked)).toEqual(before);
  });

  it('apply refuses a family content/generated (or keys/) symlinked into the checkout', async () => {
    const { applyOnboardingEmit, isPlanInsideFamilyGenerated, previewOnboardingEmit } =
      await import('@/lib/onboarding');
    const checkout = fakeCheckout();
    const tracked = path.join(checkout, 'content/generated');
    const before = treeBytes(tracked);
    const withHistory = () => {
      const family = tempRoot();
      mkdirSync(path.join(family, 'content/subjects/history'), { recursive: true });
      writeFileSync(
        path.join(family, 'content/subjects/history/bank.ir.json'),
        JSON.stringify(fixtureIr('history', 'History')),
      );
      return family;
    };
    // The whole folder, then only keys/ inside an otherwise real folder.
    const linkedGenerated = withHistory();
    symlinkSync(tracked, path.join(linkedGenerated, 'content/generated'));
    const linkedKeys = withHistory();
    mkdirSync(path.join(linkedKeys, 'content/generated/questions'), { recursive: true });
    symlinkSync(path.join(tracked, 'keys'), path.join(linkedKeys, 'content/generated/keys'));

    for (const family of [linkedGenerated, linkedKeys]) {
      const preview = previewOnboardingEmit(false, family);
      if (!preview.ok) throw new Error(`expected preview: ${preview.message}`);
      expect(isPlanInsideFamilyGenerated(preview.planned, family)).toBe(false);
      expect(
        applyOnboardingEmit(
          { replaceSample: false, expectedHash: preview.dryRun.hash, confirmPrune: true },
          family,
        ),
      ).toEqual({
        ok: false,
        reason: 'invalid',
        message: 'refusing to write outside the family data folder',
      });
      expect(treeBytes(tracked)).toEqual(before);
    }
  });

  it('apply writes a rev for each family row: the hash of the questions + keys it wrote', async () => {
    const { applyOnboardingEmit, previewOnboardingEmit } = await import('@/lib/onboarding');
    const { generatedRevision } = await import('@/lib/exam/generated-revision');
    const { loadLivePublicBank } = await import('@/lib/exam/live-bank.server');
    const family = tempRoot();
    mkdirSync(path.join(family, 'content/subjects/history'), { recursive: true });
    writeFileSync(
      path.join(family, 'content/subjects/history/bank.ir.json'),
      JSON.stringify(fixtureIr('history', 'History')),
    );
    const preview = previewOnboardingEmit(false, family);
    if (!preview.ok) throw new Error('expected preview');
    expect(
      applyOnboardingEmit({ replaceSample: false, expectedHash: preview.dryRun.hash }, family).ok,
    ).toBe(true);
    const generated = path.join(family, 'content/generated');
    const catalog = JSON.parse(readFileSync(path.join(generated, 'subjects.json'), 'utf8')) as {
      id: string;
      rev?: string;
    }[];
    expect(catalog).toEqual([
      expect.objectContaining({
        id: 'history',
        rev: generatedRevision(
          readFileSync(path.join(generated, 'questions/history.json'), 'utf8'),
          readFileSync(path.join(generated, 'keys/history.json'), 'utf8'),
        ),
      }),
    ]);
    expect(loadLivePublicBank(family).subjects.map((subject) => subject.id)).toContain('history');
    // The Subject shape never carries it.
    expect(loadLivePublicBank(family).subjects.find((s) => s.id === 'history')).not.toHaveProperty(
      'rev',
    );
  });

  it('apply refuses a plan that would write outside the family data folder', async () => {
    vi.resetModules();
    vi.doMock('examify-ingest', async (importOriginal) => {
      const actual = await importOriginal<typeof import('examify-ingest')>();
      return {
        ...actual,
        planEmit: (...args: Parameters<typeof actual.planEmit>) => {
          const root = args[1];
          const rel = 'src/lib/exam/generated-public.ts';
          return [
            ...actual.planEmit(...args),
            { relPath: rel, absPath: path.join(root, rel), contents: 'x', existing: null },
          ];
        },
      };
    });
    try {
      const { applyOnboardingEmit, previewOnboardingEmit } = await import('@/lib/onboarding');
      const family = tempRoot();
      mkdirSync(path.join(family, 'content/subjects/history'), { recursive: true });
      writeFileSync(
        path.join(family, 'content/subjects/history/bank.ir.json'),
        JSON.stringify(fixtureIr('history', 'History')),
      );
      const preview = previewOnboardingEmit(false, family);
      if (!preview.ok) throw new Error('expected preview');
      expect(
        applyOnboardingEmit({ replaceSample: false, expectedHash: preview.dryRun.hash }, family),
      ).toEqual({
        ok: false,
        reason: 'invalid',
        message: 'refusing to write outside the family data folder',
      });
      expect(existsSync(path.join(family, 'content/generated'))).toBe(false);
      expect(existsSync(path.join(family, 'src/lib/exam/generated-public.ts'))).toBe(false);
    } finally {
      vi.doUnmock('examify-ingest');
      vi.resetModules();
    }
  });
});
