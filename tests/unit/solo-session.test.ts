import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '@/lib/env';

const state = vi.hoisted(() => ({
  headers: new Headers(),
  values: new Map<string, string>(),
  writes: [] as Array<{ name: string; options: Record<string, unknown> }>,
  identity: { userId: 7, householdId: 3, email: 'learner@solo.invalid', sessionVersion: 0 } as {
    userId: number;
    householdId: number;
    email: string;
    sessionVersion: number;
  } | null,
}));
vi.mock('next/headers', () => ({
  headers: async () => state.headers,
  cookies: async () => ({
    get: (name: string) => {
      const value = state.values.get(name);
      return value ? { name, value } : undefined;
    },
    set: (name: string, value: string, options: Record<string, unknown>) => {
      state.values.set(name, value);
      state.writes.push({ name, options });
    },
  }),
}));
vi.mock('@/lib/solo', () => ({ getSoloIdentity: () => state.identity }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

const previous = { ...env };
let auth: typeof import('@/lib/auth');
beforeAll(async () => {
  Object.assign(env, {
    EXAMIFY_MODE: 'solo',
    SITE_URL: 'http://127.0.0.1:41234',
    EXAMIFY_SOLO_TRANSPORT_SECRET: '2'.repeat(64),
  });
  auth = await import('@/lib/auth');
});
beforeEach(() => {
  env.EXAMIFY_MODE = 'solo';
  state.values.clear();
  state.writes.length = 0;
  state.headers = new Headers({
    host: '127.0.0.1:41234',
    'x-examify-solo-transport': '2'.repeat(64),
  });
  state.identity = { userId: 7, householdId: 3, email: 'learner@solo.invalid', sessionVersion: 0 };
});
afterAll(() => Object.assign(env, previous));

async function save(overrides: Partial<import('@/lib/auth').SessionData> = {}) {
  const session = await auth.getRawSession();
  Object.assign(
    session,
    {
      userId: 7,
      role: 'parent',
      email: 'learner@solo.invalid',
      sessionVersion: 0,
      solo: true,
      studentMode: false,
    },
    overrides,
  );
  await session.save();
}

describe('solo sessions keep existing ownership and fail closed', () => {
  it('seals a separate HttpOnly SameSite Strict cookie and enforces own-user student mode', async () => {
    await save();
    expect(state.writes[0]).toMatchObject({
      name: expect.stringMatching(/^examify_solo_session_[a-f0-9]{16}$/),
      options: { httpOnly: true, sameSite: 'strict', secure: false, path: '/' },
    });
    expect(await auth.getSession()).toMatchObject({
      userId: 7,
      role: 'parent',
      studentMode: true,
      solo: true,
    });
  });
  it.each([{ solo: false }, { userId: 99 }, { role: 'student' as const }, { sessionVersion: 2 }])(
    'refuses mismatched or revoked session %j',
    async (overrides) => {
      await save(overrides);
      expect((await auth.getSession()).userId).toBeUndefined();
      // No cookie writes during a Server Component read.
      expect(state.writes).toHaveLength(1);
    },
  );
  it('refuses a removed/invalid profile and unauthenticated access to the raw session', async () => {
    await save();
    state.identity = null;
    expect((await auth.getSession()).userId).toBeUndefined();
    state.headers.delete('x-examify-solo-transport');
    await expect(auth.getRawSession()).rejects.toThrow('Local launcher access required');
  });
  it('never turns a solo cookie into a household authenticated session', async () => {
    await save();
    env.EXAMIFY_MODE = 'household';
    await expect(auth.getSession()).rejects.toThrow('REDIRECT:/signin/invalidate');
  });
});
