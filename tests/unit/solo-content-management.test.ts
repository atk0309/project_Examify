import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionData } from '@/lib/auth';

vi.mock('@/lib/db', async () => {
  const schema = await import('@/lib/db/schema');
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  migrate(drizzle(sqlite), { migrationsFolder: path.join(process.cwd(), 'src/lib/db/migrations') });
  return { db: drizzle(sqlite, { schema }), schema };
});
const session = vi.hoisted(() => ({ value: {} as SessionData }));
vi.mock('@/lib/auth', () => ({ getSession: async () => session.value }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

import { db, schema } from '@/lib/db';
import { env } from '@/lib/env';
import { bootstrapSoloSession } from '@/lib/solo';
import { requireOnboardingAdmin } from '@/lib/onboarding-admin';
import {
  adminCanOpenOnboarding,
  completeOnboarding,
  getHouseholdOnboarding,
  setOnboardingContentRootForTests,
} from '@/lib/onboarding';
import { setEnvStoreRootForTests } from '@/lib/env-store';
import {
  addOnboardingSubjectAction,
  attachOnboardingPdfAction,
  detachOnboardingPdfAction,
  applyOnboardingEmitAction,
  finishOnboardingAction,
  previewOnboardingEmitAction,
  setOnboardingAiModeAction,
  skipOnboardingAction,
} from '@/actions/onboarding';

const previous = { ...env };
let root: string;
let householdId: number;

beforeEach(() => {
  Object.assign(env, { EXAMIFY_MODE: 'solo', EXAMIFY_SOLO_LAUNCH_TOKEN: '1'.repeat(64) });
  for (const table of [
    schema.soloProfiles,
    schema.soloLaunchTokens,
    schema.examAttempts,
    schema.examSessions,
    schema.householdMembers,
    schema.households,
    schema.users,
  ])
    db.delete(table).run();
  const nonce = '2'.repeat(64);
  const token =
    nonce + '.' + createHmac('sha256', env.EXAMIFY_SOLO_LAUNCH_TOKEN!).update(nonce).digest('hex');
  const started = bootstrapSoloSession(token);
  if (!started.ok) throw new Error('solo fixture failed');
  householdId = started.identity.householdId;
  session.value = { ...started.identity, role: 'parent', studentMode: true, solo: true };
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-solo-content-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'project-examify' }));
  fs.mkdirSync(path.join(root, 'content/subjects'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/lib/exam'), { recursive: true });
  setOnboardingContentRootForTests(root);
  setEnvStoreRootForTests(root);
});
afterEach(() => {
  setOnboardingContentRootForTests(null);
  setEnvStoreRootForTests(null);
  fs.rmSync(root, { recursive: true, force: true });
});
afterAll(() => Object.assign(env, previous));

function subjectForm(id: string) {
  const form = new FormData();
  form.set('id', id);
  form.set('label', id);
  form.set('icon', 'geography');
  return form;
}
function applyForm(expectedHash: string) {
  const data = new FormData();
  data.set('expectedHash', expectedHash);
  return data;
}

function authorFixture(id: string) {
  fs.writeFileSync(
    path.join(root, 'content/subjects', id, 'bank.ir.json'),
    JSON.stringify({
      version: 1,
      subject: { id, label: id, icon: 'geography', l: 0.6, c: 0.08, h: 40 },
      difficulties: {
        easy: [
          {
            id: `${id}-easy-1`,
            type: 'mcq',
            q: 'Fixture question?',
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
}

describe('ongoing solo content management', () => {
  it('allows text-note upload/removal only through the authenticated solo-owner gate', async () => {
    expect((await addOnboardingSubjectAction(subjectForm('history'))).ok).toBe(true);
    const data = new FormData();
    data.set('subjectId', 'history');
    data.set('file', new File(['Local study notes.'], 'notes.txt', { type: 'text/plain' }));
    expect((await attachOnboardingPdfAction(data)).ok).toBe(true);
    expect(fs.readFileSync(path.join(root, 'content/source-pdfs/history/notes.txt'), 'utf8')).toBe(
      'Local study notes.',
    );
    const remove = new FormData();
    remove.set('subjectId', 'history');
    remove.set('filename', 'notes.txt');
    expect((await detachOnboardingPdfAction(remove)).ok).toBe(true);
    session.value.solo = false;
    expect(await attachOnboardingPdfAction(data)).toEqual({ ok: false, reason: 'forbidden' });
  });
  it('completes, reopens, adds another subject and completes again without resetting or losing work', async () => {
    const ai = new FormData();
    // Set an available mode without executing any provider.
    ai.set('aiMode', 'cloud-openai');
    expect((await setOnboardingAiModeAction(ai)).ok).toBe(true);
    expect((await addOnboardingSubjectAction(subjectForm('history'))).ok).toBe(true);
    authorFixture('history');
    const firstPreview = await previewOnboardingEmitAction();
    if (!firstPreview.ok) throw new Error('expected first preview');
    expect((await applyOnboardingEmitAction(applyForm(firstPreview.dryRun.hash))).ok).toBe(true);
    await expect(finishOnboardingAction()).rejects.toThrow('REDIRECT:/');
    expect(getHouseholdOnboarding(householdId)).toMatchObject({
      complete: true,
      state: { aiMode: 'cloud-openai', applied: true },
    });
    const firstBank = fs.readFileSync(
      path.join(root, 'content/generated/questions/history.json'),
      'utf8',
    );
    db.insert(schema.examAttempts)
      .values({
        userId: session.value.userId!,
        subject: 'history',
        difficulty: 'easy',
        total: 1,
        correct: 1,
        scorePct: 100,
        items: [],
      })
      .run();

    expect(await requireOnboardingAdmin()).toEqual({ ok: true, householdId });
    expect((await addOnboardingSubjectAction(subjectForm('chemistry'))).ok).toBe(true);
    expect(getHouseholdOnboarding(householdId)).toMatchObject({
      complete: true,
      state: { aiMode: 'cloud-openai', applied: false },
    });
    // Reopening never permits an unreviewed Apply or a stale Finish.
    expect(await applyOnboardingEmitAction()).toEqual({ ok: false, reason: 'dry_run_required' });
    expect(await finishOnboardingAction()).toEqual({ ok: false, reason: 'emit_required' });
    authorFixture('chemistry');
    const secondPreview = await previewOnboardingEmitAction();
    if (!secondPreview.ok) throw new Error('expected second preview');
    expect((await applyOnboardingEmitAction(applyForm(secondPreview.dryRun.hash))).ok).toBe(true);
    await expect(finishOnboardingAction()).rejects.toThrow('REDIRECT:/');
    expect(getHouseholdOnboarding(householdId).complete).toBe(true);
    expect(
      fs.readFileSync(path.join(root, 'content/generated/questions/history.json'), 'utf8'),
    ).toBe(firstBank);
    expect(fs.existsSync(path.join(root, 'content/generated/questions/chemistry.json'))).toBe(true);
    expect(db.select().from(schema.examAttempts).all()).toHaveLength(1);
    expect(await requireOnboardingAdmin()).toEqual({ ok: true, householdId });
  });
  it('leaves completed solo status intact when the owner exits without changes', async () => {
    completeOnboarding(householdId);
    const before = getHouseholdOnboarding(householdId);
    await expect(skipOnboardingAction()).rejects.toThrow('REDIRECT:/');
    expect(getHouseholdOnboarding(householdId)).toEqual(before);
  });
  it('does not reopen completed household setup even if a caller has a solo-shaped cookie', async () => {
    completeOnboarding(householdId);
    env.EXAMIFY_MODE = 'household';
    session.value.studentMode = false;
    expect(await requireOnboardingAdmin()).toEqual({ ok: false, reason: 'already_complete' });
    expect(await addOnboardingSubjectAction(subjectForm('blocked'))).toEqual({
      ok: false,
      reason: 'already_complete',
    });
    expect(fs.existsSync(path.join(root, 'content/subjects/blocked'))).toBe(false);
    expect(getHouseholdOnboarding(householdId).complete).toBe(true);
  });
  it.each([{ solo: false }, { userId: 9876 }, { role: 'student' as const }])(
    'rejects a wrong solo identity %j',
    async (patch) => {
      completeOnboarding(householdId);
      Object.assign(session.value, patch);
      expect(await requireOnboardingAdmin()).toEqual({ ok: false, reason: 'forbidden' });
    },
  );
  it('shows the explicit author preview to a completed, verified solo owner', async () => {
    expect((await addOnboardingSubjectAction(subjectForm('history'))).ok).toBe(true);
    authorFixture('history');
    completeOnboarding(householdId);
    const preview = await previewOnboardingEmitAction();
    if (!preview.ok) throw new Error('expected verified solo author preview');
    expect(preview.authorPreview.subjects[0]).toMatchObject({
      id: 'history',
      difficulties: [
        { difficulty: 'easy', questions: [{ id: 'history-easy-1', answer: 1 }] },
        {},
        {},
      ],
    });
    expect(JSON.stringify(preview.dryRun)).not.toMatch(/"answer"|"rubric"|"provenance"/);
    expect(JSON.stringify(preview.snapshot)).not.toMatch(/"answer"|"rubric"|"provenance"/);
    expect((await applyOnboardingEmitAction(applyForm(preview.dryRun.hash))).ok).toBe(true);
    expect(getHouseholdOnboarding(householdId).complete).toBe(true);
  });

  it.each([
    'unsigned session',
    'missing solo marker',
    'wrong owner',
    'student role',
    'missing profile',
    'revoked admin membership',
  ])('refuses direct solo author preview and Apply for %s', async (failure) => {
    expect((await addOnboardingSubjectAction(subjectForm('history'))).ok).toBe(true);
    authorFixture('history');
    const preview = await previewOnboardingEmitAction();
    if (!preview.ok) throw new Error('expected reviewed plan');
    completeOnboarding(householdId);
    const before = getHouseholdOnboarding(householdId);
    if (failure === 'unsigned session') session.value = {};
    else if (failure === 'missing solo marker') delete session.value.solo;
    else if (failure === 'wrong owner') session.value.userId = 9876;
    else if (failure === 'student role') session.value.role = 'student';
    else if (failure === 'missing profile') db.delete(schema.soloProfiles).run();
    else {
      db.update(schema.householdMembers)
        .set({ role: 'parent' })
        .where(eq(schema.householdMembers.userId, session.value.userId!))
        .run();
    }
    expect(await previewOnboardingEmitAction()).toEqual({ ok: false, reason: 'forbidden' });
    expect(await applyOnboardingEmitAction(applyForm(preview.dryRun.hash))).toEqual({
      ok: false,
      reason: 'forbidden',
    });
    expect(getHouseholdOnboarding(householdId)).toEqual(before);
    expect(fs.existsSync(path.join(root, 'content/generated/questions/history.json'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'content/generated/keys/history.json'))).toBe(false);
  });

  it('keeps helper household defaults closed and requires an admin in every mode', () => {
    expect(adminCanOpenOnboarding({ role: 'admin', onboardingComplete: true })).toBe(false);
    expect(adminCanOpenOnboarding({ role: 'admin', onboardingComplete: true, solo: true })).toBe(
      true,
    );
    expect(adminCanOpenOnboarding({ role: 'parent', onboardingComplete: true, solo: true })).toBe(
      false,
    );
    expect(adminCanOpenOnboarding({ role: 'student', onboardingComplete: false, solo: true })).toBe(
      false,
    );
  });
});
