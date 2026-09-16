import fs from 'node:fs';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionData } from '@/lib/auth';
import { EMPTY_AUTHORITATIVE_EMIT } from '@/lib/onboarding-types';

const TMP = path.join(process.cwd(), 'tests', '.tmp');
const DB_PATH = path.join(TMP, `onboarding-actions-${process.pid}.db`);
Reflect.set(process.env, 'DATABASE_URL', `file:${DB_PATH}`);
delete process.env.FAMILIES;

const sessionHolder = vi.hoisted(() => ({
  current: {} as SessionData & { save: () => Promise<void> },
}));

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return {
    ...actual,
    getRawSession: async () => sessionHolder.current,
    getSession: async () => sessionHolder.current,
  };
});

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-real-ip': '203.0.113.69' }),
}));

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error(`NEXT_REDIRECT:${url}`), { url });
  },
}));

function populatedIr(id = 'history', label = 'History') {
  return {
    version: 1,
    subject: { id, label, icon: 'geography', l: 0.6, c: 0.08, h: 40 },
    difficulties: {
      easy: [
        {
          id: `${id}-easy-1`,
          type: 'mcq',
          q: 'A prior question?',
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

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'examify-onboarding-act-'));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'project-examify' }));
  fs.mkdirSync(path.join(root, 'content/subjects'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/lib/exam'), { recursive: true });
  return root;
}

beforeAll(() => {
  fs.mkdirSync(TMP, { recursive: true });
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
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
  const { resetLegacyImportLatch } = await import('@/lib/households');
  db.delete(schema.rateLimitEvents).run();
  db.delete(schema.householdMembers).run();
  db.delete(schema.households).run();
  db.delete(schema.users).run();
  resetLegacyImportLatch();
  sessionHolder.current = { save: vi.fn(async () => {}) };
  const { setOnboardingContentRootForTests } = await import('@/lib/onboarding');
  setOnboardingContentRootForTests(null);
});

afterEach(async () => {
  const { setOnboardingContentRootForTests } = await import('@/lib/onboarding');
  const { resetOnboardingGenerateForTests } = await import('@/lib/onboarding-generate');
  const { setEnvStoreRootForTests, setInitialEnvironForTests } = await import('@/lib/env-store');
  setOnboardingContentRootForTests(null);
  setEnvStoreRootForTests(null);
  setInitialEnvironForTests(null);
  resetOnboardingGenerateForTests();
  vi.restoreAllMocks();
});

async function signInHost() {
  const { bootstrapHousehold } = await import('@/lib/households');
  const host = bootstrapHousehold({ email: 'pat@example.com', householdName: 'Ours' });
  if (!host.ok) throw new Error('bootstrap');
  sessionHolder.current.userId = host.userId;
  sessionHolder.current.role = 'parent';
  sessionHolder.current.email = host.email;
  sessionHolder.current.studentMode = false;
  return host;
}

describe('onboarding actions', () => {
  it('refuses mutations without an admin session', async () => {
    const {
      addOnboardingSubjectAction,
      applyOnboardingEmitAction,
      cancelOnboardingGenerateAction,
      generateOnboardingSubjectAction,
      setOnboardingAnthropicKeyAction,
      setOnboardingOpenAiKeyAction,
    } = await import('@/actions/onboarding');
    const data = new FormData();
    data.set('id', 'history');
    data.set('label', 'History');
    data.set('icon', 'geography');
    expect(await addOnboardingSubjectAction(data)).toEqual({ ok: false, reason: 'forbidden' });
    expect(await applyOnboardingEmitAction()).toEqual({ ok: false, reason: 'forbidden' });
    const generate = new FormData();
    generate.set('subjectId', 'history');
    expect(await generateOnboardingSubjectAction(generate)).toEqual({
      ok: false,
      reason: 'forbidden',
    });
    const cancel = new FormData();
    cancel.set('cancelToken', 'cancel-token-01');
    expect(await cancelOnboardingGenerateAction(cancel)).toEqual({
      ok: false,
      reason: 'forbidden',
    });
    const openai = new FormData();
    openai.set('intent', 'set');
    openai.set('openaiApiKey', 'sk-should-not-write');
    expect(await setOnboardingOpenAiKeyAction(openai)).toEqual({ ok: false, reason: 'forbidden' });
    const anthropic = new FormData();
    anthropic.set('intent', 'set');
    anthropic.set('anthropicApiKey', 'sk-should-not-write');
    expect(await setOnboardingAnthropicKeyAction(anthropic)).toEqual({
      ok: false,
      reason: 'forbidden',
    });
  });

  it('refuses apply before a dry-run preview', async () => {
    const root = tempRoot();
    const { setOnboardingContentRootForTests } = await import('@/lib/onboarding');
    setOnboardingContentRootForTests(root);
    await signInHost();
    const { applyOnboardingEmitAction } = await import('@/actions/onboarding');
    expect(await applyOnboardingEmitAction()).toEqual({ ok: false, reason: 'dry_run_required' });
  });

  it('refuses an empty catalog emit with the CLI copy', async () => {
    const root = tempRoot();
    const { setOnboardingContentRootForTests } = await import('@/lib/onboarding');
    setOnboardingContentRootForTests(root);
    await signInHost();
    const { previewOnboardingEmitAction, applyOnboardingEmitAction } =
      await import('@/actions/onboarding');
    const preview = await previewOnboardingEmitAction();
    expect(preview.ok).toBe(false);
    if (preview.ok) throw new Error('expected empty refuse');
    expect(preview.reason).toBe('empty_catalog');
    expect(preview.message).toBe(EMPTY_AUTHORITATIVE_EMIT);
    expect(await applyOnboardingEmitAction()).toEqual({ ok: false, reason: 'dry_run_required' });
  });

  it('applies emit only after a matching dry-run', async () => {
    const root = tempRoot();
    const { setOnboardingContentRootForTests } = await import('@/lib/onboarding');
    setOnboardingContentRootForTests(root);
    await signInHost();
    fs.mkdirSync(path.join(root, 'content/subjects/history'), { recursive: true });
    writeFileSync(
      path.join(root, 'content/subjects/history/bank.ir.json'),
      JSON.stringify({
        version: 1,
        subject: { id: 'history', label: 'History', icon: 'geography', l: 0.6, c: 0.08, h: 40 },
        difficulties: {
          easy: [
            {
              id: 'history-easy-1',
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
      }),
    );
    const { previewOnboardingEmitAction, applyOnboardingEmitAction } =
      await import('@/actions/onboarding');
    const preview = await previewOnboardingEmitAction();
    expect(preview.ok).toBe(true);
    if (!preview.ok) throw new Error('expected dry-run');
    expect(JSON.stringify(preview.dryRun)).not.toContain('"answer"');
    expect(JSON.stringify(preview.dryRun)).not.toContain('hand-authored');
    expect(preview.dryRun.diff).toMatch(
      /would create content\/generated\/questions\/history\.json/,
    );
    expect(preview.dryRun.diff).toContain('would create content/generated/keys/history.json');
    const applied = await applyOnboardingEmitAction();
    expect(applied.ok).toBe(true);
    expect(fs.existsSync(path.join(root, 'content/generated/questions/history.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'content/generated/keys/history.json'))).toBe(true);

    const { loadLiveAnswerKeys, loadLivePublicBank } = await import('@/lib/exam/live-bank.server');
    const { SUBJECTS } = await import('@/lib/exam/data');
    const live = loadLivePublicBank();
    expect(live.subjects.some((subject) => subject.id === 'history')).toBe(true);
    expect(SUBJECTS.some((subject) => subject.id === 'history')).toBe(false);
    expect(live.questions.history?.easy?.[0]?.id).toBe('history-easy-1');
    expect(loadLiveAnswerKeys()['history-easy-1']?.type).toBe('mcq');
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error('expected apply');
    expect(
      applied.snapshot.liveSubjects.some((row) => row.id === 'history' && row.label === 'History'),
    ).toBe(true);
  });

  it('refuses apply prune without confirm and writes nothing', async () => {
    const root = tempRoot();
    const { setOnboardingContentRootForTests } = await import('@/lib/onboarding');
    setOnboardingContentRootForTests(root);
    await signInHost();
    fs.mkdirSync(path.join(root, 'content/subjects/history'), { recursive: true });
    fs.mkdirSync(path.join(root, 'content/generated/questions'), { recursive: true });
    fs.mkdirSync(path.join(root, 'content/generated/keys'), { recursive: true });
    writeFileSync(
      path.join(root, 'content/subjects/history/bank.ir.json'),
      JSON.stringify({
        version: 1,
        subject: { id: 'history', label: 'History', icon: 'geography', l: 0.6, c: 0.08, h: 40 },
        difficulties: {
          easy: [
            {
              id: 'history-easy-1',
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
      }),
    );
    writeFileSync(
      path.join(root, 'content/generated/subjects.json'),
      JSON.stringify([
        { id: 'chemistry', label: 'Chemistry', icon: 'chemistry', l: 0.6, c: 0.1, h: 30 },
      ]),
    );
    writeFileSync(path.join(root, 'content/generated/questions/chemistry.json'), '{}\n');
    writeFileSync(path.join(root, 'content/generated/keys/chemistry.json'), '{}\n');
    const { previewOnboardingEmitAction, applyOnboardingEmitAction } =
      await import('@/actions/onboarding');
    expect((await previewOnboardingEmitAction()).ok).toBe(true);
    const refused = await applyOnboardingEmitAction();
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('expected prune confirm');
    expect(refused.reason).toBe('prune_confirm_required');
    expect(refused.message).toMatch(/chemistry/);
    expect(fs.existsSync(path.join(root, 'content/generated/questions/chemistry.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'content/generated/keys/chemistry.json'))).toBe(true);

    const data = new FormData();
    data.set('confirmPrune', '1');
    const applied = await applyOnboardingEmitAction(data);
    expect(applied.ok).toBe(true);
    expect(fs.existsSync(path.join(root, 'content/generated/questions/chemistry.json'))).toBe(
      false,
    );
  });

  it('validates with the persisted replace-sample setting', async () => {
    const root = tempRoot();
    const { setOnboardingContentRootForTests } = await import('@/lib/onboarding');
    setOnboardingContentRootForTests(root);
    await signInHost();
    const { collectQuestionIds } = await import('examify-ingest');
    const { SAMPLE_QUESTIONS } = await import('@/lib/exam/data');
    const collision = collectQuestionIds(SAMPLE_QUESTIONS).find((id) =>
      /^maths-easy-\d+$/.test(id),
    );
    expect(collision).toBeTruthy();
    fs.mkdirSync(path.join(root, 'content/subjects/maths'), { recursive: true });
    writeFileSync(
      path.join(root, 'content/subjects/maths/bank.ir.json'),
      JSON.stringify({
        version: 1,
        subject: { id: 'maths', label: 'Maths', icon: 'maths', l: 0.585, c: 0.062, h: 156 },
        difficulties: {
          easy: [
            {
              id: collision,
              type: 'mcq',
              q: 'A colliding question?',
              choices: ['A', 'B', 'C', 'D'],
              answer: 1,
              provenance: { pdf: 'hand-authored', locator: 'unit' },
            },
          ],
          medium: [],
          hard: [],
        },
      }),
    );
    const { setReplaceSampleAction, validateOnboardingAction } =
      await import('@/actions/onboarding');
    const blocked = await validateOnboardingAction();
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error('expected collision');
    expect(blocked.reason).toBe('invalid');

    const toggle = new FormData();
    toggle.set('replaceSample', '1');
    expect((await setReplaceSampleAction(toggle)).ok).toBe(true);
    expect((await validateOnboardingAction()).ok).toBe(true);
  });

  it('does not apply a changed plan after a confirmed dry-run', async () => {
    const root = tempRoot();
    const { setOnboardingContentRootForTests } = await import('@/lib/onboarding');
    setOnboardingContentRootForTests(root);
    await signInHost();
    const irDir = path.join(root, 'content/subjects/history');
    fs.mkdirSync(irDir, { recursive: true });
    const confirmed = {
      version: 1,
      subject: { id: 'history', label: 'History', icon: 'geography', l: 0.6, c: 0.08, h: 40 },
      difficulties: {
        easy: [
          {
            id: 'history-easy-1',
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
    writeFileSync(path.join(irDir, 'bank.ir.json'), JSON.stringify(confirmed));
    const { previewOnboardingEmitAction, applyOnboardingEmitAction } =
      await import('@/actions/onboarding');
    const preview = await previewOnboardingEmitAction();
    expect(preview.ok).toBe(true);

    writeFileSync(
      path.join(irDir, 'bank.ir.json'),
      JSON.stringify({
        ...confirmed,
        difficulties: {
          ...confirmed.difficulties,
          easy: [
            {
              ...confirmed.difficulties.easy[0],
              id: 'history-easy-2',
              q: 'An unconfirmed question?',
            },
          ],
        },
      }),
    );

    expect(await applyOnboardingEmitAction()).toEqual({
      ok: false,
      reason: 'stale_preview',
      message: 'Subjects or BankIR changed since the last dry-run. Preview again.',
    });
    expect(fs.existsSync(path.join(root, 'content/generated/questions/history.json'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'content/generated/keys/history.json'))).toBe(false);
  });

  it('refuses finish before a confirmed apply; skip is the no-emit exit', async () => {
    const host = await signInHost();
    const { finishOnboardingAction, skipOnboardingAction } = await import('@/actions/onboarding');
    expect(await finishOnboardingAction()).toEqual({ ok: false, reason: 'emit_required' });

    await expect(skipOnboardingAction()).rejects.toThrow(/NEXT_REDIRECT:\//);
    const { getHouseholdOnboarding } = await import('@/lib/onboarding');
    const skipped = getHouseholdOnboarding(host.householdId);
    expect(skipped.complete).toBe(false);
    expect(skipped.state.skipped).toBe(true);
    expect(skipped.state.applied).toBe(false);
  });

  it('finishes only after a confirmed apply', async () => {
    const root = tempRoot();
    const { setOnboardingContentRootForTests } = await import('@/lib/onboarding');
    setOnboardingContentRootForTests(root);
    const host = await signInHost();
    fs.mkdirSync(path.join(root, 'content/subjects/history'), { recursive: true });
    writeFileSync(
      path.join(root, 'content/subjects/history/bank.ir.json'),
      JSON.stringify({
        version: 1,
        subject: { id: 'history', label: 'History', icon: 'geography', l: 0.6, c: 0.08, h: 40 },
        difficulties: {
          easy: [
            {
              id: 'history-easy-1',
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
      }),
    );
    const { previewOnboardingEmitAction, applyOnboardingEmitAction, finishOnboardingAction } =
      await import('@/actions/onboarding');
    expect((await previewOnboardingEmitAction()).ok).toBe(true);
    expect((await applyOnboardingEmitAction()).ok).toBe(true);
    const { getHouseholdOnboarding } = await import('@/lib/onboarding');
    expect(getHouseholdOnboarding(host.householdId).state.applied).toBe(true);
    await expect(finishOnboardingAction()).rejects.toThrow(/NEXT_REDIRECT:\//);
    expect(getHouseholdOnboarding(host.householdId).complete).toBe(true);
  });

  it('generates BankIR without emit/apply and stays admin-only', async () => {
    const root = tempRoot();
    const { setOnboardingContentRootForTests } = await import('@/lib/onboarding');
    setOnboardingContentRootForTests(root);
    const host = await signInHost();
    fs.mkdirSync(path.join(root, 'content/subjects/history'), { recursive: true });
    fs.mkdirSync(path.join(root, 'content/source-pdfs/history'), { recursive: true });
    fs.mkdirSync(path.join(root, 'content/generated/questions'), { recursive: true });
    writeFileSync(
      path.join(root, 'content/subjects/history/bank.ir.json'),
      JSON.stringify({
        version: 1,
        subject: { id: 'history', label: 'History', icon: 'geography', l: 0.6, c: 0.08, h: 40 },
        difficulties: { easy: [], medium: [], hard: [] },
      }),
    );
    writeFileSync(path.join(root, 'content/source-pdfs/history/notes.txt'), 'A source note.\n');
    writeFileSync(path.join(root, 'content/generated/subjects.json'), '[]\n');
    writeFileSync(path.join(root, 'content/generated/questions/biology.json'), '{}\n');

    const { generateOnboardingSubjectAction, setOnboardingAiModeAction, validateOnboardingAction } =
      await import('@/actions/onboarding');
    expect(await generateOnboardingSubjectAction(new FormData())).toEqual({
      ok: false,
      reason: 'invalid_id',
    });
    const missingMode = new FormData();
    missingMode.set('subjectId', 'history');
    expect(await generateOnboardingSubjectAction(missingMode)).toEqual({
      ok: false,
      reason: 'missing_provider',
    });

    const { saveOnboardingState } = await import('@/lib/onboarding');
    saveOnboardingState(host.householdId, {
      dryRunHash: 'stale-before-generate',
      applied: true,
    });

    const mode = new FormData();
    mode.set('aiMode', 'skip-stub');
    expect((await setOnboardingAiModeAction(mode)).ok).toBe(true);
    const generate = new FormData();
    generate.set('subjectId', 'history');
    generate.set('seed', '0');
    generate.set('force', '1');
    const result = await generateOnboardingSubjectAction(generate);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected generate');
    expect(result.result.provider).toBe('test');
    expect(result.result.cacheHit).toBeTypeOf('boolean');
    expect(JSON.stringify(result)).not.toMatch(/"answer"/);
    expect(JSON.stringify(result)).not.toMatch(/"rubric"/);
    expect(fs.existsSync(path.join(root, 'content/generated/questions/history.json'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'content/generated/subjects.json'), 'utf8')).toBe(
      '[]\n',
    );
    expect(result.snapshot.hasDryRun).toBe(false);
    expect(result.snapshot.hasApplied).toBe(false);
    expect(result.result.overwrite).toBe(false);
    expect((await validateOnboardingAction()).ok).toBe(true);
  });

  it('refuses to clobber existing IR without force and names the overwrite', async () => {
    const root = tempRoot();
    const { setOnboardingContentRootForTests } = await import('@/lib/onboarding');
    setOnboardingContentRootForTests(root);
    await signInHost();
    const irPath = path.join(root, 'content/subjects/history/bank.ir.json');
    fs.mkdirSync(path.join(root, 'content/subjects/history'), { recursive: true });
    fs.mkdirSync(path.join(root, 'content/source-pdfs/history'), { recursive: true });
    const prior = `${JSON.stringify(populatedIr())}\n`;
    writeFileSync(irPath, prior);
    writeFileSync(path.join(root, 'content/source-pdfs/history/notes.txt'), 'A source note.\n');

    const { generateOnboardingSubjectAction, setOnboardingAiModeAction } =
      await import('@/actions/onboarding');
    const mode = new FormData();
    mode.set('aiMode', 'skip-stub');
    expect((await setOnboardingAiModeAction(mode)).ok).toBe(true);
    const generate = new FormData();
    generate.set('subjectId', 'history');
    const result = await generateOnboardingSubjectAction(generate);
    expect(result).toEqual({
      ok: false,
      reason: 'needs_confirm',
      irRel: 'content/subjects/history/bank.ir.json',
    });
    expect(JSON.stringify(result)).not.toMatch(/--force/);
    expect(fs.readFileSync(irPath, 'utf8')).toBe(prior);
  });

  it('keeps prior IR bytes when overwrite is skipped', async () => {
    const root = tempRoot();
    const { setOnboardingContentRootForTests } = await import('@/lib/onboarding');
    setOnboardingContentRootForTests(root);
    await signInHost();
    const irPath = path.join(root, 'content/subjects/history/bank.ir.json');
    fs.mkdirSync(path.join(root, 'content/subjects/history'), { recursive: true });
    fs.mkdirSync(path.join(root, 'content/source-pdfs/history'), { recursive: true });
    const prior = `${JSON.stringify(populatedIr())}\n`;
    writeFileSync(irPath, prior);
    writeFileSync(path.join(root, 'content/source-pdfs/history/notes.txt'), 'A source note.\n');

    const { generateOnboardingSubjectAction, setOnboardingAiModeAction } =
      await import('@/actions/onboarding');
    const mode = new FormData();
    mode.set('aiMode', 'skip-stub');
    expect((await setOnboardingAiModeAction(mode)).ok).toBe(true);
    const generate = new FormData();
    generate.set('subjectId', 'history');
    generate.set('overwrite', 'skip');
    expect(await generateOnboardingSubjectAction(generate)).toEqual({
      ok: false,
      reason: 'skipped',
    });
    expect(fs.readFileSync(irPath, 'utf8')).toBe(prior);
  });

  it('refuses generate for a kebab-case id that is not in the wizard catalog', async () => {
    const root = tempRoot();
    const { setOnboardingContentRootForTests } = await import('@/lib/onboarding');
    setOnboardingContentRootForTests(root);
    await signInHost();
    fs.mkdirSync(path.join(root, 'content/subjects/history'), { recursive: true });
    fs.mkdirSync(path.join(root, 'content/source-pdfs/history'), { recursive: true });
    fs.mkdirSync(path.join(root, 'content/source-pdfs/rogue-id'), { recursive: true });
    writeFileSync(
      path.join(root, 'content/subjects/history/bank.ir.json'),
      JSON.stringify({
        version: 1,
        subject: { id: 'history', label: 'History', icon: 'geography', l: 0.6, c: 0.08, h: 40 },
        difficulties: { easy: [], medium: [], hard: [] },
      }),
    );
    writeFileSync(path.join(root, 'content/source-pdfs/history/notes.txt'), 'A source note.\n');
    writeFileSync(path.join(root, 'content/source-pdfs/rogue-id/notes.txt'), 'Foreign source.\n');

    const { generateOnboardingSubjectAction, setOnboardingAiModeAction } =
      await import('@/actions/onboarding');
    const mode = new FormData();
    mode.set('aiMode', 'skip-stub');
    expect((await setOnboardingAiModeAction(mode)).ok).toBe(true);
    const generate = new FormData();
    generate.set('subjectId', 'rogue-id');
    expect(await generateOnboardingSubjectAction(generate)).toEqual({
      ok: false,
      reason: 'missing',
    });
    expect(fs.existsSync(path.join(root, 'content/subjects/rogue-id/bank.ir.json'))).toBe(false);
  });

  it('does not replace prior IR when cancel wins before commit', async () => {
    const root = tempRoot();
    const { setOnboardingContentRootForTests } = await import('@/lib/onboarding');
    setOnboardingContentRootForTests(root);
    await signInHost();
    const irPath = path.join(root, 'content/subjects/history/bank.ir.json');
    fs.mkdirSync(path.join(root, 'content/subjects/history'), { recursive: true });
    fs.mkdirSync(path.join(root, 'content/source-pdfs/history'), { recursive: true });
    const prior = `${JSON.stringify({
      version: 1,
      subject: { id: 'history', label: 'History', icon: 'geography', l: 0.6, c: 0.08, h: 40 },
      difficulties: {
        easy: [
          {
            id: 'history-easy-prior',
            type: 'mcq',
            q: 'Prior IR that cancel must keep?',
            choices: ['A', 'B', 'C', 'D'],
            answer: 0,
            provenance: { pdf: 'hand-authored', locator: 'unit' },
          },
        ],
        medium: [],
        hard: [],
      },
    })}\n`;
    writeFileSync(irPath, prior);
    writeFileSync(path.join(root, 'content/source-pdfs/history/notes.txt'), 'A source note.\n');

    const {
      cancelOnboardingGenerateAction,
      generateOnboardingSubjectAction,
      setOnboardingAiModeAction,
    } = await import('@/actions/onboarding');
    const mode = new FormData();
    mode.set('aiMode', 'skip-stub');
    expect((await setOnboardingAiModeAction(mode)).ok).toBe(true);

    const token = 'cancel-token-01';
    const cancel = new FormData();
    cancel.set('cancelToken', token);
    expect(await cancelOnboardingGenerateAction(cancel)).toEqual({ ok: true });
    const generate = new FormData();
    generate.set('subjectId', 'history');
    generate.set('cancelToken', token);
    expect(await generateOnboardingSubjectAction(generate)).toEqual({
      ok: false,
      reason: 'cancelled',
    });
    expect(fs.readFileSync(irPath, 'utf8')).toBe(prior);
  });

  it('lets the admin mark an in-flight generate cancelled', async () => {
    await signInHost();
    const { cancelOnboardingGenerateAction } = await import('@/actions/onboarding');
    expect(await cancelOnboardingGenerateAction(new FormData())).toEqual({
      ok: false,
      reason: 'invalid',
    });
    const cancel = new FormData();
    cancel.set('cancelToken', 'cancel-token-01');
    expect(await cancelOnboardingGenerateAction(cancel)).toEqual({ ok: true });
  });

  it('returns cancelled and leaves prior IR unchanged when cancel lands before commit', async () => {
    const root = tempRoot();
    const { setOnboardingContentRootForTests } = await import('@/lib/onboarding');
    setOnboardingContentRootForTests(root);
    await signInHost();
    const irPath = path.join(root, 'content/subjects/history/bank.ir.json');
    fs.mkdirSync(path.join(root, 'content/subjects/history'), { recursive: true });
    fs.mkdirSync(path.join(root, 'content/source-pdfs/history'), { recursive: true });
    const prior = `${JSON.stringify({
      version: 1,
      subject: { id: 'history', label: 'History', icon: 'geography', l: 0.6, c: 0.08, h: 40 },
      difficulties: { easy: [], medium: [], hard: [] },
    })}\n`;
    writeFileSync(irPath, prior);
    writeFileSync(path.join(root, 'content/source-pdfs/history/notes.txt'), 'A source note.\n');

    const ingest = await import('examify-ingest/generate');
    const { generateSubject: actualGenerateSubject } =
      await vi.importActual<typeof ingest>('examify-ingest/generate');
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(ingest, 'generateSubject').mockImplementation(async (request) => {
      await blocked;
      return actualGenerateSubject(request);
    });

    const {
      cancelOnboardingGenerateAction,
      generateOnboardingSubjectAction,
      setOnboardingAiModeAction,
    } = await import('@/actions/onboarding');
    const mode = new FormData();
    mode.set('aiMode', 'skip-stub');
    expect((await setOnboardingAiModeAction(mode)).ok).toBe(true);

    const token = 'cancel-token-01';
    const generate = new FormData();
    generate.set('subjectId', 'history');
    generate.set('cancelToken', token);
    generate.set('force', '1');
    const pending = generateOnboardingSubjectAction(generate);
    await vi.waitFor(() => {
      expect(ingest.generateSubject).toHaveBeenCalled();
    });
    const cancel = new FormData();
    cancel.set('cancelToken', token);
    expect(await cancelOnboardingGenerateAction(cancel)).toEqual({ ok: true });
    release();
    expect(await pending).toEqual({ ok: false, reason: 'cancelled' });
    expect(fs.readFileSync(irPath, 'utf8')).toBe(prior);
  });

  it('waits on the generate lock before deleting the active subject', async () => {
    const root = tempRoot();
    const { setOnboardingContentRootForTests } = await import('@/lib/onboarding');
    setOnboardingContentRootForTests(root);
    await signInHost();
    const subjectDir = path.join(root, 'content/subjects/history');
    fs.mkdirSync(subjectDir, { recursive: true });
    fs.mkdirSync(path.join(root, 'content/source-pdfs/history'), { recursive: true });
    writeFileSync(
      path.join(subjectDir, 'bank.ir.json'),
      JSON.stringify({
        version: 1,
        subject: { id: 'history', label: 'History', icon: 'geography', l: 0.6, c: 0.08, h: 40 },
        difficulties: { easy: [], medium: [], hard: [] },
      }),
    );
    writeFileSync(path.join(root, 'content/source-pdfs/history/notes.txt'), 'A source note.\n');

    const ingest = await import('examify-ingest/generate');
    const { generateSubject: actualGenerateSubject } =
      await vi.importActual<typeof ingest>('examify-ingest/generate');
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(ingest, 'generateSubject').mockImplementation(async (request) => {
      await blocked;
      return actualGenerateSubject(request);
    });

    const {
      deleteOnboardingSubjectAction,
      generateOnboardingSubjectAction,
      setOnboardingAiModeAction,
    } = await import('@/actions/onboarding');
    const mode = new FormData();
    mode.set('aiMode', 'skip-stub');
    expect((await setOnboardingAiModeAction(mode)).ok).toBe(true);

    const generate = new FormData();
    generate.set('subjectId', 'history');
    generate.set('force', '1');
    const pendingGenerate = generateOnboardingSubjectAction(generate);
    await vi.waitFor(() => {
      expect(ingest.generateSubject).toHaveBeenCalled();
    });

    let deleteSettled = false;
    const remove = new FormData();
    remove.set('id', 'history');
    const pendingDelete = deleteOnboardingSubjectAction(remove).then((result) => {
      deleteSettled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(deleteSettled).toBe(false);
    expect(fs.existsSync(subjectDir)).toBe(true);

    release();
    expect((await pendingGenerate).ok).toBe(true);
    expect((await pendingDelete).ok).toBe(true);
    expect(deleteSettled).toBe(true);
    expect(fs.existsSync(subjectDir)).toBe(false);
  });

  it('re-checks onboarding access after waiting for the generate lock', async () => {
    const root = tempRoot();
    const { completeOnboarding, setOnboardingContentRootForTests } =
      await import('@/lib/onboarding');
    setOnboardingContentRootForTests(root);
    const host = await signInHost();
    const subjectDir = path.join(root, 'content/subjects/history');
    fs.mkdirSync(subjectDir, { recursive: true });
    fs.mkdirSync(path.join(root, 'content/source-pdfs/history'), { recursive: true });
    writeFileSync(
      path.join(subjectDir, 'bank.ir.json'),
      JSON.stringify({
        version: 1,
        subject: { id: 'history', label: 'History', icon: 'geography', l: 0.6, c: 0.08, h: 40 },
        difficulties: { easy: [], medium: [], hard: [] },
      }),
    );
    writeFileSync(path.join(root, 'content/source-pdfs/history/notes.txt'), 'A source note.\n');

    const ingest = await import('examify-ingest/generate');
    const { generateSubject: actualGenerateSubject } =
      await vi.importActual<typeof ingest>('examify-ingest/generate');
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(ingest, 'generateSubject').mockImplementation(async (request) => {
      await blocked;
      return actualGenerateSubject(request);
    });

    const {
      deleteOnboardingSubjectAction,
      generateOnboardingSubjectAction,
      setOnboardingAiModeAction,
    } = await import('@/actions/onboarding');
    const mode = new FormData();
    mode.set('aiMode', 'skip-stub');
    expect((await setOnboardingAiModeAction(mode)).ok).toBe(true);

    const generate = new FormData();
    generate.set('subjectId', 'history');
    generate.set('force', '1');
    const pendingGenerate = generateOnboardingSubjectAction(generate);
    await vi.waitFor(() => {
      expect(ingest.generateSubject).toHaveBeenCalled();
    });

    const remove = new FormData();
    remove.set('id', 'history');
    const pendingDelete = deleteOnboardingSubjectAction(remove);
    await new Promise((resolve) => setTimeout(resolve, 40));
    completeOnboarding(host.householdId);
    release();
    expect((await pendingGenerate).ok).toBe(true);
    expect(await pendingDelete).toEqual({ ok: false, reason: 'already_complete' });
    expect(fs.existsSync(subjectDir)).toBe(true);
  });

  it('marks cancel via the concurrent route while generate is in flight', async () => {
    const root = tempRoot();
    const { setOnboardingContentRootForTests } = await import('@/lib/onboarding');
    setOnboardingContentRootForTests(root);
    await signInHost();
    const irPath = path.join(root, 'content/subjects/history/bank.ir.json');
    fs.mkdirSync(path.join(root, 'content/subjects/history'), { recursive: true });
    fs.mkdirSync(path.join(root, 'content/source-pdfs/history'), { recursive: true });
    const prior = `${JSON.stringify({
      version: 1,
      subject: { id: 'history', label: 'History', icon: 'geography', l: 0.6, c: 0.08, h: 40 },
      difficulties: { easy: [], medium: [], hard: [] },
    })}\n`;
    writeFileSync(irPath, prior);
    writeFileSync(path.join(root, 'content/source-pdfs/history/notes.txt'), 'A source note.\n');

    const ingest = await import('examify-ingest/generate');
    const { generateSubject: actualGenerateSubject } =
      await vi.importActual<typeof ingest>('examify-ingest/generate');
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(ingest, 'generateSubject').mockImplementation(async (request) => {
      await blocked;
      return actualGenerateSubject(request);
    });

    const { generateOnboardingSubjectAction, setOnboardingAiModeAction } =
      await import('@/actions/onboarding');
    const { POST } = await import('@/app/api/onboarding/cancel-generate/route');
    const mode = new FormData();
    mode.set('aiMode', 'skip-stub');
    expect((await setOnboardingAiModeAction(mode)).ok).toBe(true);

    const token = 'cancel-token-01';
    const generate = new FormData();
    generate.set('subjectId', 'history');
    generate.set('cancelToken', token);
    generate.set('force', '1');
    const pending = generateOnboardingSubjectAction(generate);
    await vi.waitFor(() => {
      expect(ingest.generateSubject).toHaveBeenCalled();
    });
    const cancel = await POST(
      new Request('http://localhost:3000/api/onboarding/cancel-generate', {
        method: 'POST',
        headers: {
          origin: 'http://localhost:3000',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ cancelToken: token }),
      }),
    );
    expect(cancel.status).toBe(200);
    expect(await cancel.json()).toEqual({ ok: true });
    release();
    expect(await pending).toEqual({ ok: false, reason: 'cancelled' });
    expect(fs.readFileSync(irPath, 'utf8')).toBe(prior);
  });

  it('refuses cancel-generate without a session or a trusted origin', async () => {
    const { POST } = await import('@/app/api/onboarding/cancel-generate/route');
    const body = JSON.stringify({ cancelToken: 'cancel-token-01' });
    const noSession = await POST(
      new Request('http://localhost:3000/api/onboarding/cancel-generate', {
        method: 'POST',
        headers: {
          origin: 'http://localhost:3000',
          'content-type': 'application/json',
        },
        body,
      }),
    );
    expect(noSession.status).toBe(403);
    expect(await noSession.json()).toEqual({ ok: false, reason: 'forbidden' });

    await signInHost();
    const badOrigin = await POST(
      new Request('http://localhost:3000/api/onboarding/cancel-generate', {
        method: 'POST',
        headers: {
          origin: 'https://evil.example',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ cancelToken: 'cancel-token-01' }),
      }),
    );
    expect(badOrigin.status).toBe(403);
    expect(await badOrigin.json()).toEqual({ ok: false, reason: 'forbidden' });

    const invalid = await POST(
      new Request('http://localhost:3000/api/onboarding/cancel-generate', {
        method: 'POST',
        headers: {
          origin: 'http://localhost:3000',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ cancelToken: 'nope' }),
      }),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects cancel-generate after that token already committed IR', async () => {
    const root = tempRoot();
    const { setOnboardingContentRootForTests } = await import('@/lib/onboarding');
    setOnboardingContentRootForTests(root);
    await signInHost();
    fs.mkdirSync(path.join(root, 'content/subjects/history'), { recursive: true });
    fs.mkdirSync(path.join(root, 'content/source-pdfs/history'), { recursive: true });
    writeFileSync(
      path.join(root, 'content/subjects/history/bank.ir.json'),
      JSON.stringify({
        version: 1,
        subject: { id: 'history', label: 'History', icon: 'geography', l: 0.6, c: 0.08, h: 40 },
        difficulties: { easy: [], medium: [], hard: [] },
      }),
    );
    writeFileSync(path.join(root, 'content/source-pdfs/history/notes.txt'), 'A source note.\n');

    const { generateOnboardingSubjectAction, setOnboardingAiModeAction } =
      await import('@/actions/onboarding');
    const { POST } = await import('@/app/api/onboarding/cancel-generate/route');
    const mode = new FormData();
    mode.set('aiMode', 'skip-stub');
    expect((await setOnboardingAiModeAction(mode)).ok).toBe(true);

    const token = 'cancel-token-01';
    const generate = new FormData();
    generate.set('subjectId', 'history');
    generate.set('cancelToken', token);
    generate.set('force', '1');
    expect((await generateOnboardingSubjectAction(generate)).ok).toBe(true);

    const late = await POST(
      new Request('http://localhost:3000/api/onboarding/cancel-generate', {
        method: 'POST',
        headers: {
          origin: 'http://localhost:3000',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ cancelToken: token }),
      }),
    );
    expect(late.status).toBe(409);
    expect(await late.json()).toEqual({ ok: false, reason: 'already_committed' });
  });

  it('refuses cloud generate when the key is the test sentinel', async () => {
    const root = tempRoot();
    const { setOnboardingContentRootForTests } = await import('@/lib/onboarding');
    setOnboardingContentRootForTests(root);
    await signInHost();
    fs.mkdirSync(path.join(root, 'content/subjects/history'), { recursive: true });
    fs.mkdirSync(path.join(root, 'content/source-pdfs/history'), { recursive: true });
    writeFileSync(
      path.join(root, 'content/subjects/history/bank.ir.json'),
      JSON.stringify({
        version: 1,
        subject: { id: 'history', label: 'History', icon: 'geography', l: 0.6, c: 0.08, h: 40 },
        difficulties: { easy: [], medium: [], hard: [] },
      }),
    );
    writeFileSync(path.join(root, 'content/source-pdfs/history/notes.txt'), 'A source note.\n');
    const { generateOnboardingSubjectAction, setOnboardingAiModeAction } =
      await import('@/actions/onboarding');
    const mode = new FormData();
    mode.set('aiMode', 'cloud');
    expect((await setOnboardingAiModeAction(mode)).ok).toBe(true);
    const generate = new FormData();
    generate.set('subjectId', 'history');
    generate.set('force', '1');
    const result = await generateOnboardingSubjectAction(generate);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fail-closed');
    expect(result.reason).toBe('missing_key');
    expect(result).not.toHaveProperty('message');
    expect(JSON.stringify(result)).not.toMatch(/ANTHROPIC_API_KEY|sentinel|ENOENT|\.env/i);
  });

  it('lets the admin set, rotate, and clear OPENAI_API_KEY without echoing it', async () => {
    const { setEnvStoreRootForTests } = await import('@/lib/env-store');
    const root = tempRoot();
    setEnvStoreRootForTests(root);
    writeFileSync(path.join(root, '.env'), 'ANTHROPIC_API_KEY=test\n');
    await signInHost();
    const secret = 'sk-openai-action-secret-never-echo';
    const rotated = 'sk-openai-rotated-secret-never-echo';
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const { setOnboardingOpenAiKeyAction } = await import('@/actions/onboarding');
      const set = new FormData();
      set.set('intent', 'set');
      set.set('openaiApiKey', secret);
      const written = await setOnboardingOpenAiKeyAction(set);
      expect(written.ok).toBe(true);
      if (!written.ok) throw new Error('expected set');
      expect(written.snapshot.openaiConfigured).toBe(true);
      expect(written.snapshot.openaiHostManaged).toBe(false);
      expect(JSON.stringify(written)).not.toContain(secret);
      expect(JSON.stringify(written)).not.toMatch(/OPENAI_API_KEY=/);
      expect(readFileSync(path.join(root, '.env'), 'utf8')).toContain(`OPENAI_API_KEY=${secret}`);

      const rotate = new FormData();
      rotate.set('intent', 'set');
      rotate.set('openaiApiKey', rotated);
      const rotatedResult = await setOnboardingOpenAiKeyAction(rotate);
      expect(rotatedResult.ok).toBe(true);
      if (!rotatedResult.ok) throw new Error('expected rotate');
      expect(rotatedResult.snapshot.openaiConfigured).toBe(true);
      expect(rotatedResult.snapshot.openaiHostManaged).toBe(false);
      expect(JSON.stringify(rotatedResult)).not.toContain(rotated);
      expect(readFileSync(path.join(root, '.env'), 'utf8')).toContain(`OPENAI_API_KEY=${rotated}`);
      expect(readFileSync(path.join(root, '.env'), 'utf8')).not.toContain(secret);

      const clear = new FormData();
      clear.set('intent', 'clear');
      const cleared = await setOnboardingOpenAiKeyAction(clear);
      expect(cleared.ok).toBe(true);
      if (!cleared.ok) throw new Error('expected clear');
      expect(cleared.snapshot.openaiConfigured).toBe(false);
      expect(cleared.snapshot.openaiHostManaged).toBe(false);
      expect(JSON.stringify(cleared)).not.toContain(rotated);
      expect(readFileSync(path.join(root, '.env'), 'utf8')).not.toMatch(/OPENAI_API_KEY=/);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it('refuses OpenAI generate when the key is missing (fail closed, no echo)', async () => {
    const root = tempRoot();
    const { setOnboardingContentRootForTests } = await import('@/lib/onboarding');
    setOnboardingContentRootForTests(root);
    await signInHost();
    fs.mkdirSync(path.join(root, 'content/subjects/history'), { recursive: true });
    fs.mkdirSync(path.join(root, 'content/source-pdfs/history'), { recursive: true });
    writeFileSync(
      path.join(root, 'content/subjects/history/bank.ir.json'),
      JSON.stringify({
        version: 1,
        subject: { id: 'history', label: 'History', icon: 'geography', l: 0.6, c: 0.08, h: 40 },
        difficulties: { easy: [], medium: [], hard: [] },
      }),
    );
    writeFileSync(path.join(root, 'content/source-pdfs/history/notes.txt'), 'A source note.\n');
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const { generateOnboardingSubjectAction, setOnboardingAiModeAction } =
        await import('@/actions/onboarding');
      const mode = new FormData();
      mode.set('aiMode', 'cloud-openai');
      expect((await setOnboardingAiModeAction(mode)).ok).toBe(true);
      const generate = new FormData();
      generate.set('subjectId', 'history');
      generate.set('force', '1');
      const result = await generateOnboardingSubjectAction(generate);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected fail-closed');
      expect(result.reason).toBe('missing_key');
      expect(result).not.toHaveProperty('message');
      expect(JSON.stringify(result)).not.toMatch(/OPENAI_API_KEY|sentinel|ENOENT|\.env/i);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it('validates hand-authored IR without calling generate', async () => {
    const root = tempRoot();
    const { setOnboardingContentRootForTests } = await import('@/lib/onboarding');
    setOnboardingContentRootForTests(root);
    await signInHost();
    fs.mkdirSync(path.join(root, 'content/subjects/history'), { recursive: true });
    writeFileSync(
      path.join(root, 'content/subjects/history/bank.ir.json'),
      JSON.stringify({
        version: 1,
        subject: { id: 'history', label: 'History', icon: 'geography', l: 0.6, c: 0.08, h: 40 },
        difficulties: {
          easy: [
            {
              id: 'history-easy-1',
              type: 'mcq',
              q: 'A hand-authored question?',
              choices: ['A', 'B', 'C', 'D'],
              answer: 1,
              provenance: { pdf: 'hand-authored', locator: 'unit' },
            },
          ],
          medium: [],
          hard: [],
        },
      }),
    );
    const { validateOnboardingAction } = await import('@/actions/onboarding');
    expect((await validateOnboardingAction()).ok).toBe(true);
  });

  it('does not let an invited parent or student open the write path', async () => {
    const host = await signInHost();
    const { db, schema } = await import('@/lib/db');
    const parent = db
      .insert(schema.users)
      .values({ email: 'other@example.com', emailVerifiedAt: new Date() })
      .returning()
      .get()!;
    db.insert(schema.householdMembers)
      .values({ householdId: host.householdId, userId: parent.id, role: 'parent' })
      .run();
    sessionHolder.current.userId = parent.id;
    sessionHolder.current.role = 'parent';
    sessionHolder.current.email = 'other@example.com';
    const {
      cancelOnboardingGenerateAction,
      generateOnboardingSubjectAction,
      previewOnboardingEmitAction,
      setOnboardingAnthropicKeyAction,
      setOnboardingOpenAiKeyAction,
    } = await import('@/actions/onboarding');
    expect(await previewOnboardingEmitAction()).toEqual({ ok: false, reason: 'forbidden' });
    const openai = new FormData();
    openai.set('intent', 'set');
    openai.set('openaiApiKey', 'sk-should-not-write');
    expect(await setOnboardingOpenAiKeyAction(openai)).toEqual({ ok: false, reason: 'forbidden' });
    const anthropic = new FormData();
    anthropic.set('intent', 'set');
    anthropic.set('anthropicApiKey', 'sk-should-not-write');
    expect(await setOnboardingAnthropicKeyAction(anthropic)).toEqual({
      ok: false,
      reason: 'forbidden',
    });
    const generate = new FormData();
    generate.set('subjectId', 'history');
    expect(await generateOnboardingSubjectAction(generate)).toEqual({
      ok: false,
      reason: 'forbidden',
    });
    const cancel = new FormData();
    cancel.set('cancelToken', 'cancel-token-01');
    expect(await cancelOnboardingGenerateAction(cancel)).toEqual({
      ok: false,
      reason: 'forbidden',
    });

    const kid = db
      .insert(schema.users)
      .values({ email: 'kid@example.com', emailVerifiedAt: new Date() })
      .returning()
      .get()!;
    db.insert(schema.householdMembers)
      .values({ householdId: host.householdId, userId: kid.id, role: 'student' })
      .run();
    sessionHolder.current.userId = kid.id;
    sessionHolder.current.role = 'student';
    sessionHolder.current.email = 'kid@example.com';
    expect(await previewOnboardingEmitAction()).toEqual({ ok: false, reason: 'forbidden' });
    expect(await generateOnboardingSubjectAction(generate)).toEqual({
      ok: false,
      reason: 'forbidden',
    });
    expect(await cancelOnboardingGenerateAction(cancel)).toEqual({
      ok: false,
      reason: 'forbidden',
    });
    expect(await setOnboardingOpenAiKeyAction(openai)).toEqual({ ok: false, reason: 'forbidden' });
    expect(await setOnboardingAnthropicKeyAction(anthropic)).toEqual({
      ok: false,
      reason: 'forbidden',
    });
  });

  it('refuses set / rotate / clear after onboarding is complete', async () => {
    const { setEnvStoreRootForTests } = await import('@/lib/env-store');
    const root = tempRoot();
    setEnvStoreRootForTests(root);
    writeFileSync(path.join(root, '.env'), 'ANTHROPIC_API_KEY=test\n');
    const host = await signInHost();
    const { completeOnboarding } = await import('@/lib/onboarding');
    completeOnboarding(host.householdId);
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const { setOnboardingOpenAiKeyAction } = await import('@/actions/onboarding');
      const set = new FormData();
      set.set('intent', 'set');
      set.set('openaiApiKey', 'sk-should-not-write-after-complete');
      expect(await setOnboardingOpenAiKeyAction(set)).toEqual({
        ok: false,
        reason: 'already_complete',
      });
      const clear = new FormData();
      clear.set('intent', 'clear');
      expect(await setOnboardingOpenAiKeyAction(clear)).toEqual({
        ok: false,
        reason: 'already_complete',
      });
      expect(readFileSync(path.join(root, '.env'), 'utf8')).not.toMatch(/OPENAI_API_KEY=/);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it('rate-limits OpenAI key writes without echoing the secret', async () => {
    const { setEnvStoreRootForTests } = await import('@/lib/env-store');
    const { env } = await import('@/lib/env');
    const root = tempRoot();
    setEnvStoreRootForTests(root);
    writeFileSync(path.join(root, '.env'), 'ANTHROPIC_API_KEY=test\n');
    await signInHost();
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const { setOnboardingOpenAiKeyAction } = await import('@/actions/onboarding');
      const max = env.RATE_LIMIT_SIGNIN_MAX;
      for (let i = 0; i < max; i += 1) {
        const data = new FormData();
        data.set('intent', 'set');
        data.set('openaiApiKey', `sk-rate-limit-write-${i}-never-echo`);
        const result = await setOnboardingOpenAiKeyAction(data);
        expect(result.ok).toBe(true);
        expect(JSON.stringify(result)).not.toMatch(/sk-rate-limit-write/);
      }
      const blocked = new FormData();
      blocked.set('intent', 'set');
      blocked.set('openaiApiKey', 'sk-rate-limit-blocked-never-echo');
      const result = await setOnboardingOpenAiKeyAction(blocked);
      expect(result).toEqual({ ok: false, reason: 'rate_limited' });
      expect(JSON.stringify(result)).not.toContain('sk-rate-limit-blocked-never-echo');
      expect(readFileSync(path.join(root, '.env'), 'utf8')).not.toContain(
        'sk-rate-limit-blocked-never-echo',
      );
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it('refuses set / clear when OPENAI_API_KEY is host-managed, without echoing or writing', async () => {
    const { setEnvStoreRootForTests } = await import('@/lib/env-store');
    const root = tempRoot();
    setEnvStoreRootForTests(root);
    const fileSecret = 'sk-file-store-secret-never-echo';
    const injected = 'sk-host-injected-action-never-echo';
    const attempted = 'sk-wizard-host-managed-attempt-never-echo';
    writeFileSync(
      path.join(root, '.env'),
      `ANTHROPIC_API_KEY=test\nOPENAI_API_KEY=${fileSecret}\n`,
    );
    await signInHost();
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = injected;
    try {
      const { setOnboardingOpenAiKeyAction } = await import('@/actions/onboarding');
      const set = new FormData();
      set.set('intent', 'set');
      set.set('openaiApiKey', attempted);
      const written = await setOnboardingOpenAiKeyAction(set);
      expect(written).toEqual({ ok: false, reason: 'host_managed' });
      expect(JSON.stringify(written)).not.toContain(injected);
      expect(JSON.stringify(written)).not.toContain(attempted);
      expect(JSON.stringify(written)).not.toContain(fileSecret);

      const clear = new FormData();
      clear.set('intent', 'clear');
      const cleared = await setOnboardingOpenAiKeyAction(clear);
      expect(cleared).toEqual({ ok: false, reason: 'host_managed' });
      expect(JSON.stringify(cleared)).not.toContain(injected);
      expect(JSON.stringify(cleared)).not.toContain(fileSecret);

      expect(readFileSync(path.join(root, '.env'), 'utf8')).toBe(
        `ANTHROPIC_API_KEY=test\nOPENAI_API_KEY=${fileSecret}\n`,
      );
      expect(process.env.OPENAI_API_KEY).toBe(injected);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it('refuses set / clear when exec environ owns the key even if .env matches', async () => {
    const { setEnvStoreRootForTests, setInitialEnvironForTests } = await import('@/lib/env-store');
    const root = tempRoot();
    setEnvStoreRootForTests(root);
    const secret = 'sk-matching-host-and-file-never-echo';
    const attempted = 'sk-wizard-matching-attempt-never-echo';
    writeFileSync(path.join(root, '.env'), `ANTHROPIC_API_KEY=test\nOPENAI_API_KEY=${secret}\n`);
    setInitialEnvironForTests({ OPENAI_API_KEY: secret });
    await signInHost();
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = secret;
    try {
      const { setOnboardingOpenAiKeyAction } = await import('@/actions/onboarding');
      const set = new FormData();
      set.set('intent', 'set');
      set.set('openaiApiKey', attempted);
      const written = await setOnboardingOpenAiKeyAction(set);
      expect(written).toEqual({ ok: false, reason: 'host_managed' });
      expect(JSON.stringify(written)).not.toContain(secret);
      expect(JSON.stringify(written)).not.toContain(attempted);

      const clear = new FormData();
      clear.set('intent', 'clear');
      const cleared = await setOnboardingOpenAiKeyAction(clear);
      expect(cleared).toEqual({ ok: false, reason: 'host_managed' });
      expect(JSON.stringify(cleared)).not.toContain(secret);

      expect(readFileSync(path.join(root, '.env'), 'utf8')).toBe(
        `ANTHROPIC_API_KEY=test\nOPENAI_API_KEY=${secret}\n`,
      );
      expect(process.env.OPENAI_API_KEY).toBe(secret);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it('refuses set / clear when exec environ assigns OPENAI_API_KEY as empty or test', async () => {
    const { setEnvStoreRootForTests, setInitialEnvironForTests } = await import('@/lib/env-store');
    const root = tempRoot();
    setEnvStoreRootForTests(root);
    writeFileSync(path.join(root, '.env'), 'ANTHROPIC_API_KEY=test\n');
    await signInHost();
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const attempted = 'sk-wizard-unusable-inject-never-echo';
    try {
      const { setOnboardingOpenAiKeyAction } = await import('@/actions/onboarding');
      for (const injected of ['', 'test'] as const) {
        setInitialEnvironForTests({ OPENAI_API_KEY: injected });
        const set = new FormData();
        set.set('intent', 'set');
        set.set('openaiApiKey', attempted);
        const written = await setOnboardingOpenAiKeyAction(set);
        expect(written).toEqual({ ok: false, reason: 'host_managed' });
        expect(JSON.stringify(written)).not.toContain(attempted);

        const clear = new FormData();
        clear.set('intent', 'clear');
        const cleared = await setOnboardingOpenAiKeyAction(clear);
        expect(cleared).toEqual({ ok: false, reason: 'host_managed' });
        expect(readFileSync(path.join(root, '.env'), 'utf8')).toBe('ANTHROPIC_API_KEY=test\n');
        expect(process.env.OPENAI_API_KEY).toBeUndefined();
      }
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it('lets the admin set, rotate, and clear ANTHROPIC_API_KEY without echoing it', async () => {
    const { setEnvStoreRootForTests } = await import('@/lib/env-store');
    const root = tempRoot();
    setEnvStoreRootForTests(root);
    writeFileSync(path.join(root, '.env'), 'OPENAI_API_KEY=keep-openai\n');
    await signInHost();
    const secret = 'sk-anthropic-action-secret-never-echo';
    const rotated = 'sk-anthropic-rotated-secret-never-echo';
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const { setOnboardingAnthropicKeyAction } = await import('@/actions/onboarding');
      const set = new FormData();
      set.set('intent', 'set');
      set.set('anthropicApiKey', secret);
      const written = await setOnboardingAnthropicKeyAction(set);
      expect(written.ok).toBe(true);
      if (!written.ok) throw new Error('expected set');
      expect(written.snapshot.anthropicConfigured).toBe(true);
      expect(written.snapshot.anthropicHostManaged).toBe(false);
      expect(JSON.stringify(written)).not.toContain(secret);
      expect(JSON.stringify(written)).not.toMatch(/ANTHROPIC_API_KEY=/);
      expect(readFileSync(path.join(root, '.env'), 'utf8')).toContain(
        `ANTHROPIC_API_KEY=${secret}`,
      );

      const rotate = new FormData();
      rotate.set('intent', 'set');
      rotate.set('anthropicApiKey', rotated);
      const rotatedResult = await setOnboardingAnthropicKeyAction(rotate);
      expect(rotatedResult.ok).toBe(true);
      if (!rotatedResult.ok) throw new Error('expected rotate');
      expect(rotatedResult.snapshot.anthropicConfigured).toBe(true);
      expect(rotatedResult.snapshot.anthropicHostManaged).toBe(false);
      expect(JSON.stringify(rotatedResult)).not.toContain(rotated);
      expect(readFileSync(path.join(root, '.env'), 'utf8')).toContain(
        `ANTHROPIC_API_KEY=${rotated}`,
      );
      expect(readFileSync(path.join(root, '.env'), 'utf8')).not.toContain(secret);

      const clear = new FormData();
      clear.set('intent', 'clear');
      const cleared = await setOnboardingAnthropicKeyAction(clear);
      expect(cleared.ok).toBe(true);
      if (!cleared.ok) throw new Error('expected clear');
      expect(cleared.snapshot.anthropicConfigured).toBe(false);
      expect(cleared.snapshot.anthropicHostManaged).toBe(false);
      expect(JSON.stringify(cleared)).not.toContain(rotated);
      expect(readFileSync(path.join(root, '.env'), 'utf8')).not.toMatch(/ANTHROPIC_API_KEY=/);
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it('refuses Anthropic null bytes and the test sentinel without echoing or writing', async () => {
    const { setEnvStoreRootForTests } = await import('@/lib/env-store');
    const root = tempRoot();
    setEnvStoreRootForTests(root);
    writeFileSync(path.join(root, '.env'), 'OPENAI_API_KEY=keep-openai\n');
    await signInHost();
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const { setOnboardingAnthropicKeyAction } = await import('@/actions/onboarding');
      for (const raw of ['test', `sk-ok${'\0'}sk-bad`, 'sk-ok\nsk-bad'] as const) {
        const data = new FormData();
        data.set('intent', 'set');
        data.set('anthropicApiKey', raw);
        const result = await setOnboardingAnthropicKeyAction(data);
        expect(result).toEqual({ ok: false, reason: 'invalid' });
        expect(JSON.stringify(result)).not.toContain('sk-ok');
        expect(JSON.stringify(result)).not.toMatch(/ANTHROPIC_API_KEY=/);
      }
      expect(readFileSync(path.join(root, '.env'), 'utf8')).toBe('OPENAI_API_KEY=keep-openai\n');
      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it('refuses Anthropic set / rotate / clear after onboarding is complete', async () => {
    const { setEnvStoreRootForTests } = await import('@/lib/env-store');
    const root = tempRoot();
    setEnvStoreRootForTests(root);
    writeFileSync(path.join(root, '.env'), 'OPENAI_API_KEY=keep-openai\n');
    const host = await signInHost();
    const { completeOnboarding } = await import('@/lib/onboarding');
    completeOnboarding(host.householdId);
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const { setOnboardingAnthropicKeyAction } = await import('@/actions/onboarding');
      const set = new FormData();
      set.set('intent', 'set');
      set.set('anthropicApiKey', 'sk-should-not-write-after-complete');
      expect(await setOnboardingAnthropicKeyAction(set)).toEqual({
        ok: false,
        reason: 'already_complete',
      });
      const clear = new FormData();
      clear.set('intent', 'clear');
      expect(await setOnboardingAnthropicKeyAction(clear)).toEqual({
        ok: false,
        reason: 'already_complete',
      });
      expect(readFileSync(path.join(root, '.env'), 'utf8')).not.toMatch(/ANTHROPIC_API_KEY=/);
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it('rate-limits Anthropic key writes without echoing the secret', async () => {
    const { setEnvStoreRootForTests } = await import('@/lib/env-store');
    const { env } = await import('@/lib/env');
    const root = tempRoot();
    setEnvStoreRootForTests(root);
    writeFileSync(path.join(root, '.env'), 'OPENAI_API_KEY=keep-openai\n');
    await signInHost();
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const { setOnboardingAnthropicKeyAction } = await import('@/actions/onboarding');
      const max = env.RATE_LIMIT_SIGNIN_MAX;
      for (let i = 0; i < max; i += 1) {
        const data = new FormData();
        data.set('intent', 'set');
        data.set('anthropicApiKey', `sk-anth-rate-limit-write-${i}-never-echo`);
        const result = await setOnboardingAnthropicKeyAction(data);
        expect(result.ok).toBe(true);
        expect(JSON.stringify(result)).not.toMatch(/sk-anth-rate-limit-write/);
      }
      const blocked = new FormData();
      blocked.set('intent', 'set');
      blocked.set('anthropicApiKey', 'sk-anth-rate-limit-blocked-never-echo');
      const result = await setOnboardingAnthropicKeyAction(blocked);
      expect(result).toEqual({ ok: false, reason: 'rate_limited' });
      expect(JSON.stringify(result)).not.toContain('sk-anth-rate-limit-blocked-never-echo');
      expect(readFileSync(path.join(root, '.env'), 'utf8')).not.toContain(
        'sk-anth-rate-limit-blocked-never-echo',
      );
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it('refuses set / clear when ANTHROPIC_API_KEY is host-managed, without echoing or writing', async () => {
    const { setEnvStoreRootForTests } = await import('@/lib/env-store');
    const root = tempRoot();
    setEnvStoreRootForTests(root);
    const fileSecret = 'sk-anth-file-store-secret-never-echo';
    const injected = 'sk-anth-host-injected-action-never-echo';
    const attempted = 'sk-anth-wizard-host-managed-attempt-never-echo';
    writeFileSync(path.join(root, '.env'), `ANTHROPIC_API_KEY=${fileSecret}\n`);
    await signInHost();
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = injected;
    try {
      const { setOnboardingAnthropicKeyAction } = await import('@/actions/onboarding');
      const set = new FormData();
      set.set('intent', 'set');
      set.set('anthropicApiKey', attempted);
      const written = await setOnboardingAnthropicKeyAction(set);
      expect(written).toEqual({ ok: false, reason: 'host_managed' });
      expect(JSON.stringify(written)).not.toContain(injected);
      expect(JSON.stringify(written)).not.toContain(attempted);
      expect(JSON.stringify(written)).not.toContain(fileSecret);

      const clear = new FormData();
      clear.set('intent', 'clear');
      const cleared = await setOnboardingAnthropicKeyAction(clear);
      expect(cleared).toEqual({ ok: false, reason: 'host_managed' });
      expect(JSON.stringify(cleared)).not.toContain(injected);
      expect(JSON.stringify(cleared)).not.toContain(fileSecret);

      expect(readFileSync(path.join(root, '.env'), 'utf8')).toBe(
        `ANTHROPIC_API_KEY=${fileSecret}\n`,
      );
      expect(process.env.ANTHROPIC_API_KEY).toBe(injected);
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it('refuses set / clear when exec environ owns ANTHROPIC_API_KEY even if .env matches', async () => {
    const { setEnvStoreRootForTests, setInitialEnvironForTests } = await import('@/lib/env-store');
    const root = tempRoot();
    setEnvStoreRootForTests(root);
    const secret = 'sk-anth-matching-host-and-file-never-echo';
    const attempted = 'sk-anth-wizard-matching-attempt-never-echo';
    writeFileSync(path.join(root, '.env'), `ANTHROPIC_API_KEY=${secret}\n`);
    setInitialEnvironForTests({ ANTHROPIC_API_KEY: secret });
    await signInHost();
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = secret;
    try {
      const { setOnboardingAnthropicKeyAction } = await import('@/actions/onboarding');
      const set = new FormData();
      set.set('intent', 'set');
      set.set('anthropicApiKey', attempted);
      const written = await setOnboardingAnthropicKeyAction(set);
      expect(written).toEqual({ ok: false, reason: 'host_managed' });
      expect(JSON.stringify(written)).not.toContain(secret);
      expect(JSON.stringify(written)).not.toContain(attempted);

      const clear = new FormData();
      clear.set('intent', 'clear');
      const cleared = await setOnboardingAnthropicKeyAction(clear);
      expect(cleared).toEqual({ ok: false, reason: 'host_managed' });
      expect(JSON.stringify(cleared)).not.toContain(secret);

      expect(readFileSync(path.join(root, '.env'), 'utf8')).toBe(`ANTHROPIC_API_KEY=${secret}\n`);
      expect(process.env.ANTHROPIC_API_KEY).toBe(secret);
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it('refuses set / clear when exec environ assigns ANTHROPIC_API_KEY as empty or test', async () => {
    const { setEnvStoreRootForTests, setInitialEnvironForTests } = await import('@/lib/env-store');
    const root = tempRoot();
    setEnvStoreRootForTests(root);
    writeFileSync(path.join(root, '.env'), 'OPENAI_API_KEY=keep-openai\n');
    await signInHost();
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const attempted = 'sk-anth-wizard-unusable-inject-never-echo';
    try {
      const { setOnboardingAnthropicKeyAction } = await import('@/actions/onboarding');
      for (const injected of ['', 'test'] as const) {
        setInitialEnvironForTests({ ANTHROPIC_API_KEY: injected });
        const set = new FormData();
        set.set('intent', 'set');
        set.set('anthropicApiKey', attempted);
        const written = await setOnboardingAnthropicKeyAction(set);
        expect(written).toEqual({ ok: false, reason: 'host_managed' });
        expect(JSON.stringify(written)).not.toContain(attempted);

        const clear = new FormData();
        clear.set('intent', 'clear');
        const cleared = await setOnboardingAnthropicKeyAction(clear);
        expect(cleared).toEqual({ ok: false, reason: 'host_managed' });
        expect(readFileSync(path.join(root, '.env'), 'utf8')).toBe('OPENAI_API_KEY=keep-openai\n');
        expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
      }
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });
});
