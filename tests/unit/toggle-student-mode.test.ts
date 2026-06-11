import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionData } from '@/lib/auth';

// A controllable session with a spyable `save()`, swapped per test. `@/lib/auth`
// is mocked so the action never touches next/headers cookies during a unit run.
const sessionHolder = vi.hoisted(() => ({
  current: {} as SessionData & { save: () => Promise<void> },
}));

vi.mock('@/lib/auth', () => ({
  getSession: async () => sessionHolder.current,
}));

function makeSession(data: SessionData): SessionData & { save: () => Promise<void> } {
  return { ...data, save: vi.fn(async () => {}) };
}

beforeEach(() => {
  sessionHolder.current = makeSession({});
});

describe('setStudentMode action', () => {
  it('lets a signed-in parent turn student mode on, persisting the session', async () => {
    const { setStudentMode } = await import('@/actions/toggleStudentMode');
    sessionHolder.current = makeSession({ userId: 1, role: 'parent', email: 'p@example.com' });

    const res = await setStudentMode(true);
    expect(res).toEqual({ ok: true });
    expect(sessionHolder.current.studentMode).toBe(true);
    expect(sessionHolder.current.save).toHaveBeenCalledOnce();
  });

  it('lets a parent turn student mode back off', async () => {
    const { setStudentMode } = await import('@/actions/toggleStudentMode');
    sessionHolder.current = makeSession({
      userId: 1,
      role: 'parent',
      email: 'p@example.com',
      studentMode: true,
    });

    const res = await setStudentMode(false);
    expect(res).toEqual({ ok: true });
    expect(sessionHolder.current.studentMode).toBe(false);
  });

  it('normalises a non-boolean input to a real boolean', async () => {
    const { setStudentMode } = await import('@/actions/toggleStudentMode');
    sessionHolder.current = makeSession({ userId: 1, role: 'parent', email: 'p@example.com' });

    await setStudentMode('yes' as unknown as boolean);
    expect(sessionHolder.current.studentMode).toBe(false);
  });

  it('forbids a student and never mutates the session', async () => {
    const { setStudentMode } = await import('@/actions/toggleStudentMode');
    sessionHolder.current = makeSession({ userId: 2, role: 'student', email: 'e@example.com' });

    const res = await setStudentMode(true);
    expect(res).toEqual({ ok: false, reason: 'forbidden' });
    expect(sessionHolder.current.studentMode).toBeUndefined();
    expect(sessionHolder.current.save).not.toHaveBeenCalled();
  });

  it('forbids an anonymous caller (no userId)', async () => {
    const { setStudentMode } = await import('@/actions/toggleStudentMode');
    sessionHolder.current = makeSession({ role: 'parent' });

    const res = await setStudentMode(true);
    expect(res).toEqual({ ok: false, reason: 'forbidden' });
  });
});
