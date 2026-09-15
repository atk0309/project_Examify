import fs from 'node:fs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionData } from '@/lib/auth';
import { EMPTY_CATALOG_EMIT_MESSAGE } from '@/lib/setup-wizard-types';

const TMP = path.join(process.cwd(), 'tests', '.tmp');
const DB_PATH = path.join(TMP, `setup-wizard-actions-${process.pid}.db`);
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
  const root = mkdtempSync(path.join(tmpdir(), 'examify-wizard-act-'));
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
  const { setWizardContentRootForTests } = await import('@/lib/setup-wizard');
  setWizardContentRootForTests(null);
});

afterEach(async () => {
  const { setWizardContentRootForTests } = await import('@/lib/setup-wizard');
  setWizardContentRootForTests(null);
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

describe('setup wizard actions', () => {
  it('refuses mutations without a parent session', async () => {
    const { addWizardSubjectAction, applyWizardEmitAction } = await import('@/actions/setupWizard');
    const data = new FormData();
    data.set('id', 'history');
    data.set('label', 'History');
    data.set('icon', 'geography');
    expect(await addWizardSubjectAction(data)).toEqual({ ok: false, reason: 'forbidden' });
    expect(await applyWizardEmitAction()).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('refuses apply before a dry-run preview', async () => {
    const root = tempRoot();
    const { setWizardContentRootForTests } = await import('@/lib/setup-wizard');
    setWizardContentRootForTests(root);
    await signInHost();
    const { applyWizardEmitAction } = await import('@/actions/setupWizard');
    expect(await applyWizardEmitAction()).toEqual({ ok: false, reason: 'dry_run_required' });
  });

  it('refuses an empty catalog emit from the wizard with the CLI copy', async () => {
    const root = tempRoot();
    const { setWizardContentRootForTests } = await import('@/lib/setup-wizard');
    setWizardContentRootForTests(root);
    await signInHost();
    const { previewWizardEmitAction, applyWizardEmitAction } =
      await import('@/actions/setupWizard');
    const preview = await previewWizardEmitAction();
    expect(preview.ok).toBe(false);
    if (preview.ok) throw new Error('expected empty refuse');
    expect(preview.reason).toBe('empty_catalog');
    expect(preview.message).toBe(EMPTY_CATALOG_EMIT_MESSAGE);
    expect(await applyWizardEmitAction()).toEqual({ ok: false, reason: 'dry_run_required' });
  });

  it('applies emit only after a matching dry-run', async () => {
    const root = tempRoot();
    const { setWizardContentRootForTests } = await import('@/lib/setup-wizard');
    setWizardContentRootForTests(root);
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
    const { previewWizardEmitAction, applyWizardEmitAction } =
      await import('@/actions/setupWizard');
    const preview = await previewWizardEmitAction();
    expect(preview.ok).toBe(true);
    if (!preview.ok) throw new Error('expected dry-run');
    expect(JSON.stringify(preview.files)).not.toContain('A fixture question?');
    const applied = await applyWizardEmitAction();
    expect(applied.ok).toBe(true);
    expect(fs.existsSync(path.join(root, 'content/generated/questions/history.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'content/generated/keys/history.json'))).toBe(true);
  });

  it('does not let a student open the write path', async () => {
    const host = await signInHost();
    const { db, schema } = await import('@/lib/db');
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
    const { previewWizardEmitAction } = await import('@/actions/setupWizard');
    expect(await previewWizardEmitAction()).toEqual({ ok: false, reason: 'forbidden' });
  });
});
