import fs from 'node:fs';
import { mkdtempSync, writeFileSync } from 'node:fs';
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

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error(`NEXT_REDIRECT:${url}`), { url });
  },
}));

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
  setOnboardingContentRootForTests(null);
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
    const { addOnboardingSubjectAction, applyOnboardingEmitAction } =
      await import('@/actions/onboarding');
    const data = new FormData();
    data.set('id', 'history');
    data.set('label', 'History');
    data.set('icon', 'geography');
    expect(await addOnboardingSubjectAction(data)).toEqual({ ok: false, reason: 'forbidden' });
    expect(await applyOnboardingEmitAction()).toEqual({ ok: false, reason: 'forbidden' });
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
              id: 'history-easy-unconfirmed',
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
    expect(skipped.state.applied).toBeUndefined();
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
    const { previewOnboardingEmitAction } = await import('@/actions/onboarding');
    expect(await previewOnboardingEmitAction()).toEqual({ ok: false, reason: 'forbidden' });

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
  });
});
