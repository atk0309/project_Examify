import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionData } from '@/lib/auth';

const TMP = path.join(process.cwd(), 'tests', '.tmp');
const DB_PATH = path.join(TMP, `bootstrap-actions-${process.pid}.db`);
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
  headers: async () => new Headers({ 'x-forwarded-for': '203.0.113.21' }),
}));

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error(`NEXT_REDIRECT:${url}`), { url });
  },
}));

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
  db.delete(schema.magicTokens).run();
  db.delete(schema.householdInvites).run();
  db.delete(schema.householdMembers).run();
  db.delete(schema.households).run();
  db.delete(schema.users).run();
  resetLegacyImportLatch();
  sessionHolder.current = { save: vi.fn(async () => {}) };
  const { env } = await import('@/lib/env');
  (env as { TURNSTILE_SECRET_KEY?: string }).TURNSTILE_SECRET_KEY = undefined;
  (env as { NEXT_PUBLIC_TURNSTILE_SITE_KEY?: string }).NEXT_PUBLIC_TURNSTILE_SITE_KEY = undefined;
});

function setupForm(overrides: Record<string, string> = {}): FormData {
  const data = new FormData();
  data.set('email', overrides.email ?? 'host@example.com');
  data.set('householdName', overrides.householdName ?? 'Our family');
  data.set('setupSecret', overrides.setupSecret ?? 'dev-setup-bootstrap-secret');
  return data;
}

