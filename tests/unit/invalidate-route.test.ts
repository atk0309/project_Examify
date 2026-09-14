import { describe, expect, it, vi } from 'vitest';

class RedirectError extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT:${url}`);
  }
}

const sessionHolder = vi.hoisted(() => ({
  current: { destroy: vi.fn() },
}));

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new RedirectError(url);
  },
}));

vi.mock('@/lib/auth', () => ({
  getRawSession: async () => sessionHolder.current,
}));

describe('GET /signin/invalidate', () => {
  it('destroys the raw session cookie and redirects to sign-in', async () => {
    sessionHolder.current = { destroy: vi.fn() };
    const { GET } = await import('@/app/signin/invalidate/route');
    await expect(GET()).rejects.toMatchObject({ url: '/signin' });
    expect(sessionHolder.current.destroy).toHaveBeenCalledOnce();
  });
});
