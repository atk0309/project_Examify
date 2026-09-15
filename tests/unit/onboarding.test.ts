import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  it('refuses an empty subjects tree and does not wipe generated files', async () => {
    const { previewOnboardingEmit, applyOnboardingEmit, setOnboardingContentRootForTests } =
      await import('@/lib/onboarding');
    const root = tempRoot();
    mkdirSync(path.join(root, 'content/subjects/history'), { recursive: true });
    const leftover = seedGenerated(root);
    setOnboardingContentRootForTests(root);

    const preview = previewOnboardingEmit(false, root);
    expect(preview.ok).toBe(false);
    if (preview.ok) throw new Error('expected refuse');
    expect(preview.reason).toBe('empty_catalog');
    expect(preview.message).toBe(EMPTY_AUTHORITATIVE_EMIT);
    expect(preview.message).toMatch(/will not wipe generated content/);

    const applied = applyOnboardingEmit({ replaceSample: false, expectedHash: 'unused' }, root);
    expect(applied.ok).toBe(false);
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

    const applied = applyOnboardingEmit(
      { replaceSample: false, expectedHash: preview.dryRun.hash },
      root,
    );
    expect(applied.ok).toBe(true);
    expect(existsSync(leftover.questionsPath)).toBe(false);
    expect(existsSync(leftover.keysPath)).toBe(false);
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
    expect(listOnboardingSubjects(root).map((row) => row.id)).toEqual(['history']);
    expect(existsSync(path.join(root, 'content/subjects/history/bank.ir.json'))).toBe(true);

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
    expect(existsSync(path.join(root, 'content/subjects/history/bank.ir.json'))).toBe(true);
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

  it('delete of the last IR subject refuses wipe and leaves generated files', async () => {
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
    expect(preview.ok).toBe(false);
    if (preview.ok) throw new Error('expected refuse');
    expect(preview.reason).toBe('empty_catalog');
    expect(preview.message).toMatch(/will not wipe generated content/);
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
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
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