describe('bootstrapHouseholdAction', () => {
  it('creates the first admin and establishes a parent session', async () => {
    const { bootstrapHouseholdAction } = await import('@/actions/bootstrapHousehold');
    await expect(bootstrapHouseholdAction({ status: 'idle' }, setupForm())).rejects.toMatchObject({
      url: '/onboarding',
    });
    expect(sessionHolder.current.userId).toBeTypeOf('number');
    expect(sessionHolder.current.role).toBe('parent');
    expect(sessionHolder.current.email).toBe('host@example.com');
    expect(sessionHolder.current.save).toHaveBeenCalledOnce();
  });

  it('rejects a missing or wrong setup secret before creating a household', async () => {
    const { bootstrapHouseholdAction } = await import('@/actions/bootstrapHousehold');
    const { hasAnyHousehold } = await import('@/lib/households');
    const missing = await bootstrapHouseholdAction(
      { status: 'idle' },
      setupForm({ setupSecret: '' }),
    );
    expect(missing).toEqual({ status: 'error', reason: 'forbidden' });
    expect(hasAnyHousehold()).toBe(false);

    const wrong = await bootstrapHouseholdAction(
      { status: 'idle' },
      setupForm({ setupSecret: 'definitely-not-the-setup-secret' }),
    );
    expect(wrong).toEqual({ status: 'error', reason: 'forbidden' });
    expect(hasAnyHousehold()).toBe(false);
  });

  it('requires a password when AUTH_MODE is password', async () => {
    const { env } = await import('@/lib/env');
    const password = await import('@/lib/password');
    const hashSpy = vi.spyOn(password, 'hashPassword');
    hashSpy.mockClear();
    (env as { AUTH_MODE: typeof env.AUTH_MODE }).AUTH_MODE = 'password';
    try {
      const { bootstrapHouseholdAction } = await import('@/actions/bootstrapHousehold');
      const missing = await bootstrapHouseholdAction({ status: 'idle' }, setupForm());
      expect(missing).toEqual({ status: 'error', reason: 'invalid' });
      expect(hashSpy).not.toHaveBeenCalled();

      const data = setupForm();
      data.set('password', 'admin-password');
      data.set('confirmPassword', 'admin-password');
      await expect(bootstrapHouseholdAction({ status: 'idle' }, data)).rejects.toMatchObject({
        url: '/onboarding',
      });
      expect(hashSpy).toHaveBeenCalledOnce();
      expect(hashSpy).toHaveBeenCalledWith('admin-password');
      const { db, schema } = await import('@/lib/db');
      const { eq } = await import('drizzle-orm');
      const user = db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, 'host@example.com'))
        .get();
      expect(user?.passwordHash).toBeTruthy();
      expect(password.verifyPassword('admin-password', user!.passwordHash!)).toBe(true);
    } finally {
      hashSpy.mockRestore();
      (env as { AUTH_MODE: typeof env.AUTH_MODE }).AUTH_MODE = 'magic-link';
    }
  });

  it('rejects a second setup', async () => {
    const { bootstrapHousehold } = await import('@/lib/households');
    bootstrapHousehold({ email: 'a@example.com', householdName: 'One' });
    const { bootstrapHouseholdAction } = await import('@/actions/bootstrapHousehold');
    const state = await bootstrapHouseholdAction(
      { status: 'idle' },
      setupForm({ email: 'b@example.com', householdName: 'Two' }),
    );
    expect(state).toEqual({ status: 'error', reason: 'already_setup' });
  });

  it('refuses a password mismatch after the setup secret, without hashing', async () => {
    const { env } = await import('@/lib/env');
    const password = await import('@/lib/password');
    const hashSpy = vi.spyOn(password, 'hashPassword');
    hashSpy.mockClear();
    (env as { AUTH_MODE: typeof env.AUTH_MODE }).AUTH_MODE = 'password';
    try {
      const { bootstrapHouseholdAction } = await import('@/actions/bootstrapHousehold');
      const { hasAnyHousehold } = await import('@/lib/households');
      const { db, schema } = await import('@/lib/db');
      const data = setupForm();
      data.set('password', 'admin-password');
      data.set('confirmPassword', 'different-password');
      expect(await bootstrapHouseholdAction({ status: 'idle' }, data)).toEqual({
        status: 'error',
        reason: 'password_mismatch',
      });
      expect(hasAnyHousehold()).toBe(false);
      expect(hashSpy).not.toHaveBeenCalled();
      expect(db.select().from(schema.rateLimitEvents).all().length).toBeGreaterThan(0);

      const omitted = setupForm();
      omitted.set('password', 'admin-password');
      expect(await bootstrapHouseholdAction({ status: 'idle' }, omitted)).toEqual({
        status: 'error',
        reason: 'password_mismatch',
      });
      expect(hashSpy).not.toHaveBeenCalled();

      const wrongSecret = setupForm({ setupSecret: 'definitely-not-the-setup-secret' });
      wrongSecret.set('password', 'admin-password');
      wrongSecret.set('confirmPassword', 'different-password');
      expect(await bootstrapHouseholdAction({ status: 'idle' }, wrongSecret)).toEqual({
        status: 'error',
        reason: 'forbidden',
      });
      expect(hashSpy).not.toHaveBeenCalled();
      expect(hasAnyHousehold()).toBe(false);
    } finally {
      hashSpy.mockRestore();
      (env as { AUTH_MODE: typeof env.AUTH_MODE }).AUTH_MODE = 'magic-link';
    }
  });

  it('does not hash when captcha or the sign-in rate limit fails closed', async () => {
    const { env } = await import('@/lib/env');
    const password = await import('@/lib/password');
    const hashSpy = vi.spyOn(password, 'hashPassword');
    hashSpy.mockClear();
    const originalMax = env.RATE_LIMIT_SIGNIN_MAX;
    (env as { AUTH_MODE: typeof env.AUTH_MODE }).AUTH_MODE = 'password';
    (env as { RATE_LIMIT_SIGNIN_MAX: number }).RATE_LIMIT_SIGNIN_MAX = 1;
    try {
      const { bootstrapHouseholdAction } = await import('@/actions/bootstrapHousehold');
      const { hasAnyHousehold } = await import('@/lib/households');
      const mismatch = setupForm();
      mismatch.set('password', 'admin-password');
      mismatch.set('confirmPassword', 'different-password');
      expect(await bootstrapHouseholdAction({ status: 'idle' }, mismatch)).toEqual({
        status: 'error',
        reason: 'password_mismatch',
      });
      expect(hashSpy).not.toHaveBeenCalled();

      const limited = setupForm();
      limited.set('password', 'admin-password');
      limited.set('confirmPassword', 'admin-password');
      expect(await bootstrapHouseholdAction({ status: 'idle' }, limited)).toEqual({
        status: 'error',
        reason: 'rate_limited',
      });
      expect(hashSpy).not.toHaveBeenCalled();
      expect(hasAnyHousehold()).toBe(false);

      (env as { TURNSTILE_ENABLED: boolean }).TURNSTILE_ENABLED = true;
      (env as { TURNSTILE_SECRET_KEY?: string }).TURNSTILE_SECRET_KEY =
        '2x0000000000000000000000000000000AA';
      (env as { NEXT_PUBLIC_TURNSTILE_SITE_KEY?: string }).NEXT_PUBLIC_TURNSTILE_SITE_KEY =
        '2x00000000000000000000AB';
      const missingToken = setupForm();
      missingToken.set('password', 'admin-password');
      missingToken.set('confirmPassword', 'admin-password');
      expect(await bootstrapHouseholdAction({ status: 'idle' }, missingToken)).toEqual({
        status: 'error',
        reason: 'invalid',
      });
      expect(hashSpy).not.toHaveBeenCalled();

      const captcha = setupForm();
      captcha.set('password', 'admin-password');
      captcha.set('confirmPassword', 'admin-password');
      captcha.set('cf-turnstile-response', 'not-a-pass');
      expect(await bootstrapHouseholdAction({ status: 'idle' }, captcha)).toEqual({
        status: 'error',
        reason: 'captcha',
      });
      expect(hashSpy).not.toHaveBeenCalled();
      expect(hasAnyHousehold()).toBe(false);
    } finally {
      hashSpy.mockRestore();
      (env as { AUTH_MODE: typeof env.AUTH_MODE }).AUTH_MODE = 'magic-link';
      (env as { RATE_LIMIT_SIGNIN_MAX: number }).RATE_LIMIT_SIGNIN_MAX = originalMax;
      (env as { TURNSTILE_ENABLED?: boolean }).TURNSTILE_ENABLED = undefined;
      (env as { TURNSTILE_SECRET_KEY?: string }).TURNSTILE_SECRET_KEY = undefined;
      (env as { NEXT_PUBLIC_TURNSTILE_SITE_KEY?: string }).NEXT_PUBLIC_TURNSTILE_SITE_KEY =
        undefined;
    }
  });

  it.each(['magic-link', 'local-otp'] as const)(
    'does not require confirmPassword when AUTH_MODE is %s',
    async (mode) => {
      const { env } = await import('@/lib/env');
      const password = await import('@/lib/password');
      const hashSpy = vi.spyOn(password, 'hashPassword');
      hashSpy.mockClear();
      (env as { AUTH_MODE: typeof env.AUTH_MODE }).AUTH_MODE = mode;
      try {
        const { bootstrapHouseholdAction } = await import('@/actions/bootstrapHousehold');
        const { db, schema } = await import('@/lib/db');
        const { eq } = await import('drizzle-orm');
        const data = setupForm();
        data.set('password', 'admin-password');
        data.set('confirmPassword', 'different-password');
        await expect(bootstrapHouseholdAction({ status: 'idle' }, data)).rejects.toMatchObject({
          url: '/onboarding',
        });
        expect(hashSpy).not.toHaveBeenCalled();
        const user = db
          .select()
          .from(schema.users)
          .where(eq(schema.users.email, 'host@example.com'))
          .get();
        expect(user?.passwordHash ?? null).toBeNull();
      } finally {
        hashSpy.mockRestore();
        (env as { AUTH_MODE: typeof env.AUTH_MODE }).AUTH_MODE = 'magic-link';
      }
    },
  );
});

