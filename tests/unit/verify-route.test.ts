import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { ConsumeResult, SessionData } from '@/lib/auth';

// `redirect()` throws in Next so control never falls through; mirror that with a
// tagged error we can assert the target URL on.
class RedirectError extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT:${url}`);
  }
}

const consume = vi.hoisted(() => ({
  current: undefined as ConsumeResult | undefined,
  calls: [] as string[],
}));
const authMode = vi.hoisted(() => ({
  current: 'magic-link' as 'password' | 'magic-link' | 'local-otp',
}));
const sessionHolder = vi.hoisted(() => ({
  current: {} as SessionData & { save: () => Promise<void> },
}));

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new RedirectError(url);
  },
}));

vi.mock('@/lib/auth', () => ({
  consumeMagicToken: (token: string) => {
    consume.calls.push(token);
    return consume.current;
  },
  getRawSession: async () => sessionHolder.current,
  getSession: async () => sessionHolder.current,
}));

vi.mock('@/lib/env', async () => {
  const actual = await vi.importActual<typeof import('@/lib/env')>('@/lib/env');
  return {
    ...actual,
    getAuthMode: () => authMode.current,
  };
});

function makeSession(): SessionData & { save: () => Promise<void> } {
  return { save: vi.fn(async () => {}) };
}

function requestFor(url: string): NextRequest {
  return { nextUrl: new URL(url) } as unknown as NextRequest;
}

async function callGet(url: string): Promise<RedirectError> {
  const { GET } = await import('@/app/signin/verify/route');
  try {
    await GET(requestFor(url));
  } catch (err) {
    if (err instanceof RedirectError) return err;
    throw err;
  }
  throw new Error('GET did not redirect');
}

beforeEach(() => {
  consume.current = undefined;
  consume.calls = [];
  authMode.current = 'magic-link';
  sessionHolder.current = makeSession();
});

describe('GET /signin/verify', () => {
  it('redirects to the error page when no token is supplied', async () => {
    const err = await callGet('http://localhost/signin/verify');
    expect(err.url).toBe('/signin/verify/error?reason=missing');
    expect(sessionHolder.current.save).not.toHaveBeenCalled();
    expect(consume.calls).toEqual([]);
  });

  it('redirects to the error page (with the reason) when the token is invalid', async () => {
    consume.current = { ok: false, reason: 'not-found' };
    const err = await callGet('http://localhost/signin/verify?token=bogus');
    expect(err.url).toBe('/signin/verify/error?reason=not-found');
    expect(sessionHolder.current.save).not.toHaveBeenCalled();
  });

  it('surfaces an expired token reason', async () => {
    consume.current = { ok: false, reason: 'expired' };
    const err = await callGet('http://localhost/signin/verify?token=old');
    expect(err.url).toBe('/signin/verify/error?reason=expired');
  });

  it('establishes the session and redirects home on a valid token', async () => {
    consume.current = {
      ok: true,
      userId: 7,
      role: 'parent',
      email: 'p@example.com',
      isNew: false,
    };
    const err = await callGet('http://localhost/signin/verify?token=good');

    expect(err.url).toBe('/');
    expect(sessionHolder.current.userId).toBe(7);
    expect(sessionHolder.current.role).toBe('parent');
    expect(sessionHolder.current.email).toBe('p@example.com');
    // Always reset on sign-in so a returning parent lands on the dashboard.
    expect(sessionHolder.current.studentMode).toBe(false);
    expect(sessionHolder.current.save).toHaveBeenCalledOnce();
  });

  it('refuses OTP-shaped bearers without calling consume', async () => {
    consume.current = {
      ok: true,
      userId: 1,
      role: 'student',
      email: 'kid@example.com',
      isNew: false,
    };
    const err = await callGet(
      'http://localhost/signin/verify?token=otp%3Akid%40example.com%3Astudent%3A000000',
    );
    expect(err.url).toBe('/signin/verify/error?reason=not-found');
    expect(consume.calls).toEqual([]);
    expect(sessionHolder.current.save).not.toHaveBeenCalled();
  });

  it.each(['password', 'local-otp'] as const)(
    'refuses leftover magic-link tokens when AUTH_MODE is %s',
    async (mode) => {
      authMode.current = mode;
      consume.current = {
        ok: true,
        userId: 7,
        role: 'parent',
        email: 'p@example.com',
        isNew: false,
      };
      const err = await callGet('http://localhost/signin/verify?token=leftover-magic-token');
      expect(err.url).toBe('/signin/verify/error?reason=not-found');
      expect(consume.calls).toEqual([]);
      expect(sessionHolder.current.save).not.toHaveBeenCalled();
    },
  );
});