describe('createInvite + requestInviteLink', () => {
  it('lets a parent mint an invite that a student can accept', async () => {
    const { bootstrapHousehold } = await import('@/lib/households');
    const host = bootstrapHousehold({ email: 'pat@example.com', householdName: 'Ours' });
    if (!host.ok) throw new Error('bootstrap failed');
    sessionHolder.current.userId = host.userId;
    sessionHolder.current.role = 'parent';
    sessionHolder.current.email = host.email;

    const { createInvite } = await import('@/actions/createInvite');
    const createdForm = new FormData();
    createdForm.set('role', 'student');
    const created = await createInvite(createdForm);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.id).toBeTypeOf('number');
    expect(created.url).toContain('/invite/');

    const token = created.url.split('/invite/')[1]!;
    const { requestInviteLink } = await import('@/actions/requestInviteLink');
    const accept = new FormData();
    accept.set('email', 'alex@example.com');
    accept.set('inviteToken', decodeURIComponent(token));
    const state = await requestInviteLink({ status: 'idle' }, accept);
    expect(state).toEqual({ status: 'sent', email: 'alex@example.com' });
  });

  it('returns generic sent when the email does not match the invite lock', async () => {
    const { bootstrapHousehold, createHouseholdInvite } = await import('@/lib/households');
    const host = bootstrapHousehold({ email: 'pat@example.com', householdName: 'Ours' });
    if (!host.ok) throw new Error('bootstrap failed');
    const created = createHouseholdInvite({
      actorUserId: host.userId,
      role: 'student',
      email: 'alex@example.com',
    });
    if (!created.ok) throw new Error('invite failed');

    const { requestInviteLink } = await import('@/actions/requestInviteLink');
    const accept = new FormData();
    accept.set('email', 'stranger@example.com');
    accept.set('inviteToken', created.token);
    const state = await requestInviteLink({ status: 'idle' }, accept);
    expect(state).toEqual({ status: 'sent', email: 'stranger@example.com' });
  });

  it('rejects an open parent invite', async () => {
    const { bootstrapHousehold } = await import('@/lib/households');
    const host = bootstrapHousehold({ email: 'pat@example.com', householdName: 'Ours' });
    if (!host.ok) throw new Error('bootstrap failed');
    sessionHolder.current.userId = host.userId;
    sessionHolder.current.role = 'parent';
    const { createInvite } = await import('@/actions/createInvite');
    const form = new FormData();
    form.set('role', 'parent');
    expect(await createInvite(form)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('lets an admin remove a student via removeMember', async () => {
    const { bootstrapHousehold, createHouseholdInvite, attachMembershipFromInvite } =
      await import('@/lib/households');
    const { db, schema } = await import('@/lib/db');
    const host = bootstrapHousehold({ email: 'pat@example.com', householdName: 'Ours' });
    if (!host.ok) throw new Error('bootstrap failed');
    const kid = db
      .insert(schema.users)
      .values({ email: 'kid@example.com', emailVerifiedAt: new Date() })
      .returning()
      .get()!;
    const created = createHouseholdInvite({ actorUserId: host.userId, role: 'student' });
    if (!created.ok) throw new Error('invite failed');
    db.transaction((tx) => {
      attachMembershipFromInvite(tx, created.invite.id, kid.id, 'kid@example.com');
    });
    sessionHolder.current.userId = host.userId;
    sessionHolder.current.role = 'parent';

    const { removeMember } = await import('@/actions/removeMember');
    const data = new FormData();
    data.set('userId', String(kid.id));
    expect(await removeMember(data)).toEqual({ ok: true });

    sessionHolder.current.userId = kid.id;
    sessionHolder.current.role = 'student';
    expect(await removeMember(data)).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('reports an invalid invite token', async () => {
    const { requestInviteLink } = await import('@/actions/requestInviteLink');
    const accept = new FormData();
    accept.set('email', 'alex@example.com');
    accept.set('inviteToken', 'not-a-real-token');
    const state = await requestInviteLink({ status: 'idle' }, accept);
    expect(state).toEqual({ status: 'error', reason: 'invite_invalid' });
  });
});
